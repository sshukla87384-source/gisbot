import { cancelStalePendingTx } from "./manual-pay.service.js";
import { loadConfig } from "@gis/config";
import { nextOrderNumber, prisma, type Currency } from "@gis/database";
import { couponLines, priceCart } from "./assign.js";
import { confirmManualPayment } from "./manual-pay.service.js";
import { resolveCartCouponTx, recordCouponUseTx, releaseCouponForOrderTx } from "./coupon.service.js";
import { convertMinor, usdtRate } from "../fx.js";

export interface StarsCheckoutResult {
  orderId: string;
  orderNumber: string;
  totalMinor: number;
  currency: Currency;
  stars: number;
}

/** Convert an order total to Telegram Stars using the configured rate. */
function toStars(totalMinor: number, currency: Currency): number {
  const cfg = loadConfig();
  const usd = currency === "USD" ? totalMinor / 100 : totalMinor / 100 / usdtRate("INR");
  return Math.max(1, Math.ceil(usd * cfg.STARS_PER_USD));
}

/** Create a PENDING_PAYMENT order and compute the Stars amount for an invoice. */
export async function createStarsCheckout(userId: string): Promise<StarsCheckoutResult> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const expiresAt = new Date(Date.now() + 60 * 60_000);
  const created = await prisma.$transaction(async (tx) => {
    // Refund any wallet money on the order we are replacing.
      {
        // Closes every other unpaid order (status-guarded, under a row lock),
        // refunding its wallet part and coupon. Paid-but-awaiting-approval ones stay.
        await cancelStalePendingTx(tx, userId);
      }
    const lines = await priceCart(tx, userId, user.currency);
    const subtotalMinor = lines.reduce((sum, l) => sum + l.unitPriceMinor * l.quantity, 0);
    // The cart coupon applies on THIS rail too. It used to be ignored here, so
    // a customer shown a discounted cart was invoiced the undiscounted total.
    const coupon = await resolveCartCouponTx(tx, userId, user.currency, subtotalMinor, couponLines(lines));
    const discountMinor = coupon?.discountMinor ?? 0;
    const totalMinor = Math.max(0, subtotalMinor - discountMinor);
    const orderNumber = await nextOrderNumber(tx);
    const order = await tx.order.create({
      data: { orderNumber, userId, status: "PENDING_PAYMENT", currency: user.currency, subtotalMinor, discountMinor, couponId: coupon?.couponId ?? null, totalMinor, expiresAt },
    });
    if (coupon) await recordCouponUseTx(tx, coupon.couponId, userId, order.id, discountMinor);
    for (const line of lines) {
      const isUnitStocked = line.productType === "LICENSE_KEY" || line.productType === "DIGITAL_ACCOUNT";
      const unitCount = isUnitStocked ? line.quantity : 1;
      for (let i = 0; i < unitCount; i++) {
        await tx.orderItem.create({
          data: {
            orderId: order.id, variantId: line.variantId, productNameSnap: line.productName,
            variantNameSnap: line.variantName, resellerIdSnap: line.resellerId,
            quantity: isUnitStocked ? 1 : line.quantity, unitPriceMinor: line.unitPriceMinor,
            totalMinor: isUnitStocked ? line.unitPriceMinor : line.unitPriceMinor * line.quantity,
            fulfillmentMode: line.fulfillmentMode,
          },
        });
      }
    }
    return { orderId: order.id, orderNumber, totalMinor };
  });
  return { ...created, currency: user.currency, stars: toStars(created.totalMinor, user.currency) };
}

/**
 * Answer Telegram's pre-checkout question for a Stars invoice. It used to say
 * yes to everything, so an invoice opened an hour ago — whose order had since
 * expired or been replaced by a newer checkout — could still be paid, and the
 * Stars were taken for an order we then refused to fulfil.
 */
export async function validateStarsPreCheckout(orderId: string, payerTelegramId: number, totalStars: number, currency: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (currency !== "XTR") return { ok: false, message: "This invoice is not valid any more. Please check out again." };
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { user: { select: { telegramId: true } } } }).catch(() => null);
  if (!order) return { ok: false, message: "This order no longer exists. Please check out again." };
  if (order.user.telegramId === null || order.user.telegramId !== BigInt(payerTelegramId)) {
    return { ok: false, message: "This invoice belongs to another account." };
  }
  if (order.status !== "PENDING_PAYMENT") {
    return { ok: false, message: ["PAID", "COMPLETED", "PENDING_FULFILLMENT", "AWAITING_STOCK"].includes(order.status) ? "This order is already paid." : "This order was cancelled or has expired. Please check out again." };
  }
  // A minute of slack so a payment started just before the deadline still goes through.
  if (order.expiresAt && order.expiresAt.getTime() < Date.now() - 60_000) {
    return { ok: false, message: "This invoice has expired. Please check out again." };
  }
  if (totalStars < toStars(order.totalMinor, order.currency) * 0.9) {
    return { ok: false, message: "The invoice amount does not match your order. Please check out again." };
  }
  return { ok: true };
}

/** Confirm a Stars-paid order → same fulfilment as every other paid order. */
export async function confirmStarsPayment(orderId: string): Promise<{ status: string; delivered: number }> {
  return confirmManualPayment(orderId);
}

/**
 * Stars were taken but the order could not be fulfilled (it expired or was
 * cancelled between pre-checkout and the payment landing). The customer must
 * not lose the money: credit the order value to their wallet, once.
 */
export async function creditFailedStarsPayment(orderId: string, chargeId: string): Promise<{ credited: boolean; amountMinor: number; currency: Currency } | null> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { userId: true, totalMinor: true, currency: true, orderNumber: true, status: true } });
  if (!order) return null;
  // Only an order that is definitely closed. A transient failure leaves it
  // PENDING_PAYMENT — crediting then, and the admin confirming it from the
  // alert, would pay the customer twice. Those are left to the admin.
  if (!["EXPIRED", "CANCELLED"].includes(order.status)) return { credited: false, amountMinor: 0, currency: order.currency };
  const wallet = await prisma.wallet.findUnique({ where: { userId: order.userId }, select: { currency: true } });
  if (!wallet) return null;
  const amountMinor = convertMinor(order.totalMinor, order.currency, wallet.currency);
  if (amountMinor <= 0) return { credited: false, amountMinor: 0, currency: wallet.currency };
  const { adjustWallet } = await import("../wallet/wallet.service.js");
  try {
    await adjustWallet({
      userId: order.userId,
      amountMinor: BigInt(amountMinor),
      type: "REFUND",
      note: `Stars payment for ${order.orderNumber} (order closed) · ${chargeId.slice(0, 40)}`,
      idempotencyKey: `stars-late:${orderId}`,
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return { credited: false, amountMinor, currency: wallet.currency };
    throw e;
  }
  return { credited: true, amountMinor, currency: wallet.currency };
}
