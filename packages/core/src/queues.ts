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
  url: string;
}
export interface OutboxJob {
  telegramId: string;
  text: string;
  photo?: string; // optional image URL → sent as photo with text as caption
  buttons?: OutboxButton[]; // optional inline call-to-action buttons (URL buttons)
  pin?: boolean; // pin the sent message in the chat
}
export interface OutboxOptions {
  photo?: string;
  buttons?: OutboxButton[];
  pin?: boolean;
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
  } satisfies OutboxJob);
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
export async function enqueueAdminAlert(text: string): Promise<void> {
  const sent = new Set<string>();
  const chatId = loadConfig().ADMIN_ALERT_CHAT_ID;
  if (chatId) { await enqueueTelegramMessage(chatId, text); sent.add(String(chatId)); }
  try {
    const members = await getRedis().smembers(BOT_ADMIN_MEMBERS_KEY);
    for (const m of members) {
      if (m && !sent.has(m)) { await enqueueTelegramMessage(m, text); sent.add(m); }
    }
  } catch {
    // Redis unavailable — the configured channel (if any) still got it.
  }
}
