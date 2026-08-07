import { prisma } from "@gis/database";
import { getRedis } from "./redis.js";
import { UPI_UTR_GRACE_MIN } from "./orders/binance-window.js";
import { getUpiProvider } from "./upi-provider.service.js";

/**
 * UPI UTR reuse protection.
 *
 * A UTR (RRN) identifies exactly one UPI payment. The top-up flow used to
 * accept any 6+ character string, store it nowhere, and never check it against
 * previous submissions — so the same reference could be sent repeatedly, each
 * submission raising a fresh approval request that credited the wallet again.
 *
 * Two layers:
 *  - PENDING claims live in Redis, so a UTR awaiting approval is rejected at
 *    the door rather than queueing up duplicate requests for the admin.
 *  - SETTLED references are recorded as WalletTransaction.idempotencyKey, which
 *    is @unique. That is the durable guarantee: even if Redis is wiped, a UTR
 *    that has already credited a wallet can never credit another.
 */
export const upiUtrKey = (utr: string): string => `upi:${utr}`;

const PENDING_PREFIX = "upiutr:pending:";
/** Long enough to cover any realistic manual-approval delay. */
const PENDING_TTL_SEC = 14 * 24 * 3600;

/** Has this UTR already credited a wallet, or is one awaiting approval? */
export async function hasUpiUtrBeenUsed(utr: string): Promise<boolean> {
  const settled = await prisma.walletTransaction.findFirst({
    where: { idempotencyKey: upiUtrKey(utr) },
    select: { id: true },
  });
  if (settled) return true;
  try {
    return (await getRedis().get(`${PENDING_PREFIX}${utr}`)) !== null;
  } catch {
    // Redis down: fall back to the durable check alone rather than blocking
    // every customer. The @unique key still prevents a double credit.
    return false;
  }
}

/** Mark a UTR as awaiting admin approval. */
export async function markUpiUtrPending(utr: string): Promise<void> {
  try {
    await getRedis().set(`${PENDING_PREFIX}${utr}`, "1", "EX", PENDING_TTL_SEC);
  } catch { /* best effort */ }
}

/** Release a pending claim when an admin rejects the payment. */
export async function clearUpiUtrPending(utr: string): Promise<void> {
  try {
    await getRedis().del(`${PENDING_PREFIX}${utr}`);
  } catch { /* best effort */ }
}

export type UpiClaim =
  | { ok: true }
  | { ok: false; reason: "ALREADY_USED" | "ORDER_NOT_PENDING" };

/**
 * Atomically bind a UTR to an order.
 *
 * Order.binanceTxnId is "the transaction that settled this order" and is
 * @unique, so storing "upi:<utr>" there gives a DATABASE-level guarantee that
 * one UPI payment settles exactly one order — the same protection Binance
 * payments already had. The order UTR handler previously accepted any 6+
 * character string with no reuse check at all, so one reference could be
 * pasted into an unlimited number of orders.
 *
 * The updateMany IS the claim: it only matches while the order is still unpaid
 * and unclaimed, so two submissions racing cannot both win.
 */
export async function claimUpiUtrForOrder(orderId: string, utr: string): Promise<UpiClaim> {
  const key = upiUtrKey(utr);
  if (await hasUpiUtrBeenUsed(utr)) return { ok: false, reason: "ALREADY_USED" };
  const usedByOrder = await prisma.order.findFirst({ where: { binanceTxnId: key }, select: { id: true } });
  if (usedByOrder) return { ok: false, reason: "ALREADY_USED" };
  try {
    let claimed = await prisma.order.updateMany({
      where: { id: orderId, status: "PENDING_PAYMENT", binanceTxnId: null },
      data: { binanceTxnId: key },
    });
    if (claimed.count === 0) {
      // The session closed while they were fetching the reference. Someone who
      // actually paid must not be told their order vanished — revive it inside
      // the grace period and let the operator decide. Nothing is released here.
      const graceFrom = new Date(Date.now() - UPI_UTR_GRACE_MIN * 60_000);
      claimed = await prisma.order.updateMany({
        where: { id: orderId, status: "EXPIRED", binanceTxnId: null, expiresAt: { gte: graceFrom } },
        data: { binanceTxnId: key, status: "PENDING_PAYMENT" },
      });
    }
    if (claimed.count === 0) return { ok: false, reason: "ORDER_NOT_PENDING" };
  } catch (e) {
    // Unique violation: another order claimed this reference first.
    if ((e as { code?: string })?.code === "P2002") return { ok: false, reason: "ALREADY_USED" };
    throw e;
  }
  await markUpiUtrPending(utr);
  return { ok: true };
}

const AUTO_KEY = "upi.auto_approve";
const AUTO_CAP_KEY = "upi.auto_approve_max_minor";

export interface UpiAutoPolicy {
  enabled: boolean;
  /** Orders above this (minor units, order currency) always go to a human. */
  maxMinor: number;
  /** A customer's first order is never auto-delivered. */
  requirePriorOrder: boolean;
}

export async function getUpiAutoPolicy(): Promise<UpiAutoPolicy> {
  try {
    const [on, cap] = await Promise.all([
      prisma.setting.findUnique({ where: { key: AUTO_KEY } }),
      prisma.setting.findUnique({ where: { key: AUTO_CAP_KEY } }),
    ]);
    const raw = on?.value as unknown;
    const enabled = typeof raw === "boolean" ? raw : (raw as { on?: boolean } | null)?.on === true;
    const maxMinor = Number((cap?.value as { minor?: number } | null)?.minor ?? 50_000);
    return { enabled, maxMinor: Number.isFinite(maxMinor) && maxMinor > 0 ? maxMinor : 50_000, requirePriorOrder: true };
  } catch {
    // Any lookup failure means manual review — never auto-deliver by accident.
    return { enabled: false, maxMinor: 0, requirePriorOrder: true };
  }
}

export async function setUpiAutoApprove(enabled: boolean, maxMinor?: number): Promise<UpiAutoPolicy> {
  await prisma.setting.upsert({ where: { key: AUTO_KEY }, create: { key: AUTO_KEY, value: { on: enabled } }, update: { value: { on: enabled } } });
  if (maxMinor !== undefined && maxMinor > 0) {
    await prisma.setting.upsert({
      where: { key: AUTO_CAP_KEY },
      create: { key: AUTO_CAP_KEY, value: { minor: Math.round(maxMinor) } },
      update: { value: { minor: Math.round(maxMinor) } },
    });
  }
  return getUpiAutoPolicy();
}

export type AutoDecision =
  | { auto: true }
  | { auto: false; reason: "DISABLED" | "OVER_CAP" | "FIRST_ORDER" | "UNVERIFIED" | "CREDIT_USED" | "AMOUNT_MISMATCH" | "CREDIT_TOO_OLD" };

/**
 * Decide whether a claimed UTR may release goods without a human.
 *
 * Nothing here proves money arrived — BharatPe exposes no API to ask. What it
 * does prove is that the reference is well formed, has never settled anything
 * else, and belongs to exactly one order inside its payment window. Auto-
 * delivery is therefore bounded: small orders only, and never a customer's
 * first, because that is the combination a stranger typing twelve digits would
 * exploit. Everything above the line still goes to the operator.
 */
export async function shouldAutoDeliverUpi(orderId: string, utr?: string): Promise<AutoDecision> {
  const policy = await getUpiAutoPolicy();
  if (!policy.enabled) return { auto: false, reason: "DISABLED" };
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { userId: true, totalMinor: true, createdAt: true },
  });
  if (!order) return { auto: false, reason: "DISABLED" };

  // ── Proof of payment ──
  // A UTR typed by a customer proves nothing on its own. When a provider is
  // configured, goods are only released if a credit READ FROM THE MERCHANT
  // ACCOUNT carries that same reference, for the right amount, arriving after
  // the order was placed, and has not already settled something else.
  const provider = await getUpiProvider();
  if (provider) {
    if (!utr) return { auto: false, reason: "UNVERIFIED" };
    const credit = await prisma.upiCredit.findUnique({ where: { utr } });
    if (!credit) return { auto: false, reason: "UNVERIFIED" };
    if (credit.orderId && credit.orderId !== orderId) return { auto: false, reason: "CREDIT_USED" };
    if (credit.amountMinor !== order.totalMinor) return { auto: false, reason: "AMOUNT_MISMATCH" };
    if (credit.creditedAt.getTime() < order.createdAt.getTime() - 2 * 60_000) return { auto: false, reason: "CREDIT_TOO_OLD" };
    // Bind the credit to this order. updateMany with orderId still null IS the
    // claim, so two orders cannot both consume one payment.
    const bound = await prisma.upiCredit.updateMany({
      where: { utr, orderId: null },
      data: { orderId, matchedAt: new Date() },
    });
    if (bound.count === 0) return { auto: false, reason: "CREDIT_USED" };
    // Payment proven. The caps below are belt-and-braces and no longer the only
    // thing standing between a stranger and free stock, so they do not apply.
    return { auto: true };
  }

  // No provider configured: nothing can confirm the money arrived, so the
  // bounded-trust limits are all there is.
  if (order.totalMinor > policy.maxMinor) return { auto: false, reason: "OVER_CAP" };
  if (policy.requirePriorOrder) {
    const prior = await prisma.order.count({
      where: { userId: order.userId, id: { not: orderId }, status: { in: ["PAID", "COMPLETED"] } },
    });
    if (prior === 0) return { auto: false, reason: "FIRST_ORDER" };
  }
  return { auto: true };
}
