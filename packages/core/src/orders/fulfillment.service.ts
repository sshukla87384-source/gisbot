import { loadConfig } from "@gis/config";
import { prisma } from "@gis/database";
import type { NormalizedPaymentEvent } from "@gis/payments";
import { effectiveHours, encryptSecret, formatMinor, type CurrencyCode, isCoreError } from "@gis/shared";
import { enqueueAdminAlert, enqueueEmail, enqueueTelegramMessage, enqueueTelegramDocument , DELIVERY_BUTTONS, deliveryButtons} from "../queues.js";
import { accrueCommissionTx } from "./commission.js";
import { assignAccountSlot, assignLicenseKey, buildDeliveryText, deliveryExpiry, buildCombinedDeliveryText, buildDeliveryTxt, combinedDeliveryButtons, credsOf, DELIVERY_FILE_THRESHOLD, fulfillReusableItemTx, thankYouMessage, type DeliveryLine } from "./assign.js";
import { notifyOrderToAdmins } from "./manual-pay.service.js";
import { clearPaymentPrompts, clearChatClutter } from "./pay-prompt.service.js";
import { logWallet } from "../logs.service.js";
import { referralNudgeMessage, shouldSendReferralNudge } from "../users/user.service.js";
import { deliveryInstructionsMessage } from "../admin.service.js";
import { grantReferralRewardTx } from "../referral.service.js";
import { creditCryptoTopup, cryptoNetwork, getCryptoCard, paidFraction, topupIdFromOrderRef } from "./crypto-checkout.service.js";

/**
 * Webhook-driven fulfillment (PRD §6.1 steps 6-13, Security doc §5).
 * Consumed by the worker's "fulfillment" queue. Idempotent at three levels:
 * WebhookEvent (provider,eventId) unique, order-status short-circuit, and the
 * UNIQUE inventory↔orderItem constraints.
 */

type QueuedDelivery = DeliveryLine;

export async function processWebhookEvent(webhookEventId: string): Promise<void> {
  const event = await prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
  if (!event || event.processedAt) return;

  const normalized = (event.rawBody as { normalized?: NormalizedPaymentEvent }).normalized;
  if (!normalized) {
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { processedAt: new Date(), error: "missing normalized payload" },
    });
    return;
  }

  // Wallet top-ups ride the same webhook: their order_id is "topup:<id>".
  const topupId = topupIdFromOrderRef(normalized.orderId);
  if (topupId) {
    await handleTopupEvent(event.id, topupId, normalized);
    return;
  }

  switch (normalized.type) {
    case "payment.succeeded":
      await handleSuccess(event.id, normalized);
      break;
    case "payment.failed":
      await handleFailure(event.id, normalized);
      break;
    case "payment.partial":
      await handlePartial(event.id, normalized);
      break;
    case "refund.processed":
      await handleRefund(event.id, normalized);
      break;
  }
}

/** A crypto wallet deposit changed state: credit it (fully or what arrived). */
async function handleTopupEvent(eventId: string, topupId: string, normalized: NormalizedPaymentEvent): Promise<void> {
  const topup = await prisma.walletTopup.findUnique({ where: { id: topupId } });
  if (!topup) { await markProcessed(eventId, "top-up not found"); return; }
  const owner = await prisma.user.findUnique({ where: { id: topup.userId }, select: { telegramId: true } });
  const net = cryptoNetwork(topup.binanceAsset.replace(/^np:/, ""));
  if (normalized.type === "payment.succeeded") {
    await creditCryptoTopup(topupId);
  } else if (normalized.type === "payment.partial") {
    // What arrived is theirs: credit the paid share of the quoted amount.
    const frac = paidFraction(normalized);
    const minor = Math.floor(topup.amountMinor * frac);
    if (minor >= 1) {
      const r = await creditCryptoTopup(topupId, minor);
      if (r.credited && owner?.telegramId != null) {
        await enqueueTelegramMessage(
          owner.telegramId,
          `ℹ️ Your ${net?.asset ?? "crypto"} deposit arrived short (${normalized.crypto?.actuallyPaid ?? "?"} of ${normalized.crypto?.payAmount ?? "?"} ${(normalized.crypto?.payCurrency ?? "").toUpperCase()}), so that part has been credited. Nothing is lost — start a new deposit for the rest.`,
        ).catch(() => undefined);
      }
    }
  } else if (normalized.type === "payment.failed") {
    await prisma.walletTopup.updateMany({ where: { id: topupId, status: "PENDING" }, data: { status: "EXPIRED" } });
  }
  await markProcessed(eventId);
}

/**
 * Crypto underpayment on an order. The address stays live and NOWPayments
 * finishes the payment once the rest lands, so: tell the customer exactly how
 * much is missing, tell the admin, and keep the payment PENDING for the poll.
 */
async function handlePartial(eventId: string, normalized: NormalizedPaymentEvent): Promise<void> {
  const orderId = await findOrderId(normalized);
  if (orderId) {
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { user: true } });
    const c = normalized.crypto;
    const asked = Number(c?.payAmount);
    const got = Number(c?.actuallyPaid);
    const missing = Number.isFinite(asked) && Number.isFinite(got) ? Math.max(0, asked - got) : null;
    const unit = (c?.payCurrency ?? "").toUpperCase();
    const card = await getCryptoCard("order", orderId);
    if (order?.user.telegramId != null && order.status === "PENDING_PAYMENT") {
      const lines = [
        `⚠️ <b>Payment received short</b> — order <b>${order.orderNumber}</b>`,
        "",
        `Received: <b>${c?.actuallyPaid ?? "?"} ${unit}</b> of <b>${c?.payAmount ?? "?"} ${unit}</b>.`,
        ...(missing !== null && missing > 0 ? [`Send the remaining <b>${trimNum(missing)} ${unit}</b> to the <b>same address</b> and it completes automatically:`] : []),
        ...(card?.payAddress ? [`<code>${card.payAddress}</code>`] : []),
        ...(card?.payinExtraId ? [`Memo / tag: <code>${card.payinExtraId}</code>`] : []),
        "",
        "💡 Exchanges deduct a network fee from what you send — add it on top next time.",
      ];
      await enqueueTelegramMessage(order.user.telegramId, lines.join("\n")).catch(() => undefined);
    }
    await enqueueAdminAlert(`⚠️ Crypto underpayment on ${order?.orderNumber ?? orderId}: ${c?.actuallyPaid ?? "?"} of ${c?.payAmount ?? "?"} ${unit}. Waiting for the rest; if it never comes, credit the wallet from the panel.`).catch(() => undefined);
    await prisma.auditLog.create({
      data: { actorType: "SYSTEM", action: "order.payment.partial", entityType: "Order", entityId: orderId, after: { ...(c ?? {}), provider: normalized.provider } },
    }).catch(() => undefined);
  }
  await markProcessed(eventId);
}

function trimNum(n: number): string {
  return n.toFixed(8).replace(/\.?0+$/, "") || "0";
}

async function markProcessed(eventId: string, error?: string): Promise<void> {
  await prisma.webhookEvent.update({
    where: { id: eventId },
    data: { processedAt: new Date(), error },
  });
}

async function findOrderId(normalized: NormalizedPaymentEvent): Promise<string | null> {
  if (normalized.orderId) return normalized.orderId;
  if (normalized.providerRef) {
    const payment = await prisma.payment.findFirst({
      where: { providerRef: normalized.providerRef },
      select: { orderId: true },
    });
    if (payment) return payment.orderId;
  }
  return null;
}

async function handleSuccess(eventId: string, normalized: NormalizedPaymentEvent): Promise<void> {
  const masterKey = loadConfig().ENCRYPTION_MASTER_KEY;
  const orderId = await findOrderId(normalized);
  if (!orderId) {
    await enqueueAdminAlert(`⚠️ Payment webhook without matching order (${normalized.provider} ${normalized.eventId})`);
    await markProcessed(eventId, "order not found");
    return;
  }

  // A crypto transfer can land after the order's own window closed (the sweep
  // marked it EXPIRED and gave any wallet part back). It is still paid for and
  // still delivered below; the admin just needs to know the wallet part is
  // not covered.
  const before = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true, orderNumber: true, walletUsedMinor: true } });

  const outcome = await prisma.$transaction(
    async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: {
          user: true,
          items: { include: { variant: { include: { product: true } } } },
        },
      });
      if (!order) return { kind: "skip" as const, note: "order missing" };
      if (["PAID", "COMPLETED", "PENDING_FULFILLMENT", "AWAITING_STOCK"].includes(order.status)) {
        return { kind: "skip" as const, note: "already processed" };
      }

      // Amount + currency verification — mismatch never auto-fulfills. The
      // figure to match is what WE asked the gateway for: the Payment row.
      // That is the order total for the hosted gateways, but a crypto order
      // is invoiced in USD whatever currency the order itself is priced in.
      const asked = normalized.providerRef
        ? await tx.payment.findFirst({ where: { orderId: order.id, providerRef: normalized.providerRef }, select: { amountMinor: true, currency: true } })
        : null;
      const expectedMinor = asked?.amountMinor ?? order.totalMinor;
      const expectedCurrency = asked?.currency ?? order.currency;
      if (
        (normalized.amountMinor !== null && normalized.amountMinor !== expectedMinor) ||
        (normalized.currency !== null && normalized.currency !== expectedCurrency)
      ) {
        await tx.order.update({ where: { id: order.id }, data: { status: "MANUAL_REVIEW" } });
        await tx.auditLog.create({
          data: {
            actorType: "SYSTEM",
            action: "order.payment.amount_mismatch",
            entityType: "Order",
            entityId: order.id,
            after: {
              expected: { amountMinor: expectedMinor, currency: expectedCurrency },
              received: { amountMinor: normalized.amountMinor, currency: normalized.currency },
            },
          },
        });
        return { kind: "mismatch" as const, orderNumber: order.orderNumber };
      }

      // Capture the ONE payment this event is about. `updateMany` across the
      // whole order marked every attempt SUCCEEDED — a customer who tried UPI,
      // gave up and paid by crypto left two payment rows, and both were booked
      // as captured, so the order read as paid twice and reconciliation had to
      // be done by hand. It also stamped the new providerRef onto all of them,
      // which the (provider, providerRef) unique cannot allow.
      const captured =
        (normalized.providerRef
          ? await tx.payment.findFirst({
              where: { orderId: order.id, providerRef: normalized.providerRef },
              select: { id: true },
            })
          : null) ??
        (await tx.payment.findFirst({
          where: { orderId: order.id, status: { in: ["CREATED", "PENDING"] } },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        }));
      if (captured) {
        await tx.payment.update({
          where: { id: captured.id },
          data: {
            status: "SUCCEEDED",
            capturedAt: new Date(),
            ...(normalized.providerRef ? { providerRef: normalized.providerRef } : {}),
          },
        });
      }
      await tx.order.update({ where: { id: order.id }, data: { status: "PAID", paidAt: new Date() } });

      const deliveries: QueuedDelivery[] = [];
      let pendingManual = 0;
      let awaitingStock = 0;
      const wasFirstPurchase = order.user.firstPurchaseAt === null;

      for (const item of order.items) {
        if (item.fulfilledAt) continue;
        const type = item.variant.product.type;
        const guide = item.variant.product.activationGuide;

        // "Same link for everyone" first: one stored value, no inventory, any
        // product type, MANUAL mode included — the same branch the wallet rail
        // has always had. Without it a gateway-paid link order sat in
        // AWAITING_STOCK until an admin delivered it by hand.
        try {
          const reusable = await fulfillReusableItemTx(tx, item, masterKey);
          if (reusable) {
            if (order.user.telegramId !== null) {
              deliveries.push({ productName: item.productNameSnap, variantName: item.variantNameSnap, payload: reusable, activationGuide: guide, allowPwChange: item.variant.product.allowPasswordChange });
            }
            await accrueCommissionTx(tx, item, order.currency);
            continue;
          }
        } catch (e) {
          awaitingStock++;
          if (!(isCoreError(e) && e.code === "OUT_OF_STOCK")) {
            // eslint-disable-next-line no-console
            console.error("reusable fulfilment failed", { orderItemId: item.id, error: String(e).slice(0, 300) });
          }
          continue;
        }

        if (item.fulfillmentMode === "MANUAL" || (type !== "LICENSE_KEY" && type !== "DIGITAL_ACCOUNT")) {
          pendingManual++;
          continue;
        }

        let deliveredThisItem = false;
        try {
          if (type === "LICENSE_KEY") {
            const { key, expiresAt: stockExpiry, costMinor: cost } = await assignLicenseKey(tx, item.variantId, item.id, masterKey, true);
            const expiresAt = deliveryExpiry(stockExpiry, effectiveHours(item.variant.durationHours, item.variant.durationDays));
            const payload = { kind: "LICENSE_KEY", key, expiresAt: expiresAt?.toISOString() };
            await tx.orderItem.update({
              where: { id: item.id },
              data: {
                fulfilledAt: new Date(),
                warrantyStartAt: new Date(),
                expiresAt,
                costMinor: cost ?? item.variant.defaultCostMinor,
                deliveryPayloadEncrypted: encryptSecret(JSON.stringify(payload), masterKey),
              },
            });
            if (order.user.telegramId !== null) {
              deliveries.push({ productName: item.productNameSnap, variantName: item.variantNameSnap, payload, activationGuide: guide, allowPwChange: item.variant.product.allowPasswordChange });
            }
          } else {
            const creds = await assignAccountSlot(tx, item.variantId, item.id, masterKey, true);
            const expiresAt = deliveryExpiry(creds.expiresAt, effectiveHours(item.variant.durationHours, item.variant.durationDays));
            const payload = {
              kind: "DIGITAL_ACCOUNT",
              username: creds.username,
              password: creds.password,
              expiresAt: expiresAt?.toISOString(),
            };
            await tx.orderItem.update({
              where: { id: item.id },
              data: {
                fulfilledAt: new Date(),
                warrantyStartAt: new Date(),
                expiresAt,
                costMinor: creds.costMinor ?? item.variant.defaultCostMinor,
                deliveryPayloadEncrypted: encryptSecret(JSON.stringify(payload), masterKey),
              },
            });
            if (order.user.telegramId !== null) {
              deliveries.push({ productName: item.productNameSnap, variantName: item.variantNameSnap, payload, activationGuide: guide, allowPwChange: item.variant.product.allowPasswordChange });
            }
          }
          deliveredThisItem = true;
        } catch (e) {
          // OUT_OF_STOCK for this item — paid order must never fail entirely.
          awaitingStock++;
          // But only OUT_OF_STOCK is expected. Anything else was reported to the
          // admin as "temporarily out of stock", so a systemic failure (bad
          // master key, DB fault) looked like empty shelves with no log line.
          if (!(isCoreError(e) && e.code === "OUT_OF_STOCK")) {
            // eslint-disable-next-line no-console
            console.error("fulfilment failed (not stock)", { orderItemId: item.id, error: String(e).slice(0, 300) });
            void logWallet("fulfil.error", `Fulfilment failed for ${item.productNameSnap} — NOT a stock problem`, {
              orderItemId: item.id, error: String(e).slice(0, 200),
            });
          }
        }

        // Commission ONLY for an item that was actually delivered. The old code
        // ran even when assignment threw, so a reseller was paid for goods the
        // customer never received and later got refunded for.
        if (deliveredThisItem) await accrueCommissionTx(tx, item, order.currency);
      }

      // Referral reward (tiered: first purchase vs repeat), held for anti-fraud.
      await grantReferralRewardTx(tx, {
        referrerId: order.user.referredById,
        referredId: order.userId,
        orderId: order.id,
        netMinor: order.subtotalMinor - order.discountMinor,
        currency: order.currency as "INR" | "USD",
        isFirst: wasFirstPurchase,
      });

      await tx.invoice.create({
        data: { orderId: order.id, invoiceNumber: order.orderNumber.replace(/^GIS/, "INV") },
      });
      await tx.user.updateMany({
        where: { id: order.userId, firstPurchaseAt: null },
        data: { firstPurchaseAt: new Date() },
      });
      const cart = await tx.cart.findUnique({ where: { userId: order.userId } });
      if (cart) await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

      const finalStatus =
        awaitingStock > 0 ? "AWAITING_STOCK" : pendingManual > 0 ? "PENDING_FULFILLMENT" : "COMPLETED";
      await tx.order.update({
        where: { id: order.id },
        data: { status: finalStatus, ...(finalStatus === "COMPLETED" ? { completedAt: new Date() } : {}) },
      });
      await tx.auditLog.create({
        data: {
          actorType: "SYSTEM",
          action: "order.fulfill.webhook",
          entityType: "Order",
          entityId: order.id,
          after: { status: finalStatus, deliveries: deliveries.length, pendingManual, awaitingStock },
        },
      });

      return {
        kind: "fulfilled" as const,
        orderId: order.id,
        userId: order.userId,
        buyerHandle: order.user.telegramHandle,
        buyerFirst: order.user.firstName,
        buyerReferral: order.user.referralCode,
        orderNumber: order.orderNumber,
        totalMinor: order.totalMinor,
        currency: order.currency,
        telegramId: order.user.telegramId,
        email: order.user.email,
        deliveries,
        pendingManual,
        awaitingStock,
        finalStatus,
      };
    },
    { timeout: 20_000 },
  );

  // Post-commit side effects (queued — retries safe).
  // The "pay this amount" card is stale the moment the payment lands.
  if (outcome.kind === "fulfilled") {
    await clearPaymentPrompts(orderId).catch(() => undefined);
    await clearChatClutter(outcome.telegramId).catch(() => undefined);
  }
  if (outcome.kind === "fulfilled" && before?.status === "EXPIRED") {
    await enqueueAdminAlert(`ℹ️ ${before.orderNumber} was paid AFTER it expired and has been delivered. If part of it had been paid from the wallet, that part was refunded at expiry — check the customer's wallet.`).catch(() => undefined);
  }
  if (outcome.kind === "mismatch") {
    await enqueueAdminAlert(`🚨 Amount mismatch on ${outcome.orderNumber} — order set to MANUAL_REVIEW`);
  } else if (outcome.kind === "fulfilled") {
    const money = formatMinor(outcome.totalMinor, outcome.currency as CurrencyCode);
    if (outcome.telegramId !== null) {
      await enqueueTelegramMessage(
        outcome.telegramId,
        `🎉 <b>Payment received!</b> ✅\nOrder <b>${outcome.orderNumber}</b> — ${money}. Delivering now… 🚀`,
      );
      if (outcome.deliveries.length === 1) {
        const d = outcome.deliveries[0]!;
        await enqueueTelegramMessage(outcome.telegramId, buildDeliveryText(d.productName, d.variantName, d.payload, d.activationGuide, d.allowPwChange, { amountLabel: money, orderNumber: outcome.orderNumber }), { buttons: deliveryButtons(credsOf(d.payload), { orderId }) });
      } else if (outcome.deliveries.length > DELIVERY_FILE_THRESHOLD) {
        await enqueueTelegramDocument(outcome.telegramId, `order-${outcome.orderNumber}.txt`, buildDeliveryTxt(outcome.deliveries, outcome.orderNumber, { amountLabel: money }), `🎉 Your order is delivered! ${outcome.deliveries.length} items are in the attached file. 💾 Saved in 🔑 My Licenses.`, DELIVERY_BUTTONS);
      } else if (outcome.deliveries.length > 1) {
        await enqueueTelegramMessage(outcome.telegramId, buildCombinedDeliveryText(outcome.deliveries, outcome.orderNumber, { amountLabel: money }), { buttons: combinedDeliveryButtons(outcome.deliveries, orderId) });
      }
      if (outcome.deliveries.length > 0) {
        await enqueueTelegramMessage(
          outcome.telegramId,
          thankYouMessage({ telegramHandle: outcome.buyerHandle, firstName: outcome.buyerFirst }, loadConfig().STORE_NAME),
        );
        // First delivery of the day only — see shouldSendReferralNudge.
        if (await shouldSendReferralNudge(outcome.userId)) {
          const nudge = referralNudgeMessage(outcome.buyerReferral, loadConfig().BOT_USERNAME);
          if (nudge) await enqueueTelegramMessage(outcome.telegramId, nudge);
        }
        const instr = await deliveryInstructionsMessage();
        if (instr) await enqueueTelegramMessage(outcome.telegramId, instr, { buttons: DELIVERY_BUTTONS });
      }
      if (outcome.pendingManual > 0) {
        await enqueueTelegramMessage(
          outcome.telegramId,
          `⏳ <b>${outcome.pendingManual} item(s) being prepared</b>\nThey arrive in this chat automatically — usually within a minute. Nothing more to do.`,
        );
      }
      if (outcome.awaitingStock > 0) {
        await enqueueTelegramMessage(
          outcome.telegramId,
          `⚠️ ${outcome.awaitingStock} item(s) went out of stock at the last moment. Our team will restock or refund you shortly.`,
        );
      }
    }
    await notifyOrderToAdmins(outcome.orderId, "Gateway");
    if (outcome.email && loadConfig().RESEND_API_KEY) {
      await enqueueEmail({
        to: outcome.email,
        subject: `${loadConfig().STORE_NAME} — payment received (${outcome.orderNumber})`,
        html: `<p>We received your payment of <b>${money}</b> for order <b>${outcome.orderNumber}</b>. Your items are delivered in the Telegram chat and stored in “My Licenses”.</p>`,
      });
    }
    if (outcome.awaitingStock > 0) {
      await enqueueAdminAlert(`🚨 ${outcome.orderNumber}: ${outcome.awaitingStock} paid item(s) AWAITING_STOCK`);
    }
    if (outcome.pendingManual > 0) {
      await enqueueAdminAlert(`🕐 ${outcome.orderNumber}: ${outcome.pendingManual} item(s) pending MANUAL fulfillment`);
    }
  }

  await markProcessed(eventId);
}

async function handleFailure(eventId: string, normalized: NormalizedPaymentEvent): Promise<void> {
  const orderId = await findOrderId(normalized);
  if (orderId) {
    await prisma.payment.updateMany({
      where: { orderId, status: { in: ["CREATED", "PENDING"] } },
      data: { status: "FAILED", failureReason: normalized.failureReason ?? "gateway reported failure" },
    });
    await prisma.auditLog.create({
      data: {
        actorType: "SYSTEM",
        action: "order.payment.failed",
        entityType: "Order",
        entityId: orderId,
        after: { reason: normalized.failureReason ?? null, provider: normalized.provider },
      },
    });
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { user: true } });
    if (order?.user.telegramId != null && order.status === "PENDING_PAYMENT") {
      // The reason is free text the GATEWAY wrote (Razorpay's error_description).
      // Dropped into an HTML message unescaped, a single "<" made Telegram reject
      // the send, so the customer was never told their payment had failed.
      const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      await enqueueTelegramMessage(
        order.user.telegramId,
        `❌ Payment for order <b>${esc(order.orderNumber)}</b> failed${normalized.failureReason ? ` (${esc(normalized.failureReason)})` : ""}. You can retry from 🛒 Cart → Checkout.`,
      );
    }
  }
  await markProcessed(eventId);
}

async function handleRefund(eventId: string, normalized: NormalizedPaymentEvent): Promise<void> {
  if (normalized.providerRef) {
    const payment = await prisma.payment.findFirst({ where: { providerRef: normalized.providerRef } });
    if (payment) {
      await prisma.payment.update({ where: { id: payment.id }, data: { status: "REFUNDED" } });
      await prisma.auditLog.create({
        data: {
          actorType: "SYSTEM",
          action: "order.payment.refunded",
          entityType: "Order",
          entityId: payment.orderId,
          after: { provider: normalized.provider, amountMinor: normalized.amountMinor },
        },
      });
      await enqueueAdminAlert(`↩️ Gateway refund recorded for order ${payment.orderId}`);
    }
  }
  await markProcessed(eventId);
}
