import { loadConfig } from "@gis/config";
import {
  QUEUE_NAMES,
  getQueueConnection,
  processWebhookEvent,
  type EmailJob,
  type FulfillmentJob,
  type OutboxJob,
  primeFxRate,
  getPromoFlags,
  enqueueTelegramDelete,
} from "@gis/core";
import { ensureDbObjects, prisma } from "@gis/database";
import { Worker } from "bullmq";
import { Api, GrammyError, InputFile } from "grammy";
import { Resend } from "resend";
import { startCronJobs } from "./cron.js";
import { startWebhookServer } from "./webhook-server.js";

/**
 * Background worker (Architecture doc §3.3-3.4):
 * - fulfillment queue → webhook-driven order fulfillment
 * - outbox queue → ALL outbound Telegram messages, token-bucket throttled
 * - email queue → Resend (skipped when not configured)
 * - payment webhook HTTP server (nginx: /webhooks/payments/*)
 * - cron sweeps (reservations, holds, low stock, reconciliation)
 */
async function main(): Promise<void> {
  try { await primeFxRate(); } catch { /* default rate */ }
  try { await getPromoFlags(); } catch { /* defaults to all on */ }
  const config = loadConfig();
  await ensureDbObjects();

  const connection = getQueueConnection();
  const telegram = new Api(config.BOT_TOKEN);
  const resend = config.RESEND_API_KEY ? new Resend(config.RESEND_API_KEY) : null;
  let warnedEmailOff = false;

  const fulfillmentWorker = new Worker<FulfillmentJob>(
    QUEUE_NAMES.fulfillment,
    async (job) => processWebhookEvent(job.data.webhookEventId),
    { connection, concurrency: 10 },
  );

  const outboxWorker = new Worker<OutboxJob>(
    QUEUE_NAMES.outbox,
    async (job) => {
      // A delete job carries no text — do it and stop. Failures here are
      // expected (message older than 48 h, already gone) and must not retry.
      if (job.data.deleteMessageId) {
        await telegram.deleteMessage(job.data.telegramId, job.data.deleteMessageId).catch(() => undefined);
        return;
      }
      let replyMarkup: any;
      try {
        const styled = config.BUTTON_STYLES_ENABLED;
        // Hoisted so the 400 fallback in the catch block can reuse the buttons.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const btns = job.data.buttons && job.data.buttons.length > 0
          ? job.data.buttons
              // Last line of defence: Telegram rejects the WHOLE message when a
              // copy_text payload is over 256 chars (a long delivered link is
              // easily 380). Drop the button, keep the message — the value is
              // in the body anyway. deliveryButtons() already guards this; any
              // other caller is covered here.
              .filter((b) => !b.copyText || b.copyText.length <= 256)
              .map((b) => {
                const base: Record<string, unknown> = b.copyText
                  ? { text: b.text, copy_text: { text: b.copyText } }
                  : b.callbackData
                    ? { text: b.text, callback_data: b.callbackData }
                    : { text: b.text, url: b.url };
                if (styled && b.style && !b.copyText) base.style = b.style;
                // Bot API 9.4 icon_custom_emoji_id: the ONLY way a premium emoji
                // reaches a button, since button labels are plain text.
                if (styled && b.iconCustomEmojiId && !b.copyText) base.icon_custom_emoji_id = b.iconCustomEmojiId;
                return base;
              })
          : undefined;
        // Copy buttons get their own row (long labels); the rest share one row.
        const rows = btns
          ? [
              ...btns.filter((b) => "copy_text" in b).map((b) => [b]),
              ...(btns.some((b) => !("copy_text" in b)) ? [btns.filter((b) => !("copy_text" in b))] : []),
            ]
          : undefined;
        replyMarkup = rows ? ({ inline_keyboard: rows } as unknown as Parameters<typeof telegram.sendMessage>[2] extends { reply_markup?: infer R } ? R : never) : undefined;
        const reply_markup = replyMarkup;
        let msg;
        if (job.data.document) {
          const caption = job.data.text.length > 1024 ? `${job.data.text.slice(0, 1021)}…` : job.data.text;
          const file = new InputFile(Buffer.from(job.data.document.content, "utf8"), job.data.document.filename);
          msg = await telegram.sendDocument(job.data.telegramId, file, { caption, parse_mode: "HTML", reply_markup });
        } else if (job.data.photo) {
          // Caption limit is 1024 chars; trim defensively.
          const caption = job.data.text.length > 1024 ? `${job.data.text.slice(0, 1021)}…` : job.data.text;
          msg = await telegram.sendPhoto(job.data.telegramId, job.data.photo, { caption, parse_mode: "HTML", reply_markup });
        } else {
          msg = await telegram.sendMessage(job.data.telegramId, job.data.text, { parse_mode: "HTML", reply_markup });
        }
        // Scheduled tidy-up: the id only exists here, on the send.
        if (job.data.deleteAfterSec && msg?.message_id) {
          await enqueueTelegramDelete(job.data.telegramId, msg.message_id, job.data.deleteAfterSec * 1000).catch(() => undefined);
        }
        if (job.data.pin && msg?.message_id) {
          // Pinning can fail (e.g. bot lacks rights in groups); never fail the job for it.
          await telegram.pinChatMessage(job.data.telegramId, msg.message_id, { disable_notification: true }).catch(() => undefined);
        }
      } catch (e) {
        if (e instanceof GrammyError && e.error_code === 403) {
          // Bot blocked — stop notifying, don't retry (Bot UX doc §14).
          await prisma.user.updateMany({
            where: { telegramId: BigInt(job.data.telegramId) },
            data: { notifiable: false },
          });
          return;
        }
        if (e instanceof GrammyError && e.error_code === 400) {
          // 400 means Telegram rejected the message itself — unparseable HTML or
          // over 4096 characters. Retrying it unchanged fails identically every
          // time, so the job exhausts its attempts and a customer who has PAID
          // never receives their item, with nothing in the chat to show why.
          // License keys legitimately contain < > and &, which is all it takes.
          //
          // The content matters more than the formatting: resend as plain text,
          // split to fit. Ugly beats undelivered.
          // Sent with NO parse_mode, so Telegram treats every character
          // literally and cannot reject it. Stripping tags first was worse: a
          // key like ABCD-<XY>-Z has <XY> eaten by any tag regex, so the
          // customer would receive a corrupted key, which is worse than a
          // slightly ugly one.
          // FIRST, though, try the one downgrade that keeps the message intact:
          // drop the premium <tg-emoji> wrappers down to their plain glyph.
          // Telegram only lets a bot send custom emoji when its owner has
          // Premium (Bot API 9.4), so a shop whose owner does not gets EVERY
          // announcement rejected — and the plain-text fallback below would
          // then show the raw <tg-emoji …> tags to customers. One retry with
          // the tags unwrapped is the difference between a normal-looking post
          // and either nothing or markup soup.
          const unwrapped = job.data.text.replace(/<tg-emoji[^>]*>([\s\S]*?)<\/tg-emoji>/gi, "$1");
          // The button's icon_custom_emoji_id is the same privilege, so it goes
          // in the same retry — otherwise the message is fixed and the keyboard
          // still fails it.
          const noIconMarkup = replyMarkup
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ? { inline_keyboard: (replyMarkup.inline_keyboard as any[][]).map((row) => row.map(({ icon_custom_emoji_id: _drop, ...b }) => b)) }
            : undefined;
          if (unwrapped !== job.data.text && !job.data.document && !job.data.photo) {
            try {
              await telegram.sendMessage(job.data.telegramId, unwrapped, { parse_mode: "HTML", reply_markup: noIconMarkup as never });
              // eslint-disable-next-line no-console
              console.error("outbox: custom emoji rejected, sent with plain glyphs", { telegramId: job.data.telegramId, error: e.description });
              return;
            } catch {
              // Not the emoji (or the keyboard is at fault too) — carry on below.
            }
          }
          const plain = unwrapped;
          const chunks: string[] = [];
          for (let i = 0; i < plain.length; i += 4000) chunks.push(plain.slice(i, i + 4000));
          // The KEYBOARD is a 400 cause too, not just the text (an over-long
          // copy_text payload, a bad callback_data). Re-sending the same
          // reply_markup reproduced the rejection, the retry "failed too", and
          // the job then died with the customer's item never reaching the chat.
          // So: try once with the buttons, then once WITHOUT them. A delivery
          // with no buttons is still a delivery.
          for (const markup of [replyMarkup, undefined]) {
            try {
              for (let i = 0; i < chunks.length; i++) {
                // Buttons go on the last chunk so they sit under the full message.
                await telegram.sendMessage(job.data.telegramId, chunks[i]!, i === chunks.length - 1 && markup ? ({ reply_markup: markup } as never) : {});
              }
              // eslint-disable-next-line no-console
              console.error("outbox: HTML rejected, delivered as plain text", { telegramId: job.data.telegramId, chunks: chunks.length, buttons: markup ? "kept" : "dropped", error: e.description });
              return;
            } catch {
              // Try the next, more conservative shape; if none works, fall
              // through and let BullMQ retry the original.
            }
          }
        }
        throw e; // 429 & transient errors → BullMQ retries with backoff
      }
    },
    { connection, concurrency: 5, limiter: { max: 25, duration: 1000 } },
  );

  const emailWorker = new Worker<EmailJob>(
    QUEUE_NAMES.email,
    async (job) => {
      if (!resend || !config.EMAIL_FROM) {
        if (!warnedEmailOff) {
          warnedEmailOff = true;
          // eslint-disable-next-line no-console
          console.warn("email disabled (RESEND_API_KEY/EMAIL_FROM not set) — skipping email jobs");
        }
        return;
      }
      await resend.emails.send({
        from: config.EMAIL_FROM,
        to: job.data.to,
        subject: job.data.subject,
        html: job.data.html,
      });
    },
    { connection, concurrency: 5 },
  );

  for (const w of [fulfillmentWorker, outboxWorker, emailWorker]) {
    w.on("failed", (job, err) => {
      // eslint-disable-next-line no-console
      console.error("job failed", { queue: w.name, jobId: job?.id, error: String(err) });
    });
  }

  const server = startWebhookServer(config.PORT);
  const timers = startCronJobs();

  // eslint-disable-next-line no-console
  console.log("worker: queues + webhooks + cron running");

  const shutdown = async (): Promise<void> => {
    for (const t of timers) clearInterval(t);
    server.close();
    await Promise.allSettled([fulfillmentWorker.close(), outboxWorker.close(), emailWorker.close()]);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("fatal", e);
  process.exit(1);
});
