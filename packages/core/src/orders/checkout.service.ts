import { loadConfig } from "@gis/config";
import { nextOrderNumber, prisma, type Currency } from "@gis/database";
import { CoreError, encryptSecret } from "@gis/shared";
import { notifyManualOrder } from "./manual-pay.service.js";
import { resolveCartCouponTx, recordCouponUseTx } from "./coupon.service.js";
import { grantReferralRewardTx } from "../referral.service.js";
import { assignAccountSlot, assignLicenseKey, priceCart, type PricedLine } from "./assign.js";

/**
 * Wallet-funded checkout with automatic fulfillment (PRD §6.1, Security doc §5).
 *
 * Everything runs in ONE database transaction:
 *   wallet row lock → live price recheck → order + items → inventory assignment
 *   via FOR UPDATE SKIP LOCKED → ledger debit → audit log.
 * Duplicate delivery is impossible: LicenseKey.orderItemId is UNIQUE.
 * Gateway checkouts (Razorpay UPI / NOWPayments crypto) share the same
 * assignment primitives — see gateway-checkout.service.ts + fulfillment.service.ts.
 */

export interface DeliveredSecret {
  orderItemId: string;
  productName: string;
  variantName: string;
  kind: "LICENSE_KEY" | "DIGITAL_ACCOUNT";
  /** Plaintext, for immediate dispatch only. Never persist or log. */
  secret: { key?: string; username?: string; password?: string; expiresAt?: string };
  activationGuide: string | null;
}

export interface CheckoutResult {
  orderId: string;
  orderNumber: string;
  totalMinor: number;
  currency: Currency;
  status: "COMPLETED" | "PENDING_FULFILLMENT";
  deliveries: DeliveredSecret[];
  pendingManualItems: number;
}

type Tx2 = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** Shared: create order items for priced lines, assign inventory, return deliveries. */
async function fulfillLinesTx(tx: Tx2, orderId: string, lines: PricedLine[], masterKey: string): Promise<{ deliveries: DeliveredSecret[]; pendingManualItems: number }> {
      // 4) Items — inventory-backed quantities expand to unit items so the
      //    1:1 unique inventory↔item constraint can do its job.
      const deliveries: DeliveredSecret[] = [];
      let pendingManualItems = 0;

      for (const line of lines) {
        const isUnitStocked = line.productType === "LICENSE_KEY" || line.productType === "DIGITAL_ACCOUNT";
        const unitCount = isUnitStocked ? line.quantity : 1;

        for (let i = 0; i < unitCount; i++) {
          const item = await tx.orderItem.create({
            data: {
              orderId,
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

          if (line.fulfillmentMode === "MANUAL") {
            pendingManualItems++;
            continue;
          }

          if (line.productType === "LICENSE_KEY") {
            const { key, expiresAt } = await assignLicenseKey(tx, line.variantId, item.id, masterKey);
            const payload = { kind: "LICENSE_KEY", key, expiresAt: expiresAt?.toISOString() };
            await tx.orderItem.update({
              where: { id: item.id },
              data: {
                fulfilledAt: new Date(),
                deliveryPayloadEncrypted: encryptSecret(JSON.stringify(payload), masterKey),
              },
            });
            deliveries.push({
              orderItemId: item.id,
              productName: line.productName,
              variantName: line.variantName,
              kind: "LICENSE_KEY",
              secret: { key, expiresAt: expiresAt?.toISOString() },
              activationGuide: line.activationGuide,
            });
          } else if (line.productType === "DIGITAL_ACCOUNT") {
            const creds = await assignAccountSlot(tx, line.variantId, item.id, masterKey);
            const payload = { kind: "DIGITAL_ACCOUNT", ...creds, expiresAt: creds.expiresAt?.toISOString() };
            await tx.orderItem.update({
              where: { id: item.id },
              data: {
                fulfilledAt: new Date(),
                deliveryPayloadEncrypted: encryptSecret(JSON.stringify(payload), masterKey),
              },
            });
            deliveries.push({
              orderItemId: item.id,
              productName: line.productName,
              variantName: line.variantName,
              kind: "DIGITAL_ACCOUNT",
              secret: {
                username: creds.username,
                password: creds.password,
                expiresAt: creds.expiresAt?.toISOString(),
              },
              activationGuide: line.activationGuide,
            });
          } else {
            // DOWNLOAD / SUBSCRIPTION / MANUAL_SERVICE automatic flows arrive
            // with their delivery mechanisms in later phases; route to manual
            // fulfillment rather than failing the paid order.
            pendingManualItems++;
            await tx.orderItem.update({ where: { id: item.id }, data: { fulfillmentMode: "MANUAL" } });
          }
        }
      }


  return { deliveries, pendingManualItems };
}

export async function checkoutWithWallet(userId: string, channel: "DIRECT" | "API" = "DIRECT"): Promise<CheckoutResult> {
  const masterKey = loadConfig().ENCRYPTION_MASTER_KEY;

  const result = await prisma.$transaction(
    async (tx): Promise<CheckoutResult> => {
      // 1) Lock wallet (serializes concurrent checkouts per user).
      const wallets = await tx.$queryRaw<Array<{ id: string; balanceMinor: bigint; currency: Currency }>>`
        SELECT "id", "balanceMinor", "currency" FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE`;
      const wallet = wallets[0];
      if (!wallet) throw new CoreError("WALLET_NOT_FOUND");

      // 2) Re-price cart from live rows in the wallet currency.
      const lines = await priceCart(tx, userId, wallet.currency, channel);
      const subtotalMinor = lines.reduce((s, l) => s + l.unitPriceMinor * l.quantity, 0);
      const coupon = await resolveCartCouponTx(tx, userId, wallet.currency, subtotalMinor);
      const discountMinor = coupon?.discountMinor ?? 0;
      const totalMinor = Math.max(0, subtotalMinor - discountMinor);
      if (wallet.balanceMinor < BigInt(totalMinor)) throw new CoreError("INSUFFICIENT_BALANCE");

      // 3) Create order.
      const orderNumber = await nextOrderNumber(tx);
      const order = await tx.order.create({
        data: {
          orderNumber,
          userId,
          status: "PAID",
          currency: wallet.currency,
          subtotalMinor,
          discountMinor,
          couponId: coupon?.couponId ?? null,
          walletUsedMinor: totalMinor,
          totalMinor: 0, // nothing owed via gateway
          paidAt: new Date(),
        },
      });
      if (coupon) await recordCouponUseTx(tx, coupon.couponId, userId, order.id, discountMinor);

      const { deliveries, pendingManualItems } = await fulfillLinesTx(tx, order.id, lines, masterKey);

      // 5) Wallet debit (append-only ledger + cached balance).
      const newBalance = wallet.balanceMinor - BigInt(totalMinor);
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: "PURCHASE",
          amountMinor: -BigInt(totalMinor),
          balanceAfterMinor: newBalance,
          currency: wallet.currency,
          orderId: order.id,
          referenceNote: orderNumber,
          idempotencyKey: `purchase:${order.id}`,
        },
      });
      await tx.wallet.update({ where: { id: wallet.id }, data: { balanceMinor: newBalance } });

      // 6) Invoice row (PDF rendering lands with the notifications phase).
      await tx.invoice.create({
        data: { orderId: order.id, invoiceNumber: orderNumber.replace(/^GIS/, "INV") },
      });

      // 7) Finalize order status, first-purchase marker, cart cleanup, audit.
      const finalStatus = pendingManualItems > 0 ? "PENDING_FULFILLMENT" : "COMPLETED";
      await tx.order.update({
        where: { id: order.id },
        data: { status: finalStatus, ...(finalStatus === "COMPLETED" ? { completedAt: new Date() } : {}) },
      });
      const buyer = await tx.user.findUnique({ where: { id: userId }, select: { firstPurchaseAt: true, referredById: true } });
      await grantReferralRewardTx(tx, {
        referrerId: buyer?.referredById ?? null,
        referredId: userId,
        orderId: order.id,
        netMinor: subtotalMinor - discountMinor,
        currency: wallet.currency as "INR" | "USD",
        isFirst: (buyer?.firstPurchaseAt ?? null) === null,
      });
      await tx.user.updateMany({
        where: { id: userId, firstPurchaseAt: null },
        data: { firstPurchaseAt: new Date() },
      });
      const cart = await tx.cart.findUnique({ where: { userId } });
      if (cart) await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

      await tx.auditLog.create({
        data: {
          actorId: userId,
          actorType: "USER",
          action: "order.checkout.wallet",
          entityType: "Order",
          entityId: order.id,
          after: { orderNumber, totalMinor, currency: wallet.currency, items: lines.length },
        },
      });

      return {
        orderId: order.id,
        orderNumber,
        totalMinor,
        currency: wallet.currency,
        status: finalStatus,
        deliveries,
        pendingManualItems,
      };
    },
    { timeout: 15_000 },
  );
  if (result.pendingManualItems > 0) await notifyManualOrder(result.orderId);
  return result;
}

// ───────────── Buy Now, Pay Later (BNPL) ─────────────

export interface BnplStatus { limitMinor: number; outstandingMinor: number; availableMinor: number; currency: Currency }

export async function getBnplStatus(userId: string): Promise<BnplStatus> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { bnplLimitMinor: true, bnplOutstandingMinor: true, currency: true } });
  return {
    limitMinor: u.bnplLimitMinor,
    outstandingMinor: u.bnplOutstandingMinor,
    availableMinor: Math.max(0, u.bnplLimitMinor - u.bnplOutstandingMinor),
    currency: u.currency,
  };
}

/** Admin: set a user's BNPL credit limit (minor units, user currency). */
export async function setBnplLimit(userId: string, limitMinor: number): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { bnplLimitMinor: Math.max(0, Math.round(limitMinor)) } });
}

/** Checkout on BNPL credit: deliver now, add to the user's outstanding balance. */
export async function checkoutWithBnpl(userId: string, channel: "DIRECT" | "API" = "DIRECT"): Promise<CheckoutResult> {
  const masterKey = loadConfig().ENCRYPTION_MASTER_KEY;
  const result = await prisma.$transaction(
    async (tx): Promise<CheckoutResult> => {
      const rows = await tx.$queryRaw<Array<{ id: string; currency: Currency; bnplLimitMinor: number; bnplOutstandingMinor: number; firstPurchaseAt: Date | null; referredById: string | null }>>`
        SELECT "id", "currency", "bnplLimitMinor", "bnplOutstandingMinor", "firstPurchaseAt", "referredById" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      const u = rows[0];
      if (!u) throw new CoreError("USER_NOT_FOUND");
      const currency = u.currency;

      const lines = await priceCart(tx, userId, currency, channel);
      const subtotalMinor = lines.reduce((s, l) => s + l.unitPriceMinor * l.quantity, 0);
      const coupon = await resolveCartCouponTx(tx, userId, currency, subtotalMinor);
      const discountMinor = coupon?.discountMinor ?? 0;
      const totalMinor = Math.max(0, subtotalMinor - discountMinor);
      const available = Math.max(0, u.bnplLimitMinor - u.bnplOutstandingMinor);
      if (available < totalMinor) throw new CoreError("INSUFFICIENT_BALANCE", "BNPL credit limit exceeded");

      const orderNumber = await nextOrderNumber(tx);
      const order = await tx.order.create({
        data: {
          orderNumber, userId, status: "PAID", currency,
          subtotalMinor, discountMinor, couponId: coupon?.couponId ?? null,
          walletUsedMinor: 0, bnplMinor: totalMinor, totalMinor: 0, paidAt: new Date(),
        },
      });
      if (coupon) await recordCouponUseTx(tx, coupon.couponId, userId, order.id, discountMinor);

      const { deliveries, pendingManualItems } = await fulfillLinesTx(tx, order.id, lines, masterKey);

      await tx.user.update({ where: { id: userId }, data: { bnplOutstandingMinor: { increment: totalMinor } } });
      await tx.invoice.create({ data: { orderId: order.id, invoiceNumber: orderNumber.replace(/^GIS/, "INV") } });

      const finalStatus = pendingManualItems > 0 ? "PENDING_FULFILLMENT" : "COMPLETED";
      await tx.order.update({ where: { id: order.id }, data: { status: finalStatus, ...(finalStatus === "COMPLETED" ? { completedAt: new Date() } : {}) } });
      await grantReferralRewardTx(tx, {
        referrerId: u.referredById,
        referredId: userId,
        orderId: order.id,
        netMinor: subtotalMinor - discountMinor,
        currency: currency as "INR" | "USD",
        isFirst: u.firstPurchaseAt === null,
      });
      await tx.user.updateMany({ where: { id: userId, firstPurchaseAt: null }, data: { firstPurchaseAt: new Date() } });
      const cart = await tx.cart.findUnique({ where: { userId } });
      if (cart) await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      await tx.auditLog.create({ data: { actorId: userId, actorType: "USER", action: "order.checkout.bnpl", entityType: "Order", entityId: order.id, after: { orderNumber, totalMinor, currency } } });

      return { orderId: order.id, orderNumber, totalMinor, currency, status: finalStatus, deliveries, pendingManualItems };
    },
    { timeout: 15_000 },
  );
  if (result.pendingManualItems > 0) await notifyManualOrder(result.orderId);
  return result;
}

export interface BnplRepay { repaidMinor: number; outstandingMinor: number; currency: Currency }

/** Repay BNPL debt from wallet balance (all outstanding, or a specific amount). */
export async function repayBnpl(userId: string, amountMinor?: number): Promise<BnplRepay> {
  return prisma.$transaction(async (tx) => {
    const urows = await tx.$queryRaw<Array<{ currency: Currency; bnplOutstandingMinor: number }>>`
      SELECT "currency", "bnplOutstandingMinor" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    const u = urows[0];
    if (!u) throw new CoreError("USER_NOT_FOUND");
    const outstanding = u.bnplOutstandingMinor;
    if (outstanding <= 0) return { repaidMinor: 0, outstandingMinor: 0, currency: u.currency };
    const wrows = await tx.$queryRaw<Array<{ id: string; balanceMinor: bigint }>>`
      SELECT "id", "balanceMinor" FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE`;
    const w = wrows[0];
    if (!w) throw new CoreError("WALLET_NOT_FOUND");
    const want = amountMinor && amountMinor > 0 ? Math.min(amountMinor, outstanding) : outstanding;
    const pay = Math.min(want, Number(w.balanceMinor));
    if (pay <= 0) throw new CoreError("INSUFFICIENT_BALANCE");
    const newBal = w.balanceMinor - BigInt(pay);
    await tx.walletTransaction.create({
      data: { walletId: w.id, type: "PURCHASE", amountMinor: -BigInt(pay), balanceAfterMinor: newBal, currency: u.currency, referenceNote: "BNPL repayment" },
    });
    await tx.wallet.update({ where: { id: w.id }, data: { balanceMinor: newBal } });
    await tx.user.update({ where: { id: userId }, data: { bnplOutstandingMinor: { decrement: pay } } });
    return { repaidMinor: pay, outstandingMinor: outstanding - pay, currency: u.currency };
  });
}
