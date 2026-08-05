import { prisma } from "@gis/database";
import type { Currency } from "@gis/database";
import { enqueueTelegramMessage } from "./queues.js";
import { toUsdtCharge } from "./fx.js";

/**
 * Abandoned checkout recovery.
 *
 * Orders sat at PENDING_PAYMENT until cron expired them, and nobody was ever
 * reminded. Most of those people did not change their mind — they got
 * distracted, or lost the payment message in their chat list. One reminder with
 * the exact amount and a way back is the cheapest revenue in the bot.
 *
 * Deliberately ONE reminder, tracked by `Order.nudgedAt`. A second would be
 * nagging, and nagging costs you the customer, not just the sale.
 */

const SETTING = "recovery.nudge";

export interface RecoveryConfig {
  enabled: boolean;
  /** Wait this long after the order was created before reminding. */
  afterMinutes: number;
  /** Never remind an order with less than this long left to pay. */
  minMinutesLeft: number;
}

const DEFAULTS: RecoveryConfig = { enabled: true, afterMinutes: 20, minMinutesLeft: 5 };

export async function getRecoveryConfig(): Promise<RecoveryConfig> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING } }).catch(() => null);
  const v = (row?.value ?? {}) as Partial<RecoveryConfig>;
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULTS.enabled,
    afterMinutes: typeof v.afterMinutes === "number" ? v.afterMinutes : DEFAULTS.afterMinutes,
    minMinutesLeft: typeof v.minMinutesLeft === "number" ? v.minMinutesLeft : DEFAULTS.minMinutesLeft,
  };
}

export async function saveRecoveryConfig(patch: Partial<RecoveryConfig>): Promise<RecoveryConfig> {
  const next = { ...(await getRecoveryConfig()), ...patch };
  await prisma.setting.upsert({
    where: { key: SETTING },
    create: { key: SETTING, value: next as never },
    update: { value: next as never },
  });
  return next;
}

function money(minor: number, currency: string): string {
  const v = (minor / 100).toFixed(2);
  return currency === "INR" ? `₹${v}` : `$${v}`;
}

/** Send the single reminder to anyone who left a payment half-finished. */
export async function runRecoverySweep(limit = 30): Promise<{ sent: number }> {
  const cfg = await getRecoveryConfig();
  if (!cfg.enabled) return { sent: 0 };

  const now = Date.now();
  const orders = await prisma.order.findMany({
    where: {
      status: "PENDING_PAYMENT",
      nudgedAt: null,
      createdAt: { lt: new Date(now - cfg.afterMinutes * 60_000) },
      // Still payable — reminding someone about an order about to die is worse
      // than saying nothing.
      expiresAt: { gt: new Date(now + cfg.minMinutesLeft * 60_000) },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      orderNumber: true,
      totalMinor: true,
      walletUsedMinor: true,
      currency: true,
      expiresAt: true,
      user: { select: { telegramId: true } },
      items: { select: { productNameSnap: true, variantNameSnap: true }, take: 3 },
    },
  });

  let sent = 0;
  for (const o of orders) {
    // Mark first. If the send fails we lose one reminder; if we sent first and
    // the mark failed, we could remind the same person every minute.
    const claimed = await prisma.order.updateMany({
      where: { id: o.id, nudgedAt: null, status: "PENDING_PAYMENT" },
      data: { nudgedAt: new Date() },
    });
    if (claimed.count === 0) continue;
    if (!o.user.telegramId) continue;

    const due = Math.max(0, o.totalMinor - o.walletUsedMinor);
    const minsLeft = o.expiresAt ? Math.max(1, Math.round((o.expiresAt.getTime() - now) / 60_000)) : null;
    const what = o.items.map((i) => i.productNameSnap).filter(Boolean).slice(0, 3).join(", ");

    await enqueueTelegramMessage(
      o.user.telegramId,
      [
        "🛒 <b>Your order is still waiting</b>",
        "",
        `🧾 <b>${o.orderNumber}</b>`,
        ...(what ? [`📦 ${what}`] : []),
        `💰 Amount due: <b>${money(due, o.currency)}</b>${o.currency === "INR" ? ` <i>(${toUsdtCharge(due, o.currency as Currency)} USDT)</i>` : ""}`,
        ...(o.walletUsedMinor > 0 ? [`💳 Already applied from wallet: <b>${money(o.walletUsedMinor, o.currency)}</b>`] : []),
        "",
        ...(minsLeft ? [`⏳ Reserved for about <b>${minsLeft} more minute(s)</b>, then it releases.`] : []),
        "",
        "Tap below to finish — it takes a moment. Stuck on something? We're happy to help. 🙏",
      ].join("\n"),
      {
        buttons: [
          { text: "💳 Complete payment", callbackData: `ord:view:${o.id}`, style: "success" },
          { text: "🎫 I need help", callbackData: "sup:home", style: "primary" },
        ],
      },
    ).catch(() => undefined);
    sent++;
  }
  return { sent };
}
