import { prisma, type Currency } from "@gis/database";
import { formatMinor, type CurrencyCode } from "@gis/shared";
import { adjustWallet } from "../wallet/wallet.service.js";
import { convertMinor } from "../fx.js";
import { enqueueTelegramMessage } from "../queues.js";

/**
 * A refund is computed in the ORDER's currency, but `adjustWallet` always moves
 * the WALLET's own. They differ the moment a customer switches currency after
 * buying, and crediting the raw number then paid out 100x. Returns what to
 * credit and the currency to say it in.
 */
async function creditForOrder(userId: string, amountMinor: number, orderCurrency: string): Promise<{ minor: number; currency: string }> {
  const wal = await prisma.wallet.findUnique({ where: { userId }, select: { currency: true } });
  if (!wal || wal.currency === orderCurrency) return { minor: amountMinor, currency: orderCurrency };
  return { minor: convertMinor(amountMinor, orderCurrency as Currency, wal.currency), currency: wal.currency };
}

/**
 * Auto-refund orders stuck in AWAITING_STOCK: an item went out of stock after
 * payment. Credits the value of the undelivered items back to the buyer's
 * wallet (store credit — works for any payment method), marks the order
 * REFUNDED, and notifies the customer. Idempotent per order.
 */
export async function autoRefundStuckStock(olderThanHours = 6, limit = 50): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanHours * 3_600_000);
  const orders = await prisma.order.findMany({
    where: { status: "AWAITING_STOCK", paidAt: { lt: cutoff } },
    include: { items: true, user: { select: { id: true, telegramId: true } } },
    take: limit,
  });
  let refunded = 0;
  for (const o of orders) {
    const undelivered = o.items.filter((i) => i.fulfilledAt === null);
    if (undelivered.length === 0) {
      // Everything actually delivered — nothing to refund; just close it out.
      await prisma.order.update({ where: { id: o.id }, data: { status: "COMPLETED", completedAt: new Date() } }).catch(() => undefined);
      continue;
    }
    // The amount the customer ACTUALLY paid on this order (wallet + gateway),
    // already net of any coupon discount. We never refund more than this.
    const paidMinor = o.walletUsedMinor + o.totalMinor;
    const subtotal = o.subtotalMinor > 0 ? o.subtotalMinor : 1;
    const undeliveredValue = undelivered.reduce((s, i) => s + i.totalMinor, 0);
    const allUndelivered = undelivered.length === o.items.length;
    // Full paid amount if nothing was delivered; otherwise the paid amount
    // scaled to the undelivered portion — capped so it can never exceed paid.
    const refundMinor = paidMinor <= 0 ? 0 : allUndelivered
      ? paidMinor
      : Math.min(paidMinor, Math.round((paidMinor * undeliveredValue) / subtotal));
    try {
      const credit = await creditForOrder(o.user.id, refundMinor, o.currency);
      if (refundMinor > 0) {
        await adjustWallet({
          userId: o.user.id,
          amountMinor: BigInt(credit.minor),
          type: "REFUND",
          note: `Auto-refund — out of stock (order ${o.orderNumber})`,
          idempotencyKey: `refund:stock:${o.id}`,
        });
      }
      await prisma.order.update({
        where: { id: o.id },
        data: { status: allUndelivered ? "REFUNDED" : "PARTIALLY_REFUNDED", cancelledAt: allUndelivered ? new Date() : null },
      });
      if (o.user.telegramId !== null && refundMinor > 0) {
        await enqueueTelegramMessage(
          o.user.telegramId,
          `↩️ <b>Refund issued</b>\nSome items in order <b>${o.orderNumber}</b> went out of stock, so we've credited <b>${formatMinor(credit.minor, credit.currency as CurrencyCode)}</b> back to your wallet. We're sorry for the inconvenience! 🙏`,
        );
      }
      refunded++;
    } catch {
      // Leave the order for the next run.
    }
  }
  return refunded;
}

export interface RefundResult { ok: boolean; reason?: string; refundedMinor?: number; currency?: string }

/** Admin action: refund an order's actually-paid amount to the buyer's wallet. Idempotent per order. */
export async function adminRefundOrder(orderId: string, adminId?: string): Promise<RefundResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { user: { select: { id: true, telegramId: true } } },
  });
  if (!order) return { ok: false, reason: "NOT_FOUND" };
  // PARTIALLY_REFUNDED belongs here too: autoRefundStuckStock already credited
  // part of this order under a DIFFERENT idempotency key, so a full refund on
  // top of it pays out more than the order was ever worth.
  if (["REFUNDED", "PARTIALLY_REFUNDED", "CANCELLED", "EXPIRED"].includes(order.status)) return { ok: false, reason: "ALREADY" };
  // `totalMinor` is what is owed through the gateway/UPI/Binance — it is only
  // money we HOLD once the order was actually paid. Refunding it on a still
  // PENDING_PAYMENT order paid out cash that never arrived; the wallet portion
  // was debited at order creation, so that part is always refundable.
  const paidMinor = order.walletUsedMinor + (order.paidAt !== null ? order.totalMinor : 0);
  const credit = await creditForOrder(order.user.id, paidMinor, order.currency);
  if (paidMinor > 0) {
    await adjustWallet({
      userId: order.user.id,
      amountMinor: BigInt(credit.minor),
      type: "REFUND",
      note: `Refund by admin (order ${order.orderNumber})`,
      actorId: adminId,
      idempotencyKey: `refund:admin:${order.id}`,
    });
  }
  await prisma.order.update({ where: { id: order.id }, data: { status: "REFUNDED", cancelledAt: new Date() } });
  if (order.user.telegramId !== null && paidMinor > 0) {
    await enqueueTelegramMessage(
      order.user.telegramId,
      `↩️ <b>Refund issued</b>\nWe've credited <b>${formatMinor(credit.minor, credit.currency as CurrencyCode)}</b> back to your wallet for order <b>${order.orderNumber}</b>. Thank you for your patience! 🙏`,
    );
  }
  return { ok: true, refundedMinor: credit.minor, currency: credit.currency };
}
