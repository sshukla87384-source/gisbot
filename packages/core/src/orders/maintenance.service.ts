import { prisma } from "@gis/database";
import { formatMinor, type CurrencyCode } from "@gis/shared";
import { adjustWallet } from "../wallet/wallet.service.js";
import { enqueueTelegramMessage } from "../queues.js";

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
      if (refundMinor > 0) {
        await adjustWallet({
          userId: o.user.id,
          amountMinor: BigInt(refundMinor),
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
          `↩️ <b>Refund issued</b>\nSome items in order <b>${o.orderNumber}</b> went out of stock, so we've credited <b>${formatMinor(refundMinor, o.currency as CurrencyCode)}</b> back to your wallet. We're sorry for the inconvenience! 🙏`,
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
  if (["REFUNDED", "CANCELLED", "EXPIRED"].includes(order.status)) return { ok: false, reason: "ALREADY" };
  const paidMinor = order.walletUsedMinor + order.totalMinor; // exactly what was paid (net of discount)
  if (paidMinor > 0) {
    await adjustWallet({
      userId: order.user.id,
      amountMinor: BigInt(paidMinor),
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
      `↩️ <b>Refund issued</b>\nWe've credited <b>${formatMinor(paidMinor, order.currency as CurrencyCode)}</b> back to your wallet for order <b>${order.orderNumber}</b>. Thank you for your patience! 🙏`,
    );
  }
  return { ok: true, refundedMinor: paidMinor, currency: order.currency };
}
