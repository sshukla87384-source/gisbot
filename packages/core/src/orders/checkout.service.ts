import { loadConfig } from "@gis/config";
import { nextOrderNumber, prisma, type Currency } from "@gis/database";
import { CoreError, encryptSecret, isCoreError } from "@gis/shared";
import { convertMinor } from "../fx.js";
import { logWallet } from "../logs.service.js";
import { notifyOrderToAdmins } from "./manual-pay.service.js";
import { resolveCartCouponTx, recordCouponUseTx } from "./coupon.service.js";
import { grantReferralRewardTx } from "../referral.service.js";
import { accrueCommissionTx } from "./commission.js";
import { assignAccountSlot, assignLicenseKey, deliveryExpiry, priceCart, type PricedLine } from "./assign.js";

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
  allowPwChange?: boolean;
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
async function fulfillLinesTx(tx: Tx2, orderId: string, lines: PricedLine[], masterKey: string, orderCurrency: Currency): Promise<{ deliveries: DeliveredSecret[]; pendingManualItems: number }> {
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

          // Auto-deliver from available stock whenever stock exists — regardless of the
          // coarse fulfillment mode — so any product with keys/accounts is delivered instantly.
          // A MANUAL product with a declared quantity counts down too.
          if (!line.reusableSecret && line.manualStock !== null && line.manualStock !== undefined) {
            const dec = await tx.product.updateMany({
              where: { id: line.productId, manualStock: { gte: 1 } },
              data: { manualStock: { decrement: 1 } },
            });
            if (dec.count === 0) throw new CoreError("OUT_OF_STOCK", `${line.productName} is sold out`);
          }
          let delivered = false;
          // A reusable product (e.g. one shared redemption link) delivers the
          // SAME value to every buyer and never consumes inventory.
          if (line.reusableSecret) {
            // Respect a sellable quantity when the admin set one.
            if (line.reusableStock !== null && line.reusableStock !== undefined) {
              const dec = await tx.product.updateMany({
                where: { id: line.productId, reusableStock: { gte: 1 } },
                data: { reusableStock: { decrement: 1 } },
              });
              if (dec.count === 0) throw new CoreError("OUT_OF_STOCK", `${line.productName} is sold out`);
            }
            // A shared value has no stock row, so its expiry can only come from
            // the variant's validity.
            const expiresAt = deliveryExpiry(null, line.validityHours);
            const payload = { kind: "LICENSE_KEY", key: line.reusableSecret, expiresAt: expiresAt?.toISOString() };
            await tx.orderItem.update({
              where: { id: item.id },
              data: {
                fulfilledAt: new Date(),
                warrantyStartAt: new Date(),
                expiresAt,
                costMinor: line.defaultCostMinor,
                deliveryPayloadEncrypted: encryptSecret(JSON.stringify(payload), masterKey),
              },
            });
            deliveries.push({
              orderItemId: item.id,
              productName: line.productName, variantName: line.variantName,
              kind: "LICENSE_KEY", secret: payload, activationGuide: line.activationGuide, allowPwChange: line.allowPwChange,
            } as unknown as DeliveredSecret);
            continue;
          }
          try {
            if (line.productType === "DIGITAL_ACCOUNT") {
              const creds = await assignAccountSlot(tx, line.variantId, item.id, masterKey);
              const expiresAt = deliveryExpiry(creds.expiresAt, line.validityHours);
              const payload = { kind: "DIGITAL_ACCOUNT", ...creds, expiresAt: expiresAt?.toISOString() };
              await tx.orderItem.update({
                where: { id: item.id },
                data: {
                  fulfilledAt: new Date(),
                  warrantyStartAt: new Date(),
                  expiresAt,
                  costMinor: creds.costMinor ?? line.defaultCostMinor,
                  deliveryPayloadEncrypted: encryptSecret(JSON.stringify(payload), masterKey),
                },
              });
              deliveries.push({ orderItemId: item.id, productName: line.productName, variantName: line.variantName, kind: "DIGITAL_ACCOUNT", secret: { username: creds.username, password: creds.password, expiresAt: expiresAt?.toISOString() }, activationGuide: line.activationGuide, allowPwChange: line.allowPwChange });
              delivered = true;
            } else {
              const { key, expiresAt: stockExpiry, costMinor: cost } = await assignLicenseKey(tx, line.variantId, item.id, masterKey);
              const expiresAt = deliveryExpiry(stockExpiry, line.validityHours);
              const payload = { kind: "LICENSE_KEY", key, expiresAt: expiresAt?.toISOString() };
              await tx.orderItem.update({
                where: { id: item.id },
                data: {
                  fulfilledAt: new Date(),
                  warrantyStartAt: new Date(),
                  expiresAt,
                  costMinor: cost ?? line.defaultCostMinor,
                  deliveryPayloadEncrypted: encryptSecret(JSON.stringify(payload), masterKey),
                },
              });
              deliveries.push({ orderItemId: item.id, productName: line.productName, variantName: line.variantName, kind: "LICENSE_KEY", secret: { key, expiresAt: expiresAt?.toISOString() }, activationGuide: line.activationGuide, allowPwChange: line.allowPwChange });
              delivered = true;
            }
          } catch (e) {
            delivered = false;
            // OUT_OF_STOCK is expected; anything else (encryption, key
            // management, a DB fault) was being silently reported as "sold out",
            // so a master-key problem looked like an empty catalogue with no log
            // line anywhere. Record it — the customer flow is unchanged.
            if (!(isCoreError(e) && e.code === "OUT_OF_STOCK")) {
              // eslint-disable-next-line no-console
              console.error("delivery failed (not stock)", { variantId: line.variantId, error: String(e).slice(0, 300) });
              void logWallet("delivery.error", `Delivery failed for ${line.productName} — NOT a stock problem`, {
                variantId: line.variantId, error: String(e).slice(0, 200),
              });
            }
          }
          // Reseller commission on every rail, not just the gateway.
          if (delivered) await accrueCommissionTx(tx, { id: item.id, resellerIdSnap: item.resellerIdSnap, totalMinor: item.totalMinor }, orderCurrency);
          if (!delivered) {
            // Automatic key/account products with no stock must NOT charge — abort the order.
            if (line.fulfillmentMode !== "MANUAL" && (line.productType === "LICENSE_KEY" || line.productType === "DIGITAL_ACCOUNT")) {
              throw new CoreError("OUT_OF_STOCK", `${line.productName} is out of stock`);
            }
            // Manual / supplier / service items: route to manual (supplier auto-buy runs post-payment).
            pendingManualItems++;
            if (line.fulfillmentMode !== "MANUAL") await tx.orderItem.update({ where: { id: item.id }, data: { fulfillmentMode: "MANUAL" } });
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

      const { deliveries, pendingManualItems } = await fulfillLinesTx(tx, order.id, lines, masterKey, wallet.currency as Currency);

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
  // Fire-and-forget: this calls out to supplier APIs, which must never hold up
  // the customer's checkout response.
  void notifyOrderToAdmins(result.orderId, channel === "API" ? "API / Wallet" : "Wallet").catch(() => undefined);
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

export interface BnplLimitChange extends BnplStatus { previousLimitMinor: number; appliedMinor: number }

/**
 * Admin: move a user's BNPL credit limit up or down by `deltaMinor`.
 *
 * Setting an absolute limit was the only thing an admin could do, which meant
 * topping someone up by 10 required reading their current limit first and
 * doing the arithmetic by hand — and two admins doing that at once would
 * overwrite each other. This reads the row `FOR UPDATE` and applies the delta
 * inside the transaction, so concurrent adjustments add up instead of racing.
 *
 * The result is clamped at zero (a limit cannot go negative) and `appliedMinor`
 * reports what actually moved, which is smaller than the requested deduction
 * when the clamp bites.
 *
 * A limit below what the customer already owes is allowed on purpose: it stops
 * further borrowing without erasing the existing debt. Available credit is
 * already floored at zero, so nothing can be spent past it.
 */
export async function adjustBnplLimit(userId: string, deltaMinor: number): Promise<BnplLimitChange> {
  const delta = Math.round(deltaMinor);
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ bnplLimitMinor: number; bnplOutstandingMinor: number; currency: Currency }>>`
      SELECT "bnplLimitMinor", "bnplOutstandingMinor", "currency" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    const u = rows[0];
    if (!u) throw new CoreError("USER_NOT_FOUND");
    const previousLimitMinor = u.bnplLimitMinor;
    const limitMinor = Math.max(0, previousLimitMinor + delta);
    if (limitMinor !== previousLimitMinor) {
      await tx.user.update({ where: { id: userId }, data: { bnplLimitMinor: limitMinor } });
    }
    return {
      previousLimitMinor,
      appliedMinor: limitMinor - previousLimitMinor,
      limitMinor,
      outstandingMinor: u.bnplOutstandingMinor,
      availableMinor: Math.max(0, limitMinor - u.bnplOutstandingMinor),
      currency: u.currency,
    };
  });
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

      const { deliveries, pendingManualItems } = await fulfillLinesTx(tx, order.id, lines, masterKey, currency as Currency);

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
  void notifyOrderToAdmins(result.orderId, "Pay Later (BNPL)").catch(() => undefined);
  return result;
}

export interface BnplSettlement {
  /** What was actually cleared — smaller than asked when the debt was smaller. */
  settledMinor: number;
  outstandingMinor: number;
  limitMinor: number;
  availableMinor: number;
  currency: Currency;
}

/**
 * Admin: record money the customer paid OUTSIDE the bot against their BNPL debt.
 *
 * Cash, UPI, a bank transfer straight to the operator — the money never touched
 * the wallet, so `repayBnpl` (which debits the wallet) cannot represent it. The
 * only tool an admin had was "Close BNPL + write off", which forgives the WHOLE
 * balance: a customer who owed 49.99 and handed over 30 could either be recorded
 * as still owing everything, or as owing nothing. Both are wrong, and the second
 * quietly loses 19.99.
 *
 * Pass `amountMinor` for a part payment, or null/undefined to clear the lot.
 * Amounts above the outstanding are clamped rather than pushing it negative —
 * a customer must never end up with the shop owing THEM through this route.
 *
 * The row is locked FOR UPDATE, so two admins recording payments at the same
 * moment cannot both read 49.99 and each subtract from it.
 */
export async function settleBnplManual(
  userId: string,
  amountMinor?: number | null,
  actorId?: string | null,
): Promise<BnplSettlement> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ bnplOutstandingMinor: number; bnplLimitMinor: number; currency: Currency }>>`
      SELECT "bnplOutstandingMinor", "bnplLimitMinor", "currency" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    const u = rows[0];
    if (!u) throw new CoreError("USER_NOT_FOUND");

    const want = amountMinor === null || amountMinor === undefined ? u.bnplOutstandingMinor : Math.round(amountMinor);
    if (want <= 0) throw new CoreError("VALIDATION_FAILED", "Amount must be greater than zero");
    const settledMinor = Math.min(want, u.bnplOutstandingMinor);
    const outstandingMinor = u.bnplOutstandingMinor - settledMinor;

    if (settledMinor > 0) {
      await tx.user.update({ where: { id: userId }, data: { bnplOutstandingMinor: outstandingMinor } });
      // Money that arrived off-ledger leaves no other trace, so the audit row is
      // the only record that this debt was reduced, by whom, and by how much.
      await tx.auditLog.create({
        data: {
          actorId: actorId ?? null,
          actorType: "ADMIN",
          action: "bnpl.settle.manual",
          entityType: "User",
          entityId: userId,
          before: { outstandingMinor: u.bnplOutstandingMinor },
          after: { settledMinor, outstandingMinor, currency: u.currency },
        },
      });
    }

    return {
      settledMinor,
      outstandingMinor,
      limitMinor: u.bnplLimitMinor,
      availableMinor: Math.max(0, u.bnplLimitMinor - outstandingMinor),
      currency: u.currency,
    };
  });
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
    const wrows = await tx.$queryRaw<Array<{ id: string; balanceMinor: bigint; currency: Currency }>>`
      SELECT "id", "balanceMinor", "currency" FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE`;
    const w = wrows[0];
    if (!w) throw new CoreError("WALLET_NOT_FOUND");
    const want = amountMinor && amountMinor > 0 ? Math.min(amountMinor, outstanding) : outstanding;
    // BNPL is denominated in the USER's currency, the wallet in ITS own —
    // subtracting one from the other cleared Rs 5 of debt for a $5 debit.
    const balInUserCur = w.currency === u.currency
      ? Number(w.balanceMinor)
      : convertMinor(Number(w.balanceMinor), w.currency as Currency, u.currency as Currency);
    const pay = Math.min(want, balInUserCur);
    const debit = w.currency === u.currency ? pay : convertMinor(pay, u.currency as Currency, w.currency as Currency);
    if (pay <= 0) throw new CoreError("INSUFFICIENT_BALANCE");
    // `debit` is in the WALLET's currency; `pay` is in the user's. Subtracting
    // `pay` from a wallet balance was the same cross-currency bug the comment
    // above says was fixed — it turned a Rs 500 repayment into a $500 debit.
    const newBal = w.balanceMinor - BigInt(debit);
    if (newBal < 0n) throw new CoreError("INSUFFICIENT_BALANCE");
    await tx.walletTransaction.create({
      data: {
        walletId: w.id,
        type: "PURCHASE",
        amountMinor: -BigInt(debit),
        balanceAfterMinor: newBal,
        currency: w.currency,
        referenceNote: "BNPL repayment",
        idempotencyKey: `bnpl-repay:${userId}:${Date.now()}`,
      },
    });
    await tx.wallet.update({ where: { id: w.id }, data: { balanceMinor: newBal } });
    await tx.user.update({ where: { id: userId }, data: { bnplOutstandingMinor: { decrement: pay } } });
    return { repaidMinor: pay, outstandingMinor: outstanding - pay, currency: u.currency };
  });
}
