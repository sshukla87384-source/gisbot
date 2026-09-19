import { nextOrderNumber, prisma, type Currency, type PaymentProvider as PaymentProviderEnum } from "@gis/database";
import { getProvider, type PaymentProviderId } from "@gis/payments";
import { CoreError } from "@gis/shared";
import { loadConfig } from "@gis/config";
import { convertMinor } from "../fx.js";
import { couponLines, priceCart } from "./assign.js";
import { resolveCartCouponTx, recordCouponUseTx, releaseCouponForOrderTx } from "./coupon.service.js";

/**
 * Gateway checkout (PRD §6.1 steps 1-2): creates a PENDING_PAYMENT order with a
 * 15-minute window, soft-reserves unit inventory (RESERVED + TTL — the cron
 * sweep releases expired reservations), and returns the hosted payment URL.
 * Confirmation happens ONLY via verified webhook → fulfillment.service.ts.
 */

const PROVIDER_ENUM: Record<PaymentProviderId, PaymentProviderEnum> = {
  razorpay: "RAZORPAY",
  nowpayments: "NOWPAYMENTS",
};

const PAYMENT_WINDOW_MIN = 15;

export interface GatewayCheckoutResult {
  orderId: string;
  orderNumber: string;
  totalMinor: number;
  currency: Currency;
  url: string;
  expiresAt: Date;
}

export async function createGatewayCheckout(
  userId: string,
  providerId: string,
): Promise<GatewayCheckoutResult> {
  const provider = getProvider(providerId);
  if (!provider) throw new CoreError("VALIDATION_FAILED", "This payment method is not available");

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(provider.currencies as readonly string[]).includes(user.currency)) {
    throw new CoreError("VALIDATION_FAILED", `This payment method does not support ${user.currency}`);
  }

  const expiresAt = new Date(Date.now() + PAYMENT_WINDOW_MIN * 60_000);

  const created = await prisma.$transaction(
    async (tx) => {
      // One live gateway order per user: retrying with another method cancels
      // the previous attempt (its reservations expire via TTL sweep).
      // Refund any wallet money on the order we are replacing.
      {
        const stale = await tx.order.findMany({
          where: { userId, status: "PENDING_PAYMENT", walletUsedMinor: { gt: 0 } },
          select: { id: true, orderNumber: true, walletUsedMinor: true, currency: true },
        });
        for (const so of stale) {
          // SELECT ... FOR UPDATE, not findUnique. This writes an ABSOLUTE
          // balance; without the row lock a concurrent checkout or top-up reads
          // the same figure and one of the two movements is silently lost.
          const swRows = await tx.$queryRaw<Array<{ id: string; balanceMinor: bigint; currency: Currency }>>`
            SELECT "id", "balanceMinor", "currency" FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE`;
          const sw = swRows[0];
          if (!sw) continue;
          // walletUsedMinor is in the ORDER's currency; the wallet has its own.
          // Refunding the raw number returned the wrong amount of money.
          const backMinor = sw.currency === so.currency
            ? so.walletUsedMinor
            : convertMinor(so.walletUsedMinor, so.currency as Currency, sw.currency as Currency);
          // The expiry cron may have refunded this same order already. The unique
          // idempotency key would then throw and abort the customer's new
          // checkout, so check first — the same guard cancelStalePendingTx has.
          const done = await tx.walletTransaction.findUnique({
            where: { idempotencyKey: `refund-cancel:${so.id}` },
            select: { id: true },
          });
          if (!done) {
            const back = sw.balanceMinor + BigInt(backMinor);
            await tx.walletTransaction.create({
              data: {
                walletId: sw.id, type: "REFUND", amountMinor: BigInt(backMinor), balanceAfterMinor: back,
                currency: sw.currency, orderId: so.id, referenceNote: `cancelled ${so.orderNumber}`,
                idempotencyKey: `refund-cancel:${so.id}`,
              },
            });
            await tx.wallet.update({ where: { id: sw.id }, data: { balanceMinor: back } });
          }
          await tx.order.update({ where: { id: so.id }, data: { walletUsedMinor: 0 } });
        }
      }
      // Collect the ids before the sweep: a coupon burned on the attempt we are
      // cancelling has to be given back, and updateMany does not say which rows
      // it touched.
      const cancelling = await tx.order.findMany({
        where: { userId, status: "PENDING_PAYMENT" },
        select: { id: true },
      });
      await tx.order.updateMany({
        where: { userId, status: "PENDING_PAYMENT" },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });
      for (const co of cancelling) await releaseCouponForOrderTx(tx, co.id);

      const lines = await priceCart(tx, userId, user.currency);
      const subtotalMinor = lines.reduce((s, l) => s + l.unitPriceMinor * l.quantity, 0);
      // The cart coupon applies on THIS rail too. It used to be ignored here, so
      // a customer shown a discounted cart was charged the undiscounted total by
      // the gateway.
      const coupon = await resolveCartCouponTx(tx, userId, user.currency, subtotalMinor, couponLines(lines));
      const discountMinor = coupon?.discountMinor ?? 0;
      const totalMinor = Math.max(0, subtotalMinor - discountMinor);

      const orderNumber = await nextOrderNumber(tx);
      const order = await tx.order.create({
        data: {
          orderNumber,
          userId,
          status: "PENDING_PAYMENT",
          currency: user.currency,
          subtotalMinor,
          discountMinor,
          couponId: coupon?.couponId ?? null,
          totalMinor,
          expiresAt,
        },
      });
      if (coupon) await recordCouponUseTx(tx, coupon.couponId, userId, order.id, discountMinor);

      for (const line of lines) {
        const isUnitStocked = line.productType === "LICENSE_KEY" || line.productType === "DIGITAL_ACCOUNT";
        const unitCount = isUnitStocked ? line.quantity : 1;

        for (let i = 0; i < unitCount; i++) {
          await tx.orderItem.create({
            data: {
              orderId: order.id,
              variantId: line.variantId,
              productNameSnap: line.productName,
              variantNameSnap: line.variantName,
              resellerIdSnap: line.resellerId,
              quantity: isUnitStocked ? 1 : line.quantity,
              unitPriceMinor: line.unitPriceMinor,
              totalMinor: isUnitStocked ? line.unitPriceMinor : line.unitPriceMinor * line.quantity,
              fulfillmentMode: line.fulfillmentMode,
            },
          });

          // Soft-reserve one unit so concurrent buyers can't oversell the pool.
          if (isUnitStocked && line.fulfillmentMode === "AUTOMATIC") {
            const table = line.productType === "LICENSE_KEY" ? "LicenseKey" : "DigitalAccount";
            const reserved = await tx.$queryRawUnsafe<Array<{ id: string }>>(
              `SELECT "id" FROM "${table}"
               WHERE "variantId" = $1 AND "status" = 'AVAILABLE' AND "deletedAt" IS NULL
               ORDER BY "createdAt" ASC
               LIMIT 1
               FOR UPDATE SKIP LOCKED`,
              line.variantId,
            );
            const row = reserved[0];
            if (!row) throw new CoreError("OUT_OF_STOCK");
            await tx.$executeRawUnsafe(
              `UPDATE "${table}" SET "status" = 'RESERVED', "reservedUntil" = $1 WHERE "id" = $2`,
              expiresAt,
              row.id,
            );
          }
        }
      }

      await tx.payment.create({
        data: {
          orderId: order.id,
          provider: PROVIDER_ENUM[provider.id],
          status: "CREATED",
          currency: user.currency,
          amountMinor: totalMinor,
          idempotencyKey: `gw:${order.id}`,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: userId,
          actorType: "USER",
          action: "order.checkout.gateway",
          entityType: "Order",
          entityId: order.id,
          after: { orderNumber, totalMinor, currency: user.currency, provider: provider.id },
        },
      });

      return { orderId: order.id, orderNumber, totalMinor };
    },
    { timeout: 15_000 },
  );

  // Create the hosted payment session outside the DB transaction.
  try {
    const session = await provider.createCheckout({
      orderId: created.orderId,
      orderNumber: created.orderNumber,
      amountMinor: created.totalMinor,
      currency: user.currency as "INR" | "USD",
      description: `${loadConfig().STORE_NAME} order ${created.orderNumber}`,
      customerEmail: user.email ?? undefined,
    });
    await prisma.payment.update({
      where: { idempotencyKey: `gw:${created.orderId}` },
      data: { status: "PENDING", providerRef: session.providerRef },
    });
    return { ...created, currency: user.currency, url: session.url, expiresAt };
  } catch (e) {
    // Gateway rejected/unreachable: cancel the order; reservations expire via TTL.
    // The coupon was burned when the order was created a moment ago and this
    // order will never be paid, so give it back in the same transaction.
    // Swallowing a failure here is deliberate: the gateway error below is what
    // the customer needs to hear, and a bookkeeping fault must not replace it.
    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: created.orderId },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });
      await releaseCouponForOrderTx(tx, created.orderId);
    }).catch(() => undefined);
    throw new CoreError("VALIDATION_FAILED", "Payment gateway error — please try again", {
      cause: String(e),
    });
  }
}
