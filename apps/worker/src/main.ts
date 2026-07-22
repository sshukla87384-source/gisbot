import { loadConfig } from "@gis/config";
import {
  QUEUE_NAMES,
  getQueueConnection,
  processWebhookEvent,
  type EmailJob,
  type FulfillmentJob,
  type OutboxJob,
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
      try {
        const styled = config.BUTTON_STYLES_ENABLED;
        const reply_markup = job.data.buttons && job.data.buttons.length > 0
          ? { inline_keyboard: [job.data.buttons.map((b) => (styled && b.style ? { text: b.text, url: b.url, style: b.style } : { text: b.text, url: b.url }))] }
          : undefined;
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
