import { loadConfig } from "@gis/config";
import { getRedis } from "./redis.js";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

/**
 * BullMQ queue contracts (Architecture doc §3.4). Producers live in core/api,
 * consumers in apps/worker. Job ids provide dedupe where noted.
 */
export const QUEUE_NAMES = {
  fulfillment: "fulfillment",
  outbox: "outbox",
  email: "email",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface FulfillmentJob {
  webhookEventId: string;
}
export interface OutboxButton {
  text: string;
  url?: string;
  callbackData?: string;
  /** One-tap clipboard copy (Telegram copy_text button). */
  copyText?: string;
  style?: "primary" | "success" | "danger";
  /**
   * Custom (premium) emoji shown as the button's icon — Bot API 9.4
   * `icon_custom_emoji_id`. Button LABELS are plain text and can never contain a
   * custom emoji, so this field is the only way to get one onto a button; the
   * in-bot shop already uses it (sbtn), broadcasts now do too.
   * Telegram renders it only for bots allowed to use custom emoji at all.
   */
  iconCustomEmojiId?: string;
}
export interface OutboxJob {
  telegramId: string;
  text: string;
  photo?: string; // optional image URL → sent as photo with text as caption
  buttons?: OutboxButton[]; // optional inline call-to-action buttons (URL buttons)
  pin?: boolean; // pin the sent message in the chat
  document?: { filename: string; content: string }; // optional .txt attachment; text becomes the caption
}
export interface OutboxOptions {
  photo?: string;
  buttons?: OutboxButton[];
  pin?: boolean;
  /** Send later (ms). Used by the after-sale follow-up. */
  delayMs?: number;
}
export interface EmailJob {
  to: string;
  subject: string;
  html: string;
}

const globalForQueues = globalThis as unknown as {
  __gisQueueConn?: Redis;
  __gisQueues?: Map<QueueName, Queue>;
};

export function getQueueConnection(): Redis {
  if (!globalForQueues.__gisQueueConn) {
    globalForQueues.__gisQueueConn = new Redis(loadConfig().REDIS_URL, {
      maxRetriesPerRequest: null,
    });
  }
  return globalForQueues.__gisQueueConn;
}

export function getQueue(name: QueueName): Queue {
  globalForQueues.__gisQueues ??= new Map();
  let q = globalForQueues.__gisQueues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: getQueueConnection(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 3000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
    globalForQueues.__gisQueues.set(name, q);
  }
  return q;
}

/** Dedupe: one fulfillment job per webhook event. */
export async function enqueueFulfillment(webhookEventId: string): Promise<void> {
  await getQueue(QUEUE_NAMES.fulfillment).add(
    "process",
    { webhookEventId } satisfies FulfillmentJob,
    { jobId: `wh:${webhookEventId}` },
  );
}

/** All outbound Telegram messages flow through this throttled queue (§3.3). */
export async function enqueueTelegramMessage(
  telegramId: bigint | string,
  text: string,
  opts: OutboxOptions = {},
): Promise<void> {
  await getQueue(QUEUE_NAMES.outbox).add("send", {
    telegramId: telegramId.toString(),
    text,
    ...(opts.photo ? { photo: opts.photo } : {}),
    ...(opts.buttons && opts.buttons.length > 0 ? { buttons: opts.buttons } : {}),
    ...(opts.pin ? { pin: true } : {}),
  } satisfies OutboxJob, opts.delayMs && opts.delayMs > 0 ? { delay: Math.min(opts.delayMs, 7 * 24 * 3600_000) } : undefined);
}

/**
 * Bulk enqueue for fan-out (broadcasts, catalogue posts).
 *
 * One pipelined addBulk per chunk instead of one round trip per recipient — a
 * 10k broadcast was ~30-50k serialized Redis commands on the same connection the
 * bot reads sessions from, so every button tap queued behind the blast.
 *
 * `priority` is set LOW (higher number = lower priority in BullMQ) so a marketing
 * send can never delay a paid customer's license key on the shared outbox queue.
 */
export async function enqueueTelegramBulk(
  jobs: Array<{ telegramId: bigint | string; text: string; opts?: OutboxOptions }>,
  chunkSize = 500,
): Promise<number> {
  const q = getQueue(QUEUE_NAMES.outbox);
  let queued = 0;
  for (let i = 0; i < jobs.length; i += chunkSize) {
    const slice = jobs.slice(i, i + chunkSize);
    await q.addBulk(
      slice.map((j) => ({
        name: "send",
        data: {
          telegramId: j.telegramId.toString(),
          text: j.text,
          ...(j.opts?.photo ? { photo: j.opts.photo } : {}),
          ...(j.opts?.buttons && j.opts.buttons.length > 0 ? { buttons: j.opts.buttons } : {}),
          ...(j.opts?.pin ? { pin: true } : {}),
        } satisfies OutboxJob,
        opts: { priority: 10 },
      })),
    );
    queued += slice.length;
  }
  return queued;
}

/** Send a text file (e.g. a large order's keys) as a Telegram document, with a caption. */
export async function enqueueTelegramDocument(
  telegramId: bigint | string,
  filename: string,
  content: string,
  caption: string,
  buttons?: OutboxButton[],
): Promise<void> {
  await getQueue(QUEUE_NAMES.outbox).add("send", {
    telegramId: telegramId.toString(),
    text: caption,
    document: { filename, content },
    ...(buttons && buttons.length > 0 ? { buttons } : {}),
  } satisfies OutboxJob);
}

/** Shown under every delivery: jump to orders, or straight back to the shop. */
export const DELIVERY_BUTTONS: OutboxButton[] = [
  { text: "📦 View my orders", callbackData: "ord:list:1", style: "primary" },
  { text: "🛍 Buy more", callbackData: "shp:home:1", style: "success" },
];

/**
 * Telegram's hard limit on a copy_text button payload (Bot API: 1-256 chars).
 * Exceeding it makes Telegram reject the ENTIRE sendMessage with 400 — so a
 * long delivered value (e.g. a 380-character sign-in link) used to take the
 * whole delivery message down with it and the paid customer received nothing
 * in chat, with the value only reachable through 📦 My Orders.
 */
export const TELEGRAM_COPY_TEXT_MAX = 256;

/** A value can only ride in a copy_text button when Telegram will accept it. */
export function isCopyable(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= TELEGRAM_COPY_TEXT_MAX;
}

/**
 * Delivery buttons with one-tap copy for the credentials that were delivered.
 * Pass the already-repaired values so the clipboard matches what is displayed.
 *
 * Values too long for a copy_text button are simply not given one — the value
 * itself is always in the message body, where it can be tapped to copy.
 */
export function deliveryButtons(creds?: { id?: string; pw?: string; twofa?: string; key?: string }): OutboxButton[] {
  const out: OutboxButton[] = [];
  if (isCopyable(creds?.id)) out.push({ text: "📋 Copy ID", copyText: creds.id });
  if (isCopyable(creds?.pw)) out.push({ text: "📋 Copy password", copyText: creds.pw });
  if (isCopyable(creds?.twofa)) out.push({ text: "📋 Copy 2FA secret", copyText: creds.twofa });
  if (creds?.id && creds.pw) {
    const all = `${creds.id}|${creds.pw}${creds.twofa ? `|${creds.twofa}` : ""}`;
    if (isCopyable(all)) out.push({ text: "📋 Copy ALL credentials", copyText: all });
  } else if (isCopyable(creds?.key)) {
    out.push({ text: "📋 Copy key", copyText: creds.key });
  }
  return [...out, ...DELIVERY_BUTTONS];
}

export async function enqueueEmail(job: EmailJob): Promise<void> {
  await getQueue(QUEUE_NAMES.email).add("send", job);
}

/** Redis set of Telegram IDs currently logged in to the in-bot admin panel. */
export const BOT_ADMIN_MEMBERS_KEY = "botadmin:members";

/**
 * Alert admins (best-effort): the configured ADMIN_ALERT_CHAT_ID plus every
 * admin currently logged in to the in-bot panel, each de-duplicated.
 */
export async function enqueueAdminAlert(text: string, buttons?: OutboxButton[]): Promise<void> {
  const sent = new Set<string>();
  const opts = buttons && buttons.length > 0 ? { buttons } : {};
  const cfg = loadConfig();
  const chatId = cfg.ADMIN_ALERT_CHAT_ID;
  if (chatId) { await enqueueTelegramMessage(chatId, text, opts); sent.add(String(chatId)); }
  // Always reach the configured admin Telegram IDs (works even if they never opened the panel).
  for (const id of (cfg.BOT_ADMIN_IDS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    if (!sent.has(id)) { await enqueueTelegramMessage(id, text, opts); sent.add(id); }
  }
  try {
    const members = await getRedis().smembers(BOT_ADMIN_MEMBERS_KEY);
    for (const m of members) {
      if (m && !sent.has(m)) { await enqueueTelegramMessage(m, text, opts); sent.add(m); }
    }
  } catch {
    // Redis unavailable — the configured channel/ids (if any) still got it.
  }
}
