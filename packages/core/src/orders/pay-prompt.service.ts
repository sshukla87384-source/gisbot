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
const clutterKey = (telegramId: bigint | string | number): string => `chatclutter:${telegramId}`;

/**
 * Messages that are useful before a purchase and only in the way after one:
 * the welcome card, "our team has been notified". They belong to the CHAT, not
 * to one order, so they are tracked per customer and cleared on their next
 * delivery. Capped at 20 so a chatty week cannot grow the list without bound.
 */
export async function rememberChatClutter(telegramId: bigint | string | number, messageId: number): Promise<void> {
  if (!messageId) return;
  try {
    const redis = getRedis();
    const k = clutterKey(telegramId);
    await redis.rpush(k, String(messageId));
    await redis.ltrim(k, -20, -1);
    await redis.expire(k, TTL_SECONDS);
  } catch { /* never break a reply over housekeeping */ }
}

/** Clear the chat clutter for one customer — called when an order is delivered. */
export async function clearChatClutter(telegramId: bigint | string | number | null): Promise<number> {
  if (telegramId === null || telegramId === undefined) return 0;
  try {
    const redis = getRedis();
    const k = clutterKey(telegramId);
    const ids = await redis.lrange(k, 0, -1);
    await redis.del(k);
    let queued = 0;
    for (const raw of ids) {
      const msg = Number(raw);
      if (!Number.isFinite(msg)) continue;
      await enqueueTelegramDelete(String(telegramId), msg);
      queued++;
    }
    return queued;
  } catch {
    return 0;
  }
}

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
