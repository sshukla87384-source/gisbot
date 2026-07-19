import { loadConfig } from "@gis/config";
import { nextOrderNumber, prisma, type Currency } from "@gis/database";
import { priceCart } from "./assign.js";
import { confirmManualPayment } from "./manual-pay.service.js";

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
  const usd = currency === "USD" ? totalMinor / 100 : totalMinor / 100 / cfg.BINANCE_USDT_INR_RATE;
  return Math.max(1, Math.ceil(usd * cfg.STARS_PER_USD));
}

/** Create a PENDING_PAYMENT order and compute the Stars amount for an invoice. */
export async function createStarsCheckout(userId: string): Promise<StarsCheckoutResult> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const expiresAt = new Date(Date.now() + 60 * 60_000);
  const created = await prisma.$transaction(async (tx) => {
    await tx.order.updateMany({
      where: { userId, status: "PENDING_PAYMENT" },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
    const lines = await priceCart(tx, userId, user.currency);
    const totalMinor = lines.reduce((sum, l) => sum + l.unitPriceMinor * l.quantity, 0);
    const orderNumber = await nextOrderNumber(tx);
    const order = await tx.order.create({
      data: { orderNumber, userId, status: "PENDING_PAYMENT", currency: user.currency, subtotalMinor: totalMinor, totalMinor, expiresAt },
    });
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

/** Confirm a Stars-paid order → same fulfilment as every other paid order. */
export async function confirmStarsPayment(orderId: string): Promise<{ status: string; delivered: number }> {
  return confirmManualPayment(orderId);
}
