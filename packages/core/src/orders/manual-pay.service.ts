import { loadConfig } from "@gis/config";
import { nextOrderNumber, prisma, type Currency } from "@gis/database";
import { CoreError, cb, encryptSecret, decryptSecret, formatMinor, type CurrencyCode, isCoreError } from "@gis/shared";
import { enqueueAdminAlert, enqueueTelegramMessage, enqueueTelegramDocument , DELIVERY_BUTTONS, deliveryButtons} from "../queues.js";
import { logError, logWallet } from "../logs.service.js";
import { scheduleFollowup } from "../followup.service.js";
import { repairAccountPair } from "./assign.js";
import { notifyTierChange } from "../loyalty.service.js";
import { accrueCommission, accrueCommissionTx } from "./commission.js";
import type { DeliveryPayload } from "./assign.js";
import { assignAccountSlot, assignLicenseKey, buildDeliveryText, buildCombinedDeliveryText, buildDeliveryTxt, credsOf, DELIVERY_FILE_THRESHOLD, priceCart, thankYouMessage, type DeliveryLine } from "./assign.js";
import { resolveCartCouponTx, recordCouponUseTx } from "./coupon.service.js";
import { referralNudgeMessage, shouldSendReferralNudge } from "../users/user.service.js";
import { deliveryInstructionsMessage } from "../admin.service.js";
import { grantReferralRewardTx } from "../referral.service.js";
import { toUsdtCharge, usdtToMinor, usdtCentInMinor, convertMinor } from "../fx.js";

/**
 * Manual Binance Pay (P2P via UID). Binance UID transfers have no automatic
 * confirmation webhook, so: the bot creates a PENDING_PAYMENT order and shows
 * the UID + amount; the admin verifies the transfer in Binance and confirms it
 * in the panel, which runs the same fulfilment as an automatic gateway.
 */

export interface BinanceCheckoutResult {
  orderId: string;
  orderNumber: string;
  totalMinor: number;
  currency: Currency;
  binanceUid: string;
  binanceAsset: string; // always "USDT"
  binanceAmount: string; // exact USDT amount to send (unique for auto-matching)
  /** Wallet balance already applied; `totalMinor` is what is still owed. */
  walletUsedMinor: number;
  /** Full order value before the wallet was applied. */
  orderTotalMinor: number;
}

/**
 * Convert an order total (minor units, INR/USD) to a clean USDT amount the
 * customer pays exactly. Confirmation is by the Binance transaction ID the
 * customer submits (or admin verification), so no unique tail is needed.
 */
function toUsdtAmount(totalMinor: number, currency: Currency): string {
  return toUsdtCharge(totalMinor, currency);
}

export interface UpiCheckoutResult {
  orderId: string;
  orderNumber: string;
  totalMinor: number;
  currency: Currency;
  upiId: string;
  payeeName: string | null;
  /** Wallet balance already applied; `totalMinor` is what is still owed. */
  walletUsedMinor: number;
  /** Full order value before the wallet was applied. */
  orderTotalMinor: number;
}


type TxM = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Cancel any stale PENDING_PAYMENT orders, REFUNDING wallet money already
 * applied to them. Never silently keep a customer's balance for a dead order.
 */
async function cancelStalePendingTx(tx: TxM, userId: string): Promise<void> {
  const stale = await tx.order.findMany({
    where: { userId, status: "PENDING_PAYMENT" },
    select: { id: true, orderNumber: true, walletUsedMinor: true, currency: true },
  });
  for (const o of stale) {
    if (o.walletUsedMinor && o.walletUsedMinor > 0) {
      // Locked read: this writes an absolute balance (see applyWalletTx).
      const locked = await tx.$queryRaw<Array<{ id: string; balanceMinor: bigint; currency: Currency }>>`
        SELECT "id", "balanceMinor", "currency" FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE`;
      const w = locked[0];
      if (w) {
        // walletUsedMinor is in the ORDER's currency; the wallet has its own.
        // Refunding the raw number returned the wrong amount of money.
        const backMinor = w.currency === o.currency
          ? o.walletUsedMinor
          : convertMinor(o.walletUsedMinor, o.currency as Currency, w.currency as Currency);
        // The expiry cron may have refunded this same order already. The unique
        // key would throw and abort the customer's new checkout, so check first.
        const done = await tx.walletTransaction.findUnique({
          where: { idempotencyKey: `refund-cancel:${o.id}` },
          select: { id: true },
        });
        if (!done) {
          const back = w.balanceMinor + BigInt(backMinor);
          await tx.walletTransaction.create({
            data: {
              walletId: w.id, type: "REFUND", amountMinor: BigInt(backMinor),
              balanceAfterMinor: back, currency: w.currency, orderId: o.id,
              referenceNote: `cancelled ${o.orderNumber}`, idempotencyKey: `refund-cancel:${o.id}`,
            },
          });
          await tx.wallet.update({ where: { id: w.id }, data: { balanceMinor: back } });
        }
      }
    }
    await tx.order.update({ where: { id: o.id }, data: { status: "CANCELLED", cancelledAt: new Date(), walletUsedMinor: 0 } });
  }
}

/**
 * Spend the customer's wallet balance on this order first and return what is
 * still owed via the payment method. A $3 order with $1 in the wallet leaves $2
 * to pay by UPI/Binance.
 */
async function applyWalletTx(
  tx: TxM,
  userId: string,
  orderId: string,
  orderNumber: string,
  totalMinor: number,
  opts: { alignToUsdtCent?: Currency; orderCurrency?: Currency } = {},
): Promise<{ walletUsed: number; owed: number }> {
  // SELECT ... FOR UPDATE, not findUnique. This writes an ABSOLUTE balance, so
  // without the row lock two concurrent checkouts both read the same balance and
  // both write it away — spending the same money twice. checkoutWithWallet and
  // adjustWallet already lock; this path did not.
  const locked = await tx.$queryRaw<Array<{ id: string; balanceMinor: bigint; currency: Currency }>>`
    SELECT "id", "balanceMinor", "currency" FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE`;
  const w = locked[0];
  if (!w || w.balanceMinor <= 0n) return { walletUsed: 0, owed: totalMinor };
  // The wallet and the order can be in DIFFERENT currencies (wallets are USD,
  // an INR customer's cart is INR). Compare in the ORDER's currency, then debit
  // the wallet in its own. Mixing them debited $2 against a Rs 500 order.
  const orderCur = opts.orderCurrency ?? (w.currency as Currency);
  const balanceInOrderCur = w.currency === orderCur
    ? Number(w.balanceMinor)
    : convertMinor(Number(w.balanceMinor), w.currency as Currency, orderCur);
  let use = Math.min(balanceInOrderCur, totalMinor); // in ORDER currency
  if (use <= 0) return { walletUsed: 0, owed: totalMinor };
  // The remainder will be quoted in USDT, which has only 2 decimals. Let the
  // wallet swallow the sub-cent part so the gateway amount is exact — e.g. a
  // ₹159.20 order with ₹50 in the wallet takes ₹50.20 and quotes exactly 1.09.
  if (opts.alignToUsdtCent) {
    const step = usdtCentInMinor(opts.alignToUsdtCent);
    const remainder = (totalMinor - use) % step;
    if (remainder > 0) {
      // Compare in the ORDER's currency — balanceInOrderCur, not the raw wallet
      // balance, which is a different scale entirely.
      if (balanceInOrderCur >= use + remainder) {
        // Spend a touch more from the wallet: ₹159.20 with ₹200 → wallet ₹159.20.
        use += remainder;
      } else if (use >= step - remainder) {
        // Wallet is maxed out, so debit slightly LESS and let the gateway cover a
        // whole cent: ₹159.20 with ₹50 → wallet ₹49.20 + exactly 1.10 USDT.
        use -= step - remainder;
      } else {
        // Dust balance (smaller than one USDT cent) — it cannot make the gateway
        // amount exact, so leave it in the wallet instead of spending it for
        // nothing. The order is then billed wholly via the gateway.
        use = 0;
      }
    }
  }
  if (use <= 0) return { walletUsed: 0, owed: totalMinor };
  // Debit amount expressed in the WALLET's currency.
  const debitWalletCur = w.currency === orderCur ? use : convertMinor(use, orderCur, w.currency as Currency);
  const debit = Math.min(debitWalletCur, Number(w.balanceMinor));
  const after = w.balanceMinor - BigInt(debit);
  await tx.walletTransaction.create({
    data: {
      walletId: w.id, type: "PURCHASE", amountMinor: -BigInt(debit), balanceAfterMinor: after,
      currency: w.currency, orderId, referenceNote: `part-payment ${orderNumber}`,
      idempotencyKey: `partial:${orderId}`,
    },
  });
  await tx.wallet.update({ where: { id: w.id }, data: { balanceMinor: after } });
  await tx.order.update({ where: { id: orderId }, data: { walletUsedMinor: use, totalMinor: totalMinor - use } });
  return { walletUsed: use, owed: totalMinor - use };
}

/**
 * Manual UPI checkout (INR). Customer pays to the configured UPI ID and submits
 * a reference; the admin confirms in the panel/bot (same fulfilment path).
 */
export async function createUpiManualCheckout(userId: string, opts: { useWallet?: boolean } = {}): Promise<UpiCheckoutResult> {
  const cfg = loadConfig();
  const upiId = cfg.UPI_ID;
  if (!upiId) throw new CoreError("VALIDATION_FAILED", "UPI is not configured");

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const expiresAt = new Date(Date.now() + 60 * 60_000);
  const created = await prisma.$transaction(async (tx) => {
    await cancelStalePendingTx(tx, userId);
    const lines = await priceCart(tx, userId, user.currency);
    const subtotalMinor = lines.reduce((sum, l) => sum + l.unitPriceMinor * l.quantity, 0);
    const coupon = await resolveCartCouponTx(tx, userId, user.currency, subtotalMinor);
    const discountMinor = coupon?.discountMinor ?? 0;
    const totalMinor = Math.max(0, subtotalMinor - discountMinor);
    const orderNumber = await nextOrderNumber(tx);
    const order = await tx.order.create({
      data: { orderNumber, userId, status: "PENDING_PAYMENT", currency: user.currency, subtotalMinor, discountMinor, couponId: coupon?.couponId ?? null, totalMinor, expiresAt },
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
    if (coupon) await recordCouponUseTx(tx, coupon.couponId, userId, order.id, discountMinor);
    // Spend wallet balance first when asked; only the remainder is paid by UPI.
    const applied = opts.useWallet
      ? await applyWalletTx(tx, userId, order.id, orderNumber, totalMinor, { orderCurrency: user.currency })
      : { walletUsed: 0, owed: totalMinor };
    return { orderId: order.id, orderNumber, totalMinor: applied.owed, walletUsedMinor: applied.walletUsed, orderTotalMinor: totalMinor };
  });
  await enqueueAdminAlert(
    `🇮🇳 New UPI order ${created.orderNumber} — ${formatMinor(created.totalMinor, user.currency as CurrencyCode)}. Verify payment to ${upiId}, then confirm in the panel.`,
  );
  return { ...created, currency: user.currency, upiId, payeeName: cfg.UPI_PAYEE_NAME ?? null };
}

export async function createBinanceManualCheckout(userId: string, opts: { useWallet?: boolean } = {}): Promise<BinanceCheckoutResult> {
  const cfg = loadConfig();
  const uid = cfg.BINANCE_PAY_UID;
  if (!uid) throw new CoreError("VALIDATION_FAILED", "Binance Pay is not configured");

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const expiresAt = new Date(Date.now() + 60 * 60_000); // 60-min window for manual pay

  const created = await prisma.$transaction(async (tx) => {
    await cancelStalePendingTx(tx, userId);
    const lines = await priceCart(tx, userId, user.currency);
    const subtotalMinor = lines.reduce((s, l) => s + l.unitPriceMinor * l.quantity, 0);
    const coupon = await resolveCartCouponTx(tx, userId, user.currency, subtotalMinor);
    const discountMinor = coupon?.discountMinor ?? 0;
    const totalMinor = Math.max(0, subtotalMinor - discountMinor);
    const usdt = toUsdtAmount(totalMinor, user.currency);
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
        binanceAsset: "USDT",
        binanceAmount: usdt,
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
      }
    }
    await tx.auditLog.create({
      data: {
        actorId: userId,
        actorType: "USER",
        action: "order.checkout.binance_manual",
        entityType: "Order",
        entityId: order.id,
        after: { orderNumber, totalMinor, currency: user.currency },
      },
    });
    if (coupon) await recordCouponUseTx(tx, coupon.couponId, userId, order.id, discountMinor);
    // Wallet first when asked; the USDT amount must reflect only what is owed.
    const applied = opts.useWallet
      ? await applyWalletTx(tx, userId, order.id, orderNumber, totalMinor, { alignToUsdtCent: user.currency, orderCurrency: user.currency })
      : { walletUsed: 0, owed: totalMinor };
    const owedUsdt = applied.walletUsed > 0 ? toUsdtAmount(applied.owed, user.currency) : usdt;
    // The 2dp USDT quote is what the customer actually sends and what the
    // verifier compares against, so record that exact value as the amount owed.
    const owedRecorded = usdtToMinor(owedUsdt, user.currency);
    await tx.order.update({
      where: { id: order.id },
      data: { binanceAmount: owedUsdt, totalMinor: owedRecorded },
    });
    return {
      orderId: order.id, orderNumber, totalMinor: owedRecorded, binanceAmount: owedUsdt,
      walletUsedMinor: applied.walletUsed, orderTotalMinor: totalMinor,
    };
  });

  await enqueueAdminAlert(
    `🟡 New Binance order ${created.orderNumber} — ${formatMinor(created.totalMinor, user.currency as CurrencyCode)} (= ${created.binanceAmount} USDT). Auto-confirms when payment arrives; otherwise verify UID ${uid} and confirm in the panel.`,
  );
  return { ...created, currency: user.currency, binanceUid: uid, binanceAsset: "USDT" };
}

/**
 * Admin confirms a manual payment (Binance/other) → assign inventory + deliver.
 * Reuses the same assignment primitives as automatic fulfilment. Idempotent.
 */
export async function confirmManualPayment(orderId: string, actorId?: string): Promise<{ status: string; delivered: number }> {
  const masterKey = loadConfig().ENCRYPTION_MASTER_KEY;

  const outcome = await prisma.$transaction(
    async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { user: true, items: { include: { variant: { include: { product: true } } } } },
      });
      if (!order) throw new CoreError("ORDER_NOT_FOUND");
      // A cancelled or expired order must never be fulfilled — its wallet portion
      // may already have been refunded, so delivering would ship goods for free.
      if (["CANCELLED", "EXPIRED"].includes(order.status)) {
        throw new CoreError("ORDER_NOT_FOUND", "That order was cancelled or expired — it cannot be confirmed.");
      }
      if (["PAID", "COMPLETED", "PENDING_FULFILLMENT", "AWAITING_STOCK", "REFUNDED"].includes(order.status)) {
        return { kind: "skip" as const };
      }

      await tx.order.update({ where: { id: order.id }, data: { status: "PAID", paidAt: new Date() } });

      const deliveries: DeliveryLine[] = [];
      let pendingManual = 0;
      let awaitingStock = 0;

      for (const item of order.items) {
        if (item.fulfilledAt) continue;
        const type = item.variant.product.type;
        const guide = item.variant.product.activationGuide;
        if (item.fulfillmentMode === "MANUAL" || (type !== "LICENSE_KEY" && type !== "DIGITAL_ACCOUNT")) {
          pendingManual++;
          continue;
        }
        try {
          if (type === "LICENSE_KEY") {
            const { key, expiresAt, costMinor: cost } = await assignLicenseKey(tx, item.variantId, item.id, masterKey, true);
            const payload = { kind: "LICENSE_KEY", key, expiresAt: expiresAt?.toISOString() };
            await tx.orderItem.update({
              where: { id: item.id },
              data: {
                fulfilledAt: new Date(),
                warrantyStartAt: new Date(),
                costMinor: cost ?? item.variant.defaultCostMinor,
                deliveryPayloadEncrypted: encryptSecret(JSON.stringify(payload), masterKey),
              },
            });
            if (order.user.telegramId !== null) deliveries.push({ productName: item.productNameSnap, variantName: item.variantNameSnap, payload, activationGuide: guide, allowPwChange: item.variant.product.allowPasswordChange });
          } else {
            const creds = await assignAccountSlot(tx, item.variantId, item.id, masterKey, true);
            const payload = { kind: "DIGITAL_ACCOUNT", username: creds.username, password: creds.password, expiresAt: creds.expiresAt?.toISOString() };
            await tx.orderItem.update({
              where: { id: item.id },
              data: {
                fulfilledAt: new Date(),
                warrantyStartAt: new Date(),
                costMinor: creds.costMinor ?? item.variant.defaultCostMinor,
                deliveryPayloadEncrypted: encryptSecret(JSON.stringify(payload), masterKey),
              },
            });
            if (order.user.telegramId !== null) deliveries.push({ productName: item.productNameSnap, variantName: item.variantNameSnap, payload, activationGuide: guide, allowPwChange: item.variant.product.allowPasswordChange });
          }
          // Reseller commission on the UPI / Binance rail too.
          await accrueCommissionTx(tx, item, order.currency);
        } catch (e) {
          awaitingStock++;
          // Only OUT_OF_STOCK is expected here. Everything else was being
          // reported to the admin as "temporarily out of stock", so a systemic
          // failure looked like empty shelves.
          if (!(isCoreError(e) && e.code === "OUT_OF_STOCK")) {
            // eslint-disable-next-line no-console
            console.error("fulfilment failed (not stock)", { orderItemId: item.id, error: String(e).slice(0, 300) });
            void logWallet("fulfil.error", `Fulfilment failed for ${item.productNameSnap} — NOT a stock problem`, {
              orderItemId: item.id, error: String(e).slice(0, 200),
            });
          }
        }
      }

      await tx.invoice.upsert({
        where: { orderId: order.id },
        create: { orderId: order.id, invoiceNumber: order.orderNumber.replace(/^GIS/, "INV") },
        update: {},
      });
      await grantReferralRewardTx(tx, {
        referrerId: order.user.referredById,
        referredId: order.userId,
        orderId: order.id,
        netMinor: order.subtotalMinor - order.discountMinor,
        currency: order.currency as "INR" | "USD",
        isFirst: order.user.firstPurchaseAt === null,
      });
      await tx.user.updateMany({ where: { id: order.userId, firstPurchaseAt: null }, data: { firstPurchaseAt: new Date() } });
      const cart = await tx.cart.findUnique({ where: { userId: order.userId } });
      if (cart) await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

      const finalStatus = awaitingStock > 0 ? "AWAITING_STOCK" : pendingManual > 0 ? "PENDING_FULFILLMENT" : "COMPLETED";
      await tx.order.update({ where: { id: order.id }, data: { status: finalStatus, ...(finalStatus === "COMPLETED" ? { completedAt: new Date() } : {}) } });
      await tx.auditLog.create({ data: { actorId, actorType: "ADMIN", action: "order.confirm.manual", entityType: "Order", entityId: order.id, after: { finalStatus, delivered: deliveries.length } } });

      return { kind: "done" as const, orderId: order.id, userId: order.userId, telegramId: order.user.telegramId, buyerHandle: order.user.telegramHandle, buyerFirst: order.user.firstName, buyerReferral: order.user.referralCode, orderNumber: order.orderNumber, totalMinor: order.totalMinor, currency: order.currency, deliveries, finalStatus, pendingManual, awaitingStock };
    },
    { timeout: 20_000 },
  );

  if (outcome.kind === "skip") return { status: "already_processed", delivered: 0 };

  if (outcome.telegramId !== null) {
    await enqueueTelegramMessage(outcome.telegramId, `🎉 <b>Payment confirmed!</b> ✅\nOrder <b>${outcome.orderNumber}</b> — ${formatMinor(outcome.totalMinor, outcome.currency as CurrencyCode)}. Delivering now… 🚀`);
    const celeb = loadConfig().CELEBRATION_EMOJI;
    if (celeb) await enqueueTelegramMessage(outcome.telegramId, celeb);
    if (outcome.deliveries.length === 1) {
      const d = outcome.deliveries[0]!;
      await enqueueTelegramMessage(outcome.telegramId, buildDeliveryText(d.productName, d.variantName, d.payload, d.activationGuide, d.allowPwChange), { buttons: deliveryButtons(credsOf(d.payload)) });
    } else if (outcome.deliveries.length > DELIVERY_FILE_THRESHOLD) {
      await enqueueTelegramDocument(outcome.telegramId, `order-${outcome.orderNumber}.txt`, buildDeliveryTxt(outcome.deliveries, outcome.orderNumber), `🎉 Your order is delivered! ${outcome.deliveries.length} items are in the attached file. 💾 Saved in 🔑 My Licenses.`, DELIVERY_BUTTONS);
    } else if (outcome.deliveries.length > 1) {
      await enqueueTelegramMessage(outcome.telegramId, buildCombinedDeliveryText(outcome.deliveries, outcome.orderNumber), { buttons: DELIVERY_BUTTONS });
    }
    if (outcome.deliveries.length > 0) {
      await enqueueTelegramMessage(outcome.telegramId, thankYouMessage({ telegramHandle: outcome.buyerHandle, firstName: outcome.buyerFirst }, loadConfig().STORE_NAME));
      // First delivery of the day only — see shouldSendReferralNudge.
      if (await shouldSendReferralNudge(outcome.userId)) {
        const nudge = referralNudgeMessage(outcome.buyerReferral, loadConfig().BOT_USERNAME);
        if (nudge) await enqueueTelegramMessage(outcome.telegramId, nudge);
      }
      const instr = await deliveryInstructionsMessage();
      if (instr) await enqueueTelegramMessage(outcome.telegramId, instr);
    }
    if (outcome.pendingManual > 0) await enqueueTelegramMessage(outcome.telegramId, `⏳ <b>${outcome.pendingManual} item(s) being prepared</b>\nThey arrive in this chat automatically — usually within a minute. Nothing more to do.`);
    if (outcome.awaitingStock > 0) await enqueueTelegramMessage(outcome.telegramId, `⚠️ ${outcome.awaitingStock} item(s) are temporarily out of stock; our team will sort it out.`);
  }
  await notifyOrderToAdmins(outcome.orderId, "Payment confirmed");
  return { status: outcome.finalStatus, delivered: outcome.deliveries.length };
}

// ───────────── Manual-delivery: admin notify + fulfill ─────────────

/** Notify bot admins that an order has manual items awaiting hand-delivery, with a Deliver button. */
export async function notifyManualOrder(orderId: string): Promise<void> {
  // Auto-buy + deliver any supplier-linked items first (dynamic import avoids a circular dependency).
  try {
    const { autoFulfillSupplierItems } = await import("../supplier.service.js");
    await autoFulfillSupplierItems(orderId);
  } catch { /* supplier auto-fulfil is best-effort */ }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { user: { select: { telegramHandle: true, firstName: true, telegramId: true } }, items: { include: { variant: { include: { product: { select: { supplierId: true } } } } } } },
  });
  if (!order) return;
  // Only alert for items that still need a HUMAN (manual, not fulfilled, not supplier-auto).
  const pending = order.items.filter((i) => i.fulfillmentMode === "MANUAL" && i.fulfilledAt === null && !i.variant.product.supplierId);
  if (pending.length === 0) return;
  const buyer = order.user.telegramHandle ? `@${order.user.telegramHandle}` : (order.user.firstName ?? String(order.user.telegramId));
  const lines = [
    "📦 <b>New manual-delivery order!</b>",
    `🧾 Order <b>${order.orderNumber}</b>`,
    `👤 Buyer: ${buyer}`,
    `🆔 ID: <code>${order.user.telegramId ?? "—"}</code>`,
    "",
    ...pending.map((i) => `• ${i.productNameSnap}${i.variantNameSnap.trim().toLowerCase() === "standard" ? "" : ` · ${i.variantNameSnap}`}`),
    "",
    "Tap Deliver to send the key/details now.",
  ];
  await enqueueAdminAlert(lines.join("\n"), [{ text: "📦 Deliver now", callbackData: cb("adm", "deliver", orderId), style: "primary" }]);
}

export interface PendingManualItem { id: string; productName: string; variantName: string; }

/** List the still-unfulfilled manual items of an order (for the admin deliver view). */
export async function listPendingManualItems(orderId: string): Promise<{ orderNumber: string; items: PendingManualItem[] }> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
  if (!order) return { orderNumber: "?", items: [] };
  const items = order.items
    .filter((i) => i.fulfillmentMode === "MANUAL" && i.fulfilledAt === null)
    .map((i) => ({ id: i.id, productName: i.productNameSnap, variantName: i.variantNameSnap }));
  return { orderNumber: order.orderNumber, items };
}

export interface ManualFulfillResult { ok: boolean; reason?: string; orderNumber?: string; remaining?: number; completed?: boolean; }

/** Admin hand-delivers one manual item: store the secret, mark fulfilled, deliver to the customer with a thank-you + instructions. */
export async function manualFulfillItem(orderItemId: string, secretText: string): Promise<ManualFulfillResult> {
  const masterKey = loadConfig().ENCRYPTION_MASTER_KEY;
  const item = await prisma.orderItem.findUnique({
    where: { id: orderItemId },
    include: { order: { include: { user: { select: { telegramId: true, telegramHandle: true, firstName: true, referralCode: true } } } }, variant: { include: { product: true } } },
  });
  if (!item) return { ok: false, reason: "NOT_FOUND" };
  if (item.fulfilledAt) return { ok: false, reason: "ALREADY_DELIVERED", orderNumber: item.order.orderNumber };

  const clean = secretText.trim();
  if (!clean) return { ok: false, reason: "EMPTY" };
  const payload = { kind: "LICENSE_KEY", key: clean };
  // Conditional claim on fulfilledAt: two admins tapping Deliver at the same
  // moment both passed the earlier check and both messaged the customer, who
  // then held two different secrets while the vault showed only one.
  const claimed = await prisma.orderItem.updateMany({
    where: { id: item.id, fulfilledAt: null },
    data: {
      fulfilledAt: new Date(),
      warrantyStartAt: item.warrantyStartAt ?? new Date(),
      costMinor: item.variant.defaultCostMinor,
      deliveryPayloadEncrypted: encryptSecret(JSON.stringify(payload), masterKey),
    },
  });
  if (claimed.count === 0) return { ok: false, reason: "ALREADY_DELIVERED" };
  // A manually-delivered reseller item earns commission as well; the old code
  // skipped MANUAL items entirely.
  await accrueCommission(item.id).catch(() => undefined);

  // Recompute remaining manual items on the order.
  const remainingItems = await prisma.orderItem.count({ where: { orderId: item.orderId, fulfillmentMode: "MANUAL", fulfilledAt: null } });
  const allDone = (await prisma.orderItem.count({ where: { orderId: item.orderId, fulfilledAt: null } })) === 0;
  if (allDone) await prisma.order.update({ where: { id: item.orderId }, data: { status: "COMPLETED", completedAt: new Date() } });

  const tgId = item.order.user.telegramId;
  if (tgId !== null) {
    await enqueueTelegramMessage(tgId, buildDeliveryText(item.productNameSnap, item.variantNameSnap, payload, item.variant.product.activationGuide, item.variant.product.allowPasswordChange), { buttons: deliveryButtons(credsOf(payload)) });
    // Deliver the item and nothing else. The thank-you, referral nudge and
    // delivery instructions are ORDER-level and were already sent at payment —
    // re-sending them here is what produced the duplicated messages.
  }
  return { ok: true, orderNumber: item.order.orderNumber, remaining: remainingItems, completed: allDone };
}

export interface ReplaceResult {
  ok: boolean;
  reason?: string;
  /** Everything a caller needs to describe the outcome — in chat, in a ticket, anywhere. */
  detail?: ReplacementDetail;
}

export interface ReplacementDetail {
  originalOrderNumber: string;
  replacementOrderNumber: string | null;
  productName: string;
  variantName: string;
  /** Original value, preserved. Shown struck through. */
  oldText: string | null;
  /** Last 4 characters of the original, for identifying a unit among many. */
  oldTail: string | null;
  newText: string;
  newTail: string;
  warrantyCovered: boolean;
  at: Date;
  originalOrderId: string;
  replacementOrderId: string | null;
  originalItemId: string;
  replacementItemId: string | null;
}

/** First line of a payload, for display and for the "…1111" unit tail. */
export function payloadLabel(p: { kind?: string; key?: string; username?: string }): string {
  if (p.key) return p.key.split(/\r?\n/)[0] ?? "";
  return p.username ?? "";
}

export function tailOf(text: string | null | undefined, n = 4): string | null {
  if (!text) return null;
  const t = text.trim();
  return t.length <= n ? t : t.slice(-n);
}

/**
 * Admin action: replace a delivered AUTOMATIC unit with a fresh one from stock.
 *
 * The important property, and the one the previous version got wrong: the
 * ORIGINAL delivered value is never overwritten. It used to be replaced in place,
 * so the customer permanently lost sight of what they had been given and could
 * not tell which of five identical keys had been swapped. Now:
 *
 *   original OrderItem  — keeps its payload, gains replacedAt + replacedByItemId
 *   replacement OrderItem — on its own order, holds the NEW key, replaces → original
 *
 * so the mapping is a real relation in both directions and history is intact.
 * All of it in ONE transaction: a crash cannot leave a retired key with no
 * replacement, or a replacement with no link back.
 */
export async function adminReplaceOrderItem(
  orderItemId: string,
  opts: { warrantyCovered?: boolean; approvedBy?: string; ticketId?: string; reason?: string } = {},
): Promise<ReplaceResult> {
  const masterKey = loadConfig().ENCRYPTION_MASTER_KEY;
  const item = await prisma.orderItem.findUnique({
    where: { id: orderItemId },
    include: { order: { include: { user: { select: { telegramId: true } } } }, variant: { include: { product: true } } },
  });
  if (!item) return { ok: false, reason: "NOT_FOUND" };
  if (item.replacedAt) return { ok: false, reason: "ALREADY_REPLACED" };
  const type = item.variant.product.type;
  if (type !== "LICENSE_KEY" && type !== "DIGITAL_ACCOUNT") return { ok: false, reason: "NOT_AUTOMATIC" };

  // Decrypt what was delivered, so the message can show old vs new. Kept, not moved.
  let oldPayload: { kind?: string; key?: string; username?: string; password?: string; twofa?: string } | null = null;
  if (item.deliveryPayloadEncrypted) {
    try { oldPayload = JSON.parse(decryptSecret(item.deliveryPayloadEncrypted, masterKey)); } catch { oldPayload = null; }
  }

  try {
    // The warranty window continues from the FIRST delivery — a replacement does
    // not hand out a fresh one. 5-day warranty replaced on day 4 leaves 1 day.
    const warrantyStart = item.warrantyStartAt ?? item.fulfilledAt ?? new Date();
    const now = new Date();

    const out = await prisma.$transaction(async (tx) => {
      // 0) CLAIM THE UNIT FIRST, conditionally. The check above runs outside the
      //    transaction, and @unique on replacedByItemId cannot save us because two
      //    concurrent calls mint DIFFERENT cuids — so both would succeed, burn two
      //    keys for one claim and orphan the first replacement. Telegram redelivers
      //    webhooks on timeout, so this is reachable, not theoretical.
      const claimed = await tx.orderItem.updateMany({
        where: { id: item.id, replacedAt: null },
        data: { replacedAt: now },
      });
      if (claimed.count === 0) throw new CoreError("VALIDATION_FAILED", "ALREADY_REPLACED");

      // 1) The replacement's own order + unit, created after the claim so the new
      //    stock can be bound to it rather than to the faulty unit.
      const repNumber = await nextOrderNumber(tx);
      const repOrder = await tx.order.create({
        data: {
          orderNumber: repNumber,
          userId: item.order.userId,
          status: "COMPLETED",
          currency: item.order.currency,
          subtotalMinor: 0,
          discountMinor: 0,
          totalMinor: 0,
          walletUsedMinor: 0,
          paidAt: now,
          completedAt: now,
          replacementOfOrderId: item.orderId,
        },
      });
      const repItem = await tx.orderItem.create({
        data: {
          orderId: repOrder.id,
          variantId: item.variantId,
          productNameSnap: item.productNameSnap,
          variantNameSnap: item.variantNameSnap,
          quantity: 1,
          unitPriceMinor: 0,
          totalMinor: 0,
          fulfillmentMode: item.fulfillmentMode,
          fulfilledAt: now,
          warrantyStartAt: warrantyStart,
          replacedByItemId: null,
        },
      });

      // 2) Retire the faulty unit and assign a fresh one TO THE REPLACEMENT ITEM.
      let payload: Record<string, unknown>;
      let replacementCostMinor: number | null = null;
      if (type === "LICENSE_KEY") {
        const bad = await tx.licenseKey.findMany({ where: { orderItemId: item.id }, select: { id: true } });
        // Detach and permanently retire it. The original payload above keeps the
        // value for history, so nothing is lost by unbinding the stock row.
        await tx.licenseKey.updateMany({ where: { orderItemId: item.id }, data: { orderItemId: null, status: "DISABLED" } });
        const { key, expiresAt, costMinor } = await assignLicenseKey(tx, item.variantId, repItem.id, masterKey, false, bad.map((b) => b.id));
        replacementCostMinor = costMinor;
        payload = { kind: "LICENSE_KEY", key, expiresAt: expiresAt?.toISOString() };
      } else {
        const olds = await tx.accountAssignment.findMany({ where: { orderItemId: item.id } });
        const badAccountIds: string[] = [];
        for (const a of olds) {
          badAccountIds.push(a.accountId);
          await tx.accountAssignment.delete({ where: { id: a.id } });
          // Retire rather than return to the pool, or it would be handed straight
          // back out as the "replacement". But only DISABLE a shared account when
          // this was its last live slot — blanket-disabling withdrew the other
          // buyers' unsold slots from sale too. Clamp the decrement at 0 so a
          // drifted counter can't go negative.
          const acct = await tx.digitalAccount.findUnique({ where: { id: a.accountId }, select: { usedSlots: true } });
          const used = Math.max(0, (acct?.usedSlots ?? 1) - 1);
          await tx.digitalAccount.update({
            where: { id: a.accountId },
            data: { usedSlots: used, ...(used === 0 ? { status: "DISABLED" as const } : {}) },
          });
        }
        const creds = await assignAccountSlot(tx, item.variantId, repItem.id, masterKey, false, badAccountIds);
        replacementCostMinor = creds.costMinor;
        payload = { kind: "DIGITAL_ACCOUNT", username: creds.username, password: creds.password, ...(creds.twofa ? { twofa: creds.twofa } : {}), expiresAt: creds.expiresAt?.toISOString() };
      }

      // 3) The new value goes on the REPLACEMENT unit.
      await tx.orderItem.update({
        where: { id: repItem.id },
        data: { deliveryPayloadEncrypted: encryptSecret(JSON.stringify(payload), masterKey) },
      });

      // 4) The original keeps its payload and gains the link + the second unit's
      //    cost (a replacement really does burn another unit, and that belongs to
      //    this sale's margin). `increment` so concurrent replacements can't lose one.
      const extraCost = replacementCostMinor ?? item.variant.defaultCostMinor;
      await tx.orderItem.update({
        where: { id: item.id },
        data: {
          replacedByItemId: repItem.id,
          warrantyStartAt: warrantyStart,
          // Plain addition, not `increment`: costMinor is nullable and in Postgres
          // NULL + x is NULL, which silently DROPPED the replacement's cost for any
          // unit with no recorded cost. Safe from races because step 0 serialises
          // this row for the whole transaction.
          ...(extraCost !== null ? { costMinor: (item.costMinor ?? 0) + extraCost } : {}),
        },
      });

      return { payload, repNumber, repOrderId: repOrder.id, repItemId: repItem.id };
    });

    const oldLabel = oldPayload ? payloadLabel(oldPayload) : null;
    const newLabel = payloadLabel(out.payload as { key?: string; username?: string });
    const detail: ReplacementDetail = {
      originalOrderNumber: item.order.orderNumber,
      replacementOrderNumber: out.repNumber,
      productName: item.productNameSnap,
      variantName: item.variantNameSnap,
      oldText: oldLabel,
      oldTail: tailOf(oldLabel),
      newText: newLabel,
      newTail: tailOf(newLabel) ?? "",
      warrantyCovered: opts.warrantyCovered ?? true,
      at: now,
      originalOrderId: item.orderId,
      replacementOrderId: out.repOrderId,
      originalItemId: item.id,
      replacementItemId: out.repItemId,
    };

    // NOTE: everything below is AFTER the commit. It is deliberately outside the
    // try/catch that returns FAILED — a Redis blip while enqueuing used to report
    // a completed replacement as failed, which left the claim PENDING forever
    // (every retry then returned ALREADY_REPLACED) and the customer untold.
    void notifyReplacementToBuyer(item, oldPayload, out.payload as never, out.repNumber, opts.warrantyCovered !== false);
    return { ok: true, detail };
  } catch (err) {
    const code = err instanceof CoreError ? err.code : "";
    void logError("replaceOrderItem", err, { orderItemId });
    if (err instanceof CoreError && err.message === "ALREADY_REPLACED") return { ok: false, reason: "ALREADY_REPLACED" };
    if (code === "OUT_OF_STOCK") return { ok: false, reason: "NO_STOCK" };
    return { ok: false, reason: "FAILED" };
  }
}

/** Post-commit delivery message. Never throws into the caller's result. */
async function notifyReplacementToBuyer(
  item: { order: { user: { telegramId: bigint | null }; orderNumber: string }; productNameSnap: string; variantNameSnap: string; orderId: string; variant: { product: { activationGuide: string | null; allowPasswordChange: boolean } } },
  oldPayload: { kind?: string; key?: string; username?: string; password?: string; twofa?: string } | null,
  payload: DeliveryPayload,
  repNumber: string,
  warrantyCovered: boolean,
): Promise<void> {
  try {
    if (item.order.user.telegramId === null) return;
    // Show what they HAD alongside what they now have, so there is no doubt
    // which value is dead and which one to use.
    const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const oldLines: string[] = [];
    if (oldPayload) {
      const fixed = repairAccountPair(oldPayload.username, oldPayload.password);
      const oId = fixed?.id ?? oldPayload.username;
      const oPw = fixed?.pw ?? oldPayload.password;
      if (oldPayload.key) oldLines.push(`🔑 <s>${esc(oldPayload.key.split(/\r?\n/)[0] ?? "")}</s>`);
      if (oId) oldLines.push(`👤 <s>${esc(oId)}</s>`);
      if (oPw) oldLines.push(`🔐 <s>${esc(oPw)}</s>`);
    }
    const header = [
      "🔄 <b>Replacement delivered</b>",
      `🧾 Original order: <b>${esc(item.order.orderNumber)}</b>`,
      `🛡 ${warrantyCovered ? "Covered by warranty" : "Goodwill replacement (outside warranty)"}`,
      "",
      ...(oldLines.length
        ? ["❌ <b>Previous</b> — no longer works:", ...oldLines, "", "✅ <b>Replacement</b> — use this one:", ""]
        : []),
      `🧾 Saved as order <b>${esc(repNumber)}</b>`,
      "",
    ].join("\n");
    await enqueueTelegramMessage(
      item.order.user.telegramId,
      `${header}\n${buildDeliveryText(item.productNameSnap, item.variantNameSnap, payload, item.variant.product.activationGuide, item.variant.product.allowPasswordChange)}`,
      {
        buttons: [
          ...deliveryButtons(credsOf(payload)),
          { text: "📦 View updated order", callbackData: `ord:view:${item.orderId}`, style: "primary" as const },
        ],
      },
    );
  } catch (e) {
    // The replacement itself is already committed and recoverable from the order.
    void logError("replaceNotify", e, { orderId: item.orderId });
  }
}

/** Fire on EVERY paid order: auto-fulfil supplier items, then notify admins with a full summary. */
export async function notifyOrderToAdmins(orderId: string, method = "order"): Promise<void> {
  // After-sale follow-up (review request / promo), if the admin enabled one.
  void scheduleFollowup(orderId, loadConfig().STORE_NAME).catch(() => undefined);
  // Tier may have changed with this order — tell them if so (never blocks).
  void (async () => {
    const o = await prisma.order.findUnique({ where: { id: orderId }, select: { userId: true } });
    if (o) await notifyTierChange(o.userId);
  })().catch(() => undefined);
  try {
    const { autoFulfillSupplierItems } = await import("../supplier.service.js");
    await autoFulfillSupplierItems(orderId);
  } catch { /* best-effort */ }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      user: { select: { telegramHandle: true, firstName: true, telegramId: true } },
      items: { include: { variant: { include: { product: { select: { supplierId: true } } } } } },
    },
  });
  if (!order) return;
  const buyer = order.user.telegramHandle ? `@${order.user.telegramHandle}` : (order.user.firstName ?? String(order.user.telegramId));
  const paid = order.walletUsedMinor + order.totalMinor;
  const manualPending = order.items.filter((i) => i.fulfillmentMode === "MANUAL" && i.fulfilledAt === null && !i.variant.product.supplierId);
  const itemLine = (i: (typeof order.items)[number]): string => {
    const vn = i.variantNameSnap.trim().toLowerCase() === "standard" ? "" : ` · ${i.variantNameSnap}`;
    const state = i.fulfilledAt ? "✅" : i.variant.product.supplierId ? "🤖" : "🕐";
    return `${state} ${i.productNameSnap}${vn} ×${i.quantity}`;
  };
  const lines = [
    `🧾 <b>New order — ${method}</b>`,
    `#${order.orderNumber} · ${formatMinor(paid, order.currency as CurrencyCode)}`,
    `👤 ${buyer}`,
    `🆔 <code>${order.user.telegramId ?? "—"}</code>`,
    "",
    ...order.items.map(itemLine),
  ];
  if (manualPending.length > 0) lines.push("", "Tap Deliver to send the pending item(s).");
  const buttons = manualPending.length > 0 ? [{ text: "📦 Deliver now", callbackData: cb("adm", "deliver", orderId), style: "primary" as const }] : undefined;
  await enqueueAdminAlert(lines.join("\n"), buttons);
}
