import { loadConfig } from "@gis/config";
import { prisma } from "@gis/database";
import type { NormalizedPaymentEvent } from "@gis/payments";
import { encryptSecret, formatMinor, type CurrencyCode } from "@gis/shared";
import { enqueueAdminAlert, enqueueEmail, enqueueTelegramMessage } from "../queues.js";
import { assignAccountSlot, assignLicenseKey, buildDeliveryText } from "./assign.js";

/**
 * Webhook-driven fulfillment (PRD §6.1 steps 6-13, Security doc §5).
 * Consumed by the worker's "fulfillment" queue. Idempotent at three levels:
 * WebhookEvent (provider,eventId) unique, order-status short-circuit, and the
 * UNIQUE inventory↔orderItem constraints.
 */

interface QueuedDelivery {
  telegramId: bigint;
  text: string;
}

async function getSettingInt(key: string, fallback: number): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key } });
  const n = Number(row?.value);
  return Number.isFinite(n) ? n : fallback;
}

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

  switch (normalized.type) {
    case "payment.succeeded":
      await handleSuccess(event.id, normalized);
      break;
    case "payment.failed":
      await handleFailure(event.id, normalized);
      break;
    case "refund.processed":
      await handleRefund(event.id, normalized);
      break;
  }
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

  const [rewardBp, holdHours, commissionBpDefault] = await Promise.all([
    getSettingInt("referral.reward_pct_bp", 500),
    getSettingInt("referral.hold_hours", 48),
    getSettingInt("reseller.commission_pct_bp", 1000),
  ]);

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

      // Amount + currency verification — mismatch never auto-fulfills.
      if (
        (normalized.amountMinor !== null && normalized.amountMinor !== order.totalMinor) ||
        (normalized.currency !== null && normalized.currency !== order.currency)
      ) {
        await tx.order.update({ where: { id: order.id }, data: { status: "MANUAL_REVIEW" } });
        await tx.auditLog.create({
          data: {
            actorType: "SYSTEM",
            action: "order.payment.amount_mismatch",
            entityType: "Order",
            entityId: order.id,
            after: {
              expected: { amountMinor: order.totalMinor, currency: order.currency },
              received: { amountMinor: normalized.amountMinor, currency: normalized.currency },
            },
          },
        });
        return { kind: "mismatch" as const, orderNumber: order.orderNumber };
      }

      await tx.payment.updateMany({
        where: { orderId: order.id },
        data: {
          status: "SUCCEEDED",
          capturedAt: new Date(),
          ...(normalized.providerRef ? { providerRef: normalized.providerRef } : {}),
        },
      });
      await tx.order.update({ where: { id: order.id }, data: { status: "PAID", paidAt: new Date() } });

      const deliveries: QueuedDelivery[] = [];
      let pendingManual = 0;
      let awaitingStock = 0;
      const wasFirstPurchase = order.user.firstPurchaseAt === null;

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
            await tx.orderItem.update({
              where: { id: item.id },
              data: {
                fulfilledAt: new Date(),
                deliveryPayloadEncrypted: encryptSecret(JSON.stringify(payload), masterKey),
              },
            });
            if (order.user.telegramId !== null) {
              deliveries.push({
                telegramId: order.user.telegramId,
                text: buildDeliveryText(item.productNameSnap, item.variantNameSnap, payload, guide),
              });
            }
          } else {
            const creds = await assignAccountSlot(tx, item.variantId, item.id, masterKey, true);
            const payload = {
              kind: "DIGITAL_ACCOUNT",
              username: creds.username,
              password: creds.password,
              expiresAt: creds.expiresAt?.toISOString(),
            };
            await tx.orderItem.update({
              where: { id: item.id },
              data: {
                fulfilledAt: new Date(),
                deliveryPayloadEncrypted: encryptSecret(JSON.stringify(payload), masterKey),
              },
            });
            if (order.user.telegramId !== null) {
              deliveries.push({
                telegramId: order.user.telegramId,
                text: buildDeliveryText(item.productNameSnap, item.variantNameSnap, payload, guide),
              });
            }
          }
        } catch {
          // OUT_OF_STOCK for this item — paid order must never fail entirely.
          awaitingStock++;
        }

        // Marketplace commission accrual with hold (PRD §6.6).
        if (item.resellerIdSnap) {
          const profile = await tx.resellerProfile.findUnique({ where: { id: item.resellerIdSnap } });
          const bp = profile?.commissionPct ?? commissionBpDefault;
          const commission = Math.floor((item.totalMinor * bp) / 10_000);
          const holdDays = profile?.holdDays ?? 7;
          await tx.commissionEntry.create({
            data: {
              orderItemId: item.id,
              resellerId: item.resellerIdSnap,
              grossMinor: item.totalMinor,
              commissionMinor: commission,
              netMinor: item.totalMinor - commission,
              currency: order.currency,
              holdUntil: new Date(Date.now() + holdDays * 86_400_000),
            },
          });
        }
      }

      // Referral reward on first purchase, held for anti-fraud (PRD §6.5).
      if (wasFirstPurchase && order.user.referredById) {
        const net = order.subtotalMinor - order.discountMinor;
        const amount = Math.floor((net * rewardBp) / 10_000);
        if (amount > 0) {
          await tx.referralReward.create({
            data: {
              referrerId: order.user.referredById,
              referredId: order.userId,
              orderId: order.id,
              amountMinor: amount,
              currency: order.currency,
              status: "PENDING_HOLD",
              holdUntil: new Date(Date.now() + holdHours * 3_600_000),
            },
          });
        }
      }

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
  if (outcome.kind === "mismatch") {
    await enqueueAdminAlert(`🚨 Amount mismatch on ${outcome.orderNumber} — order set to MANUAL_REVIEW`);
  } else if (outcome.kind === "fulfilled") {
    const money = formatMinor(outcome.totalMinor, outcome.currency as CurrencyCode);
    if (outcome.telegramId !== null) {
      await enqueueTelegramMessage(
        outcome.telegramId,
        `✅ Payment received! Order <b>${outcome.orderNumber}</b> — ${money}.`,
      );
      for (const d of outcome.deliveries) await enqueueTelegramMessage(d.telegramId, d.text);
      if (outcome.pendingManual > 0) {
        await enqueueTelegramMessage(
          outcome.telegramId,
          `🕐 ${outcome.pendingManual} item(s) are being prepared by our team (~12 h). You'll be notified here.`,
        );
      }
      if (outcome.awaitingStock > 0) {
        await enqueueTelegramMessage(
          outcome.telegramId,
          `⚠️ ${outcome.awaitingStock} item(s) went out of stock at the last moment. Our team will restock or refund you shortly.`,
        );
      }
    }
    if (outcome.email && loadConfig().RESEND_API_KEY) {
      await enqueueEmail({
        to: outcome.email,
        subject: `Get It Sasta — payment received (${outcome.orderNumber})`,
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
      await enqueueTelegramMessage(
        order.user.telegramId,
        `❌ Payment for order <b>${order.orderNumber}</b> failed${normalized.failureReason ? ` (${normalized.failureReason})` : ""}. You can retry from 🛒 Cart → Checkout.`,
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
