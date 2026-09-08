import { getRedis } from "../redis.js";
import { enqueueTelegramDelete } from "../queues.js";

/**
 * Payment instruction cards ("send 0.60 USDT to this Pay ID", the UPI QR) are
 * useful for exactly as long as the order is unpaid. Once it is delivered — or
 * rejected, cancelled or expired — they are stale instructions sitting in the
 * customer's chat above their keys, and customers do pay against them twice.
 *
 * The bot records each card it sends for an order; whatever finishes the order
 * clears them. That "whatever" is usually a webhook, a cron sweep or the admin
 * panel, none of which has a grammY context — hence Redis for the ids and the
 * outbox for the deletions.
 *
 * TTL is 48 h because that is Telegram's own limit for a bot deleting its own
 * message: keeping the ids longer would only queue calls that cannot succeed.
 */
const TTL_SECONDS = 48 * 3600;

const key = (orderId: string): string => `ordmsg:${orderId}`;

/** Remember a payment prompt the bot just sent, so it can be cleaned up later. */
export async function rememberPaymentPrompt(
  orderId: string,
  telegramId: bigint | string | number,
  messageId: number,
): Promise<void> {
  if (!orderId || !messageId) return;
  try {
    const redis = getRedis();
    await redis.rpush(key(orderId), `${telegramId}:${messageId}`);
    await redis.expire(key(orderId), TTL_SECONDS);
  } catch {
    // Losing a prompt id must never break a checkout — worst case the card stays.
  }
}

/**
 * Delete every payment prompt recorded for an order. Safe to call more than
 * once and for orders that never had one.
 */
export async function clearPaymentPrompts(orderId: string): Promise<number> {
  if (!orderId) return 0;
  try {
    const redis = getRedis();
    const rows = await redis.lrange(key(orderId), 0, -1);
    await redis.del(key(orderId));
    let queued = 0;
    for (const row of rows) {
      const sep = row.lastIndexOf(":");
      const chat = row.slice(0, sep);
      const msg = Number(row.slice(sep + 1));
      if (!chat || !Number.isFinite(msg)) continue;
      await enqueueTelegramDelete(chat, msg);
      queued++;
    }
    return queued;
  } catch {
    return 0;
  }
}
