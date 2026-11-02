import { prisma, type Currency } from "@gis/database";
import { formatMinor, type CurrencyCode } from "@gis/shared";
import { creditWalletTx } from "../wallet/wallet.service.js";
import { convertMinor } from "../fx.js";
import { enqueueTelegramMessage } from "../queues.js";

/**
 * A refund is computed in the ORDER's currency, but `adjustWallet` always moves
 * the WALLET's own. They differ the moment a customer switches currency after
 * buying, and crediting the raw number then paid out 100x. Returns what to
 * credit and the currency to say it in.
 */
async function creditForOrder(userId: string, amountMinor: number, orderCurrency: string): Promise<{ minor: number; currency: string }> {
  const wal = await prisma.wallet.findUnique({ where: { userId }, select: { currency: true } });
  if (!wal || wal.currency === orderCurrency) return { minor: amountMinor, currency: orderCurrency };
  return { minor: convertMinor(amountMinor, orderCurrency as Currency, wal.currency), currency: wal.currency };
}

type MTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Refund (part of) a PAID order to the buyer's wallet — under a lock on the
 * order row, re-checking its status, with ONE idempotency key per order so the
 * stock auto-refund and an admin refund can never both pay out. The BNPL part
 * is not money we hold: it comes off the customer's Pay-Later balance instead.
 * Referral rewards still on hold for the order are withheld and reseller
 * commissions are clawed back, so a refunded order pays nobody.
 */
async function refundPaidOrderTx(
  tx: MTx,
  orderId: string,
  mode: "stock" | "admin",
  adminId?: string,
): Promise<{ ok: boolean; reason?: string; refundedMinor?: number; currency?: string; bnplReducedMinor?: number; telegramId?: bigint | null; orderNumber?: string; full?: boolean }> {
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
  const o = await tx.order.findUnique({ where: { id: orderId }, include: { items: true, user: { select: { id: true, telegramId: true, currency: true } } } });
  if (!o) return { ok: false, reason: "NOT_FOUND" };
  if (["REFUNDED", "PARTIALLY_REFUNDED", "CANCELLED", "EXPIRED"].includes(o.status)) return { ok: false, reason: "ALREADY" };
  if (mode === "stock" && o.status !== "AWAITING_STOCK") return { ok: false, reason: "ALREADY" };
  const already = await tx.walletTransaction.findFirst({ where: { idempotencyKey: { in: [`refund:order:${o.id}`, `refund:stock:${o.id}`, `refund:admin:${o.id}`] } }, select: { id: true } });
  if (already) return { ok: false, reason: "ALREADY" };

  // Lines already refunded one by one (refundUndeliverableItems) are paid out:
  // they are neither "undelivered" here nor part of a full refund again.
  const refundedTotal = o.items.filter((i) => i.refundedAt !== null).reduce((n, i) => n + i.totalMinor, 0);
  const undelivered = o.items.filter((i) => i.fulfilledAt === null && i.refundedAt === null);
  const full = mode === "admin" || undelivered.length === o.items.filter((i) => i.refundedAt === null).length;
  if (mode === "stock" && undelivered.length === 0) {
    await tx.order.update({ where: { id: o.id }, data: { status: refundedTotal > 0 ? "PARTIALLY_REFUNDED" : "COMPLETED", completedAt: new Date() } });
    return { ok: false, reason: "NOTHING" };
  }
  // What the customer actually paid us (wallet + gateway, net of coupon).
  const paidMinor = o.walletUsedMinor + (o.paidAt !== null ? o.totalMinor : 0);
  const subtotal = o.subtotalMinor > 0 ? o.subtotalMinor : 1;
  const share = full
    ? Math.max(0, 1 - refundedTotal / subtotal)
    : Math.min(1, undelivered.reduce((sum, i) => sum + i.totalMinor, 0) / subtotal);
  const refundMinor = Math.min(paidMinor, Math.round(paidMinor * share));
  let credited = 0;
  let creditCur: string = o.currency;
  if (refundMinor > 0) {
    const wal = await tx.wallet.findUnique({ where: { userId: o.userId }, select: { currency: true } });
    creditCur = wal?.currency ?? o.currency;
    credited = creditCur === o.currency ? refundMinor : convertMinor(refundMinor, o.currency as Currency, creditCur as Currency);
    await creditWalletTx(tx, {
      userId: o.userId, amountMinor: BigInt(credited), type: "REFUND",
      note: mode === "stock" ? `Auto-refund — out of stock (order ${o.orderNumber})` : `Refund by admin (order ${o.orderNumber})`,
      idempotencyKey: `refund:order:${o.id}`, orderId: o.id,
    });
  }
  // Pay Later: the refunded share comes off what the customer owes.
  let bnplReduced = 0;
  if (o.bnplMinor > 0) {
    const owe = Math.round(o.bnplMinor * share);
    const userCur = o.user.currency as Currency;
    bnplReduced = userCur === o.currency ? owe : convertMinor(owe, o.currency as Currency, userCur);
    const u = await tx.user.findUnique({ where: { id: o.userId }, select: { bnplOutstandingMinor: true } });
    const newOwed = Math.max(0, (u?.bnplOutstandingMinor ?? 0) - bnplReduced);
    await tx.user.update({ where: { id: o.userId }, data: { bnplOutstandingMinor: newOwed } });
  }
  await tx.order.update({ where: { id: o.id }, data: { status: full ? "REFUNDED" : "PARTIALLY_REFUNDED", cancelledAt: full ? new Date() : null } });
  // A refunded order pays nobody: withhold its referral reward if still held,
  // claw back reseller commission not yet released.
  await tx.referralReward.updateMany({ where: { orderId: o.id, status: "PENDING_HOLD" }, data: { status: "WITHHELD", withheldReason: "order refunded" } });
  await tx.commissionEntry.updateMany({ where: { orderItem: { orderId: o.id }, releasedAt: null, clawedBackAt: null }, data: { clawedBackAt: new Date() } });
  await tx.auditLog.create({ data: { actorId: adminId, actorType: adminId ? "ADMIN" : "SYSTEM", action: `order.refund.${mode}`, entityType: "Order", entityId: o.id, after: { refundMinor, credited, creditCur, bnplReduced, full } } });
  return { ok: true, refundedMinor: credited, currency: creditCur, bnplReducedMinor: bnplReduced, telegramId: o.user.telegramId, orderNumber: o.orderNumber, full };
}

/**
 * Auto-refund orders stuck in AWAITING_STOCK: an item went out of stock after
 * payment. Credits the value of the undelivered items back to the buyer's
 * wallet (store credit — works for any payment method), marks the order
 * REFUNDED, and notifies the customer. Idempotent per order.
 */
export async function autoRefundStuckStock(olderThanHours = 6, limit = 50): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanHours * 3_600_000);
  const orders = await prisma.order.findMany({ where: { status: "AWAITING_STOCK", paidAt: { lt: cutoff } }, select: { id: true }, take: limit });
  let refunded = 0;
  for (const { id } of orders) {
    try {
      const r = await prisma.$transaction((tx) => refundPaidOrderTx(tx, id, "stock"));
      if (!r.ok) continue;
      refunded++;
      if (r.telegramId != null && (r.refundedMinor ?? 0) > 0) {
        await enqueueTelegramMessage(
          r.telegramId,
          `↩️ <b>Refund issued</b>\nSome items in order <b>${r.orderNumber}</b> went out of stock, so we've credited <b>${formatMinor(r.refundedMinor ?? 0, (r.currency ?? "USD") as CurrencyCode)}</b> back to your wallet. We're sorry for the inconvenience! 🙏`,
        ).catch(() => undefined);
      }
    } catch {
      // Leave the order for the next run.
    }
  }
  return refunded;
}

export interface RefundResult { ok: boolean; reason?: string; refundedMinor?: number; currency?: string }

/** Admin action: refund an order's actually-paid amount to the buyer's wallet. Idempotent per order. */
export async function adminRefundOrder(orderId: string, adminId?: string): Promise<RefundResult> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true, walletUsedMinor: true, currency: true, user: { select: { telegramId: true } }, orderNumber: true } });
  if (!order) return { ok: false, reason: "NOT_FOUND" };
  // Unpaid: only the wallet part was ever taken — close it the normal way.
  if (order.status === "PENDING_PAYMENT") {
    const { closeUnpaidOrderTx } = await import("./manual-pay.service.js");
    const closed = await prisma.$transaction((tx) => closeUnpaidOrderTx(tx, orderId, "CANCELLED", "refunded by admin"));
    return closed ? { ok: true, refundedMinor: order.walletUsedMinor, currency: order.currency } : { ok: false, reason: "ALREADY" };
  }
  const r = await prisma.$transaction((tx) => refundPaidOrderTx(tx, orderId, "admin", adminId));
  if (!r.ok) return { ok: false, reason: r.reason };
  if (r.telegramId != null) {
    const parts = [
      (r.refundedMinor ?? 0) > 0 ? `we've credited <b>${formatMinor(r.refundedMinor ?? 0, (r.currency ?? "USD") as CurrencyCode)}</b> back to your wallet` : "",
      (r.bnplReducedMinor ?? 0) > 0 ? `your Pay Later balance was reduced by the order amount` : "",
    ].filter(Boolean);
    if (parts.length > 0) {
      await enqueueTelegramMessage(r.telegramId, `↩️ <b>Refund issued</b>\nFor order <b>${r.orderNumber}</b>, ${parts.join(" and ")}. Thank you for your patience! 🙏`).catch(() => undefined);
    }
  }
  return { ok: true, refundedMinor: r.refundedMinor, currency: r.currency };
}

/**
 * Refund specific order lines that cannot be delivered (the supplier rejected
 * the order, it is out of stock there, the vendor never sent a key) — at
 * once, to the buyer's WALLET, whatever they paid with. Each line is paid out
 * exactly once (idempotency key per line) and marked refundedAt, so the
 * retry sweep stops trying it. The order closes when nothing is left to
 * deliver: REFUNDED if no line was delivered, PARTIALLY_REFUNDED otherwise.
 */
export async function refundUndeliverableItems(
  orderId: string,
  itemIds: string[],
  reason: string,
): Promise<{ ok: boolean; refundedMinor?: number; currency?: string; telegramId?: bigint | null; orderNumber?: string; names?: string[] }> {
  const r = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    const o = await tx.order.findUnique({ where: { id: orderId }, include: { items: true, user: { select: { id: true, telegramId: true, currency: true } } } });
    if (!o) return { ok: false as const };
    if (["REFUNDED", "PARTIALLY_REFUNDED", "CANCELLED", "EXPIRED", "PENDING_PAYMENT"].includes(o.status)) return { ok: false as const };
    // An order-level refund already happened (any of its keys) — nothing left to pay per line.
    const whole = await tx.walletTransaction.findFirst({ where: { idempotencyKey: { in: [`refund:order:${o.id}`, `refund:stock:${o.id}`, `refund:admin:${o.id}`] } }, select: { id: true } });
    if (whole) return { ok: false as const };
    const targets = o.items.filter((i) => itemIds.includes(i.id) && i.fulfilledAt === null && i.refundedAt === null);
    if (targets.length === 0) return { ok: false as const };
    const paidMinor = o.walletUsedMinor + (o.paidAt !== null ? o.totalMinor : 0);
    const subtotal = o.subtotalMinor > 0 ? o.subtotalMinor : 1;
    const wal = await tx.wallet.findUnique({ where: { userId: o.userId }, select: { currency: true } });
    const creditCur = (wal?.currency ?? o.currency) as Currency;
    let credited = 0;
    let bnplReduced = 0;
    const claimedIds: string[] = [];
    for (const it of targets) {
      // Claim the line FIRST: an admin delivering it at this very moment wins,
      // and then no money moves for it.
      const claim = await tx.orderItem.updateMany({ where: { id: it.id, fulfilledAt: null, refundedAt: null }, data: { refundedAt: new Date() } });
      if (claim.count === 0) continue;
      claimedIds.push(it.id);
      const share = Math.min(1, it.totalMinor / subtotal);
      const minor = Math.round(paidMinor * share);
      const inWallet = creditCur === o.currency ? minor : convertMinor(minor, o.currency as Currency, creditCur);
      if (inWallet > 0) {
        await creditWalletTx(tx, {
          userId: o.userId, amountMinor: BigInt(inWallet), type: "REFUND",
          note: `Auto-refund — could not be delivered: ${it.productNameSnap} (order ${o.orderNumber})`,
          idempotencyKey: `refund:item:${it.id}`, orderId: o.id,
        });
        credited += inWallet;
      }
      if (o.bnplMinor > 0) {
        const owe = Math.round(o.bnplMinor * share);
        const userCur = o.user.currency as Currency;
        bnplReduced += userCur === o.currency ? owe : convertMinor(owe, o.currency as Currency, userCur);
      }
      await tx.commissionEntry.updateMany({ where: { orderItemId: it.id, releasedAt: null, clawedBackAt: null }, data: { clawedBackAt: new Date() } });
    }
    if (claimedIds.length === 0) return { ok: false as const };
    if (bnplReduced > 0) {
      const u = await tx.user.findUnique({ where: { id: o.userId }, select: { bnplOutstandingMinor: true } });
      await tx.user.update({ where: { id: o.userId }, data: { bnplOutstandingMinor: Math.max(0, (u?.bnplOutstandingMinor ?? 0) - bnplReduced) } });
    }
    // Close the order once nothing is left to deliver.
    const now = await tx.orderItem.findMany({ where: { orderId: o.id }, select: { fulfilledAt: true, refundedAt: true } });
    const pending = now.filter((i) => i.fulfilledAt === null && i.refundedAt === null);
    const delivered = now.filter((i) => i.fulfilledAt !== null);
    if (pending.length === 0) {
      const allRefunded = delivered.length === 0;
      await tx.order.update({ where: { id: o.id }, data: allRefunded ? { status: "REFUNDED", cancelledAt: new Date() } : { status: "PARTIALLY_REFUNDED" } });
      if (allRefunded) await tx.referralReward.updateMany({ where: { orderId: o.id, status: "PENDING_HOLD" }, data: { status: "WITHHELD", withheldReason: "order refunded" } });
    }
    await tx.auditLog.create({ data: { actorType: "SYSTEM", action: "order.refund.undeliverable", entityType: "Order", entityId: o.id, after: { items: claimedIds, credited, creditCur, bnplReduced, reason: reason.slice(0, 200) } } });
    return { ok: true as const, refundedMinor: credited, currency: creditCur as string, telegramId: o.user.telegramId, orderNumber: o.orderNumber, names: targets.filter((t) => claimedIds.includes(t.id)).map((t) => t.productNameSnap), bnplReduced };
  });
  if (!r.ok) return { ok: false };
  if (r.telegramId != null) {
    const names = [...new Set(r.names)].slice(0, 3).join(", ");
    const parts = [
      (r.refundedMinor ?? 0) > 0 ? `<b>${formatMinor(r.refundedMinor ?? 0, (r.currency ?? "USD") as CurrencyCode)}</b> is back in your 💰 wallet` : "",
      (r.bnplReduced ?? 0) > 0 ? "your Pay Later balance was reduced" : "",
    ].filter(Boolean);
    await enqueueTelegramMessage(
      r.telegramId,
      [
        `↩️ <b>Order cancelled &amp; refunded</b>`,
        "",
        `📦 ${names.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")} — couldn't be delivered (our supplier is out of stock or unavailable right now).`,
        `🧾 Order <code>${r.orderNumber}</code>`,
        parts.length > 0 ? `✅ ${parts.join(" and ")} — instantly, use it on your next order.` : "",
        "",
        "We're sorry for the trouble! 🙏",
      ].filter(Boolean).join("\n"),
    ).catch(() => undefined);
  }
  return { ok: true, refundedMinor: r.refundedMinor, currency: r.currency, telegramId: r.telegramId, orderNumber: r.orderNumber, names: r.names };
}
