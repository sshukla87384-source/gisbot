import { loadConfig } from "@gis/config";
import { nextOrderNumber, prisma, type Currency } from "@gis/database";
import { CoreError, encryptSecret, formatMinor, type CurrencyCode } from "@gis/shared";
import { enqueueAdminAlert, enqueueTelegramMessage } from "../queues.js";
import { assignAccountSlot, assignLicenseKey, buildDeliveryText, priceCart } from "./assign.js";

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
}

/**
 * Convert an order total (minor units, INR/USD) to a clean USDT amount the
 * customer pays exactly. Confirmation is by the Binance transaction ID the
 * customer submits (or admin verification), so no unique tail is needed.
 */
function toUsdtAmount(totalMinor: number, currency: Currency): string {
  const cfg = loadConfig();
  const rate = currency === "INR" ? cfg.BINANCE_USDT_INR_RATE : cfg.BINANCE_USDT_USD_RATE;
  return (totalMinor / 100 / rate).toFixed(2);
}

export async function createBinanceManualCheckout(userId: string): Promise<BinanceCheckoutResult> {
  const cfg = loadConfig();
  const uid = cfg.BINANCE_PAY_UID;
  if (!uid) throw new CoreError("VALIDATION_FAILED", "Binance Pay is not configured");

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const expiresAt = new Date(Date.now() + 60 * 60_000); // 60-min window for manual pay

  const created = await prisma.$transaction(async (tx) => {
    await tx.order.updateMany({
      where: { userId, status: "PENDING_PAYMENT" },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
    const lines = await priceCart(tx, userId, user.currency);
    const totalMinor = lines.reduce((s, l) => s + l.unitPriceMinor * l.quantity, 0);
    const usdt = toUsdtAmount(totalMinor, user.currency);
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
    return { orderId: order.id, orderNumber, totalMinor, binanceAmount: usdt };
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
      if (["PAID", "COMPLETED", "PENDING_FULFILLMENT", "AWAITING_STOCK", "REFUNDED"].includes(order.status)) {
        return { kind: "skip" as const };
      }

      await tx.order.update({ where: { id: order.id }, data: { status: "PAID", paidAt: new Date() } });

      const deliveries: Array<{ telegramId: bigint; text: string }> = [];
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
            const { key, expiresAt } = await assignLicenseKey(tx, item.variantId, item.id, masterKey, true);
            const payload = { kind: "LICENSE_KEY", key, expiresAt: expiresAt?.toISOString() };
            await tx.orderItem.update({ where: { id: item.id }, data: { fulfilledAt: new Date(), deliveryPayloadEncrypted: encryptSecret(JSON.stringify(payload), masterKey) } });
            if (order.user.telegramId !== null) deliveries.push({ telegramId: order.user.telegramId, text: buildDeliveryText(item.productNameSnap, item.variantNameSnap, payload, guide) });
          } else {
            const creds = await assignAccountSlot(tx, item.variantId, item.id, masterKey, true);
            const payload = { kind: "DIGITAL_ACCOUNT", username: creds.username, password: creds.password, expiresAt: creds.expiresAt?.toISOString() };
            await tx.orderItem.update({ where: { id: item.id }, data: { fulfilledAt: new Date(), deliveryPayloadEncrypted: encryptSecret(JSON.stringify(payload), masterKey) } });
            if (order.user.telegramId !== null) deliveries.push({ telegramId: order.user.telegramId, text: buildDeliveryText(item.productNameSnap, item.variantNameSnap, payload, guide) });
          }
        } catch {
          awaitingStock++;
        }
      }

      await tx.invoice.upsert({
        where: { orderId: order.id },
        create: { orderId: order.id, invoiceNumber: order.orderNumber.replace(/^GIS/, "INV") },
        update: {},
      });
      await tx.user.updateMany({ where: { id: order.userId, firstPurchaseAt: null }, data: { firstPurchaseAt: new Date() } });
      const cart = await tx.cart.findUnique({ where: { userId: order.userId } });
      if (cart) await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

      const finalStatus = awaitingStock > 0 ? "AWAITING_STOCK" : pendingManual > 0 ? "PENDING_FULFILLMENT" : "COMPLETED";
      await tx.order.update({ where: { id: order.id }, data: { status: finalStatus, ...(finalStatus === "COMPLETED" ? { completedAt: new Date() } : {}) } });
      await tx.auditLog.create({ data: { actorId, actorType: "ADMIN", action: "order.confirm.manual", entityType: "Order", entityId: order.id, after: { finalStatus, delivered: deliveries.length } } });

      return { kind: "done" as const, telegramId: order.user.telegramId, orderNumber: order.orderNumber, totalMinor: order.totalMinor, currency: order.currency, deliveries, finalStatus, pendingManual, awaitingStock };
    },
    { timeout: 20_000 },
  );

  if (outcome.kind === "skip") return { status: "already_processed", delivered: 0 };

  if (outcome.telegramId !== null) {
    await enqueueTelegramMessage(outcome.telegramId, `🎉 <b>Payment confirmed!</b> ✅\nOrder <b>${outcome.orderNumber}</b> — ${formatMinor(outcome.totalMinor, outcome.currency as CurrencyCode)}. Delivering now… 🚀`);
    for (const d of outcome.deliveries) await enqueueTelegramMessage(d.telegramId, d.text);
    if (outcome.pendingManual > 0) await enqueueTelegramMessage(outcome.telegramId, `🕐 ${outcome.pendingManual} item(s) are being prepared (~12 h).`);
    if (outcome.awaitingStock > 0) await enqueueTelegramMessage(outcome.telegramId, `⚠️ ${outcome.awaitingStock} item(s) are temporarily out of stock; our team will sort it out.`);
  }
  return { status: outcome.finalStatus, delivered: outcome.deliveries.length };
}
