import { prisma } from "@gis/database";
import { getRedis } from "./redis.js";

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
    const claimed = await prisma.order.updateMany({
      where: { id: orderId, status: "PENDING_PAYMENT", binanceTxnId: null },
      data: { binanceTxnId: key },
    });
    if (claimed.count === 0) return { ok: false, reason: "ORDER_NOT_PENDING" };
  } catch (e) {
    // Unique violation: another order claimed this reference first.
    if ((e as { code?: string })?.code === "P2002") return { ok: false, reason: "ALREADY_USED" };
    throw e;
  }
  await markUpiUtrPending(utr);
  return { ok: true };
}
