import { loadConfig } from "@gis/config";
import { prisma, type Currency } from "@gis/database";
import { CoreError } from "@gis/shared";
import { adjustWallet } from "./wallet.service.js";
import { fetchPayTransactions } from "../orders/binance-poll.service.js";

function toUsdt(amountMinor: number, currency: Currency): string {
  const cfg = loadConfig();
  const rate = currency === "INR" ? cfg.BINANCE_USDT_INR_RATE : cfg.BINANCE_USDT_USD_RATE;
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

  if (!cfg.BINANCE_API_KEY || !cfg.BINANCE_API_SECRET) return { ok: false, reason: "NO_API" };

  let txns;
  try {
    txns = await fetchPayTransactions(cfg.BINANCE_API_KEY, cfg.BINANCE_API_SECRET);
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

  const newBalanceMinor = await adjustWallet({
    userId: topup.userId,
    amountMinor: BigInt(topup.amountMinor),
    type: "DEPOSIT",
    note: `Binance top-up (txn ${clean})`,
    idempotencyKey: `topup:${topup.id}`,
  });
  await prisma.walletTopup.update({ where: { id: topup.id }, data: { status: "CREDITED", creditedAt: new Date() } });
  return { ok: true, newBalanceMinor, amountMinor: topup.amountMinor, currency: topup.currency };
}
