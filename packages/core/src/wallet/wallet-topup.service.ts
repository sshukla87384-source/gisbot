import { loadConfig } from "@gis/config";
import { prisma, type Currency } from "@gis/database";
import { CoreError } from "@gis/shared";
import { enqueueAdminAlert } from "../queues.js";
import { formatMinor, type CurrencyCode } from "@gis/shared";
import { adjustWallet } from "./wallet.service.js";
import { fetchPayTransactions, getBinanceCreds } from "../orders/binance-poll.service.js";
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
  | { ok: false; reason: "NOT_FOUND" | "AMOUNT_MISMATCH" | "ALREADY_USED" | "NO_API" | "NOT_PENDING" | "WRONG_USER" };

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
  if (Math.abs(parseFloat(txn.amount) - parseFloat(topup.binanceAmount)) >= 0.01) return { ok: false, reason: "AMOUNT_MISMATCH" };

  const claimed = await prisma.walletTopup.updateMany({
    where: { id: topupId, status: "PENDING" },
    data: { binanceTxnId: clean },
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
    note: `Binance top-up (txn ${clean})`,
    // Keyed on the TRANSACTION, not the top-up row: the same Binance txn must
    // never credit twice even via two different pending top-ups.
    idempotencyKey: `topup-txn:${clean}`,
  });
  await prisma.walletTopup.update({ where: { id: topup.id }, data: { status: "CREDITED", creditedAt: new Date() } });
  const tu = await prisma.user.findUnique({ where: { id: topup.userId }, select: { telegramHandle: true, firstName: true, telegramId: true, currency: true } });
  if (tu) await notifyTopupToAdmins(tu, topup.amountMinor, "Binance top-up", clean, newBalanceMinor);
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
      binanceAmount: usdt.toFixed(2), binanceTxnId: clean, status: "CREDITED",
      creditedAt: new Date(), expiresAt: new Date(),
    },
  });
  const newBalanceMinor = await adjustWallet({
    userId, amountMinor: BigInt(creditMinor), type: "DEPOSIT",
    // Key on the TRANSACTION, so two concurrent submissions of the same
    // Binance id can never both credit (each call makes its own topup row).
    note: `Binance deposit (txn ${clean})`, idempotencyKey: `topup-txn:${clean}`,
  });
  await notifyTopupToAdmins({ ...user, currency: walletCur }, creditMinor, `Binance ${usdt.toFixed(2)} USDT`, clean, newBalanceMinor);
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
