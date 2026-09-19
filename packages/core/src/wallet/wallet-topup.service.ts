import { loadConfig } from "@gis/config";
import { prisma, type Currency } from "@gis/database";
import { CoreError } from "@gis/shared";
import { enqueueAdminAlert } from "../queues.js";
import { getRedis } from "../redis.js";
import { formatMinor, type CurrencyCode } from "@gis/shared";
import { adjustWallet } from "./wallet.service.js";
import { CLOCK_SKEW_MS, fetchPayTransactions, getBinanceCreds } from "../orders/binance-poll.service.js";
import { convertMinor, usdtRate } from "../fx.js";

function toUsdt(amountMinor: number, currency: Currency): string {
  const cfg = loadConfig();
  const rate = usdtRate(currency);
  return (amountMinor / 100 / rate).toFixed(2);
}

export interface TopupResult {
  id: string;
  amountMinor: number;
  currency: Currency;
  binanceAsset: string;
  binanceAmount: string;
  binanceUid: string;
}

/** Create a pending Binance wallet top-up (60-min window). */
export async function createWalletTopup(userId: string, amountMinor: number): Promise<TopupResult> {
  const cfg = loadConfig();
  const uid = cfg.BINANCE_PAY_UID;
  if (!uid) throw new CoreError("VALIDATION_FAILED", "Binance top-up is not configured");
  if (!Number.isFinite(amountMinor) || amountMinor < 100) throw new CoreError("VALIDATION_FAILED", "Minimum top-up is 1.");
  amountMinor = Math.round(amountMinor);
  if (amountMinor > 100_000_00) throw new CoreError("VALIDATION_FAILED", "That top-up is too large — please contact support.");

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const usdt = toUsdt(amountMinor, user.currency);
  const topup = await prisma.walletTopup.create({
    data: {
      userId,
      amountMinor,
      currency: user.currency,
      binanceAsset: "USDT",
      binanceAmount: usdt,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
  });
  return { id: topup.id, amountMinor, currency: user.currency, binanceAsset: "USDT", binanceAmount: usdt, binanceUid: uid };
}

export type TopupVerify =
  | { ok: true; newBalanceMinor: bigint; amountMinor: number; currency: string }
  | { ok: false; reason: "NOT_FOUND" | "AMOUNT_MISMATCH" | "ALREADY_USED" | "NO_API" | "NOT_PENDING" | "WRONG_USER" | "DAILY_LIMIT" };

/**
 * Free-amount deposits have no ownership guard by design — whoever quotes a
 * transaction id gets the credit — so one account can only be allowed to claim
 * so many of them in a day. Same shape as the referral nudge's counter: one
 * Redis key per user per day, self-cleaning, and a Redis outage never blocks a
 * genuine deposit.
 */
export const FREE_TOPUP_DAILY_CAP = 10;

const freeTopupKey = (userId: string): string => `freetopup:${userId}:${new Date().toISOString().slice(0, 10)}`;

async function freeTopupClaimsToday(userId: string): Promise<number> {
  try {
    const n = Number(await getRedis().get(freeTopupKey(userId)));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0; // Redis unavailable — never refuse real money over housekeeping
  }
}

/** Counted only once the credit actually landed, so a typo costs nobody a claim. */
async function noteFreeTopupClaim(userId: string): Promise<void> {
  try {
    const redis = getRedis();
    const k = freeTopupKey(userId);
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, 172_800);
  } catch { /* housekeeping only */ }
}

/** Verify a Binance transaction ID against a pending top-up and credit the wallet. */
export async function verifyTopupByTxn(topupId: string, txnId: string, expectedUserId?: string): Promise<TopupVerify> {
  const cfg = loadConfig();
  const topup = await prisma.walletTopup.findUnique({ where: { id: topupId } });
  if (!topup) return { ok: false, reason: "NOT_FOUND" };
  if (expectedUserId && topup.userId !== expectedUserId) return { ok: false, reason: "WRONG_USER" };
  if (topup.status !== "PENDING") return { ok: false, reason: "NOT_PENDING" };

  const clean = txnId.trim();
  const [dupTopup, dupOrder] = await Promise.all([
    prisma.walletTopup.findFirst({ where: { binanceTxnId: clean }, select: { id: true } }),
    prisma.order.findFirst({ where: { binanceTxnId: clean }, select: { id: true } }),
  ]);
  if (dupTopup || dupOrder) return { ok: false, reason: "ALREADY_USED" };

  const creds = await getBinanceCreds();
  if (!creds) return { ok: false, reason: "NO_API" };

  let txns;
  try {
    txns = await fetchPayTransactions(creds.key, creds.secret);
  } catch {
    return { ok: false, reason: "NOT_FOUND" };
  }
  const txn = txns.find((t) => String(t.transactionId) === clean || String(t.orderId ?? "") === clean);
  if (!txn || txn.currency !== "USDT" || parseFloat(txn.amount) <= 0) return { ok: false, reason: "NOT_FOUND" };
  // A credit can only fund a top-up that already existed when it arrived — the
  // same guard the order poller relies on. Without it any unclaimed credit of a
  // matching size, however old, could be harvested by anyone who asks for a
  // top-up of that amount.
  const txnTime = Number(txn.transactionTime);
  if (!Number.isFinite(txnTime) || txnTime <= 0) return { ok: false, reason: "NOT_FOUND" };
  if (txnTime < topup.createdAt.getTime() - CLOCK_SKEW_MS) return { ok: false, reason: "NOT_FOUND" };
  if (Math.abs(parseFloat(txn.amount) - parseFloat(topup.binanceAmount)) >= 0.01) return { ok: false, reason: "AMOUNT_MISMATCH" };

  // Dedupe and claim on the CANONICAL transaction id. One payment carries TWO
  // references — its transactionId and the Order ID shown to the customer — so
  // keying on whatever was pasted let the same money be submitted twice, once
  // under each reference, and credit twice.
  const ref = String(txn.transactionId);
  if (ref !== clean) {
    const [refTopup, refOrder] = await Promise.all([
      prisma.walletTopup.findFirst({ where: { binanceTxnId: ref }, select: { id: true } }),
      prisma.order.findFirst({ where: { binanceTxnId: ref }, select: { id: true } }),
    ]);
    if (refTopup || refOrder) return { ok: false, reason: "ALREADY_USED" };
  }

  const claimed = await prisma.walletTopup.updateMany({
    where: { id: topupId, status: "PENDING" },
    data: { binanceTxnId: ref },
  });
  if (claimed.count === 0) return { ok: false, reason: "NOT_PENDING" };

  // The top-up is denominated in the USER's currency; the wallet has its OWN,
  // and setUserCurrency never changed the wallet's. Crediting the raw number
  // put 50000 INR-minor into a USD wallet as $500 for a 5 USDT payment.
  // Convert exactly (no price surcharge — this is money received).
  const wal = await prisma.wallet.findUnique({ where: { userId: topup.userId }, select: { currency: true } });
  const creditMinor = wal && wal.currency !== topup.currency
    ? convertMinor(topup.amountMinor, topup.currency as Currency, wal.currency as Currency)
    : topup.amountMinor;

  const newBalanceMinor = await adjustWallet({
    userId: topup.userId,
    amountMinor: BigInt(creditMinor),
    type: "DEPOSIT",
    note: `Binance top-up (txn ${ref})`,
    // Keyed on the TRANSACTION, not the top-up row: the same Binance txn must
    // never credit twice even via two different pending top-ups.
    idempotencyKey: `topup-txn:${ref}`,
  });
  await prisma.walletTopup.update({ where: { id: topup.id }, data: { status: "CREDITED", creditedAt: new Date() } });
  const tu = await prisma.user.findUnique({ where: { id: topup.userId }, select: { telegramHandle: true, firstName: true, telegramId: true, currency: true } });
  if (tu) await notifyTopupToAdmins(tu, topup.amountMinor, "Binance top-up", ref, newBalanceMinor);
  return { ok: true, newBalanceMinor, amountMinor: topup.amountMinor, currency: topup.currency };
}

/**
 * FREE-AMOUNT deposit: the customer sends any USDT amount to the UID, then
 * submits their Binance Order ID. We look it up, read the ACTUAL amount paid,
 * convert to the user's wallet currency, and credit it. Dedup by transaction.
 */
export async function creditFreeTopup(userId: string, txnId: string): Promise<TopupVerify> {
  const cfg = loadConfig();
  const creds = await getBinanceCreds();
  if (!creds) return { ok: false, reason: "NO_API" };
  // Checked before the Binance round trip, so a capped account cannot keep the
  // API busy either.
  if (await freeTopupClaimsToday(userId) >= FREE_TOPUP_DAILY_CAP) return { ok: false, reason: "DAILY_LIMIT" };
  const clean = txnId.trim();
  const [dupTopup, dupOrder] = await Promise.all([
    prisma.walletTopup.findFirst({ where: { binanceTxnId: clean }, select: { id: true } }),
    prisma.order.findFirst({ where: { binanceTxnId: clean }, select: { id: true } }),
  ]);
  if (dupTopup || dupOrder) return { ok: false, reason: "ALREADY_USED" };

  let txns;
  try {
    txns = await fetchPayTransactions(creds.key, creds.secret);
  } catch {
    return { ok: false, reason: "NOT_FOUND" };
  }
  const txn = txns.find((t) => String(t.transactionId) === clean || String(t.orderId ?? "") === clean);
  if (!txn || txn.currency !== "USDT" || Math.abs(parseFloat(txn.amount)) <= 0) return { ok: false, reason: "NOT_FOUND" };

  // Only INCOMING credits may fund a wallet. Math.abs() previously let a
  // customer paste an OUTGOING payout id and get credited for it.
  const signed = parseFloat(txn.amount);
  if (!(signed > 0)) return { ok: false, reason: "NOT_FOUND" };
  const usdt = signed;
  // Dedupe and record against the CANONICAL transaction id. One payment carries
  // two references — its transactionId and the customer-facing Order ID — so
  // keying on whichever was pasted let the same deposit be claimed twice, once
  // under each reference.
  const ref = String(txn.transactionId);
  if (ref !== clean) {
    const [refTopup, refOrder] = await Promise.all([
      prisma.walletTopup.findFirst({ where: { binanceTxnId: ref }, select: { id: true } }),
      prisma.order.findFirst({ where: { binanceTxnId: ref }, select: { id: true } }),
    ]);
    if (refTopup || refOrder) return { ok: false, reason: "ALREADY_USED" };
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  // Credit in the WALLET's currency, not the user's display currency — they
  // differ the moment someone switches to INR, and crediting INR-scaled minor
  // units into a USD wallet multiplied every deposit by the FX rate.
  const wallet = await prisma.wallet.findUnique({ where: { userId }, select: { currency: true } });
  const walletCur = (wallet?.currency ?? "USD") as "USD" | "INR";
  const creditMinor = walletCur === "USD"
    ? Math.round(usdt * 100)
    : Math.round(usdt * usdtRate("INR") * 100);

  const topup = await prisma.walletTopup.create({
    data: {
      userId, amountMinor: creditMinor, currency: walletCur, binanceAsset: "USDT",
      binanceAmount: usdt.toFixed(2), binanceTxnId: ref, status: "CREDITED",
      creditedAt: new Date(), expiresAt: new Date(),
    },
  });
  const newBalanceMinor = await adjustWallet({
    userId, amountMinor: BigInt(creditMinor), type: "DEPOSIT",
    // Key on the TRANSACTION, so two concurrent submissions of the same
    // Binance id can never both credit (each call makes its own topup row).
    note: `Binance deposit (txn ${ref})`, idempotencyKey: `topup-txn:${ref}`,
  });
  await noteFreeTopupClaim(userId);
  await notifyTopupToAdmins({ ...user, currency: walletCur }, creditMinor, `Binance ${usdt.toFixed(2)} USDT`, ref, newBalanceMinor);
  return { ok: true, newBalanceMinor, amountMinor: creditMinor, currency: walletCur };
}

/** Tell admins whenever a customer's wallet is topped up. */
export async function notifyTopupToAdmins(
  user: { telegramHandle?: string | null; firstName?: string | null; telegramId?: bigint | null; currency: string },
  amountMinor: number,
  method: string,
  reference: string,
  newBalanceMinor?: bigint | number,
): Promise<void> {
  const who = user.telegramHandle ? `@${user.telegramHandle}` : (user.firstName ?? "customer");
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  await enqueueAdminAlert(
    [
      "💰 <b>Wallet topped up</b>",
      `👤 ${esc(who)}`,
      `🆔 <code>${user.telegramId ?? "—"}</code>`,
      `➕ Added: <b>${formatMinor(amountMinor, user.currency as CurrencyCode)}</b>`,
      newBalanceMinor !== undefined ? `💳 New balance: <b>${formatMinor(Number(newBalanceMinor), user.currency as CurrencyCode)}</b>` : "",
      `🏦 Via: ${esc(method)}`,
      reference ? `🧾 Ref: <code>${esc(reference)}</code>` : "",
    ].filter(Boolean).join("\n"),
  ).catch(() => undefined);
}
