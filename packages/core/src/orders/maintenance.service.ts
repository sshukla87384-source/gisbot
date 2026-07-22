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
    const refundMinor = undelivered.reduce((s, i) => s + i.totalMinor, 0);
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
      await prisma.order.update({ where: { id: o.id }, data: { status: "REFUNDED", cancelledAt: new Date() } });
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
