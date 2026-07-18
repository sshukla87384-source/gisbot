import { nextOrderNumber, prisma, type Currency, type PaymentProvider as PaymentProviderEnum } from "@gis/database";
import { getProvider, type PaymentProviderId } from "@gis/payments";
import { CoreError } from "@gis/shared";
import { loadConfig } from "@gis/config";
import { priceCart } from "./assign.js";

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
      await tx.order.updateMany({
        where: { userId, status: "PENDING_PAYMENT" },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });

      const lines = await priceCart(tx, userId, user.currency);
      const totalMinor = lines.reduce((s, l) => s + l.unitPriceMinor * l.quantity, 0);

      const orderNumber = await nextOrderNumber(tx);
      const order = await tx.order.create({
        data: {
          orderNumber,
          userId,
          status: "PENDING_PAYMENT",
          currency: user.currency,
          subtotalMinor: totalMinor,
          totalMinor,
          expiresAt,
        },
      });

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
    await prisma.order.update({
      where: { id: created.orderId },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
    throw new CoreError("VALIDATION_FAILED", "Payment gateway error — please try again", {
      cause: String(e),
    });
  }
}
