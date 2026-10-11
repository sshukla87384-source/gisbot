import { prisma, type Currency, type WalletTxType } from "@gis/database";
import { CoreError } from "@gis/shared";
import { convertMinor } from "../fx.js";
import { releaseCouponForOrderTx } from "../orders/coupon.service.js";

export interface WalletSummary {
  walletId: string;
  balanceMinor: bigint;
  currency: Currency;
}

export interface LedgerEntry {
  type: WalletTxType;
  amountMinor: bigint;
  balanceAfterMinor: bigint;
  /** The currency THIS row was written in — a wallet that switched INR↔USD has rows in both. */
  currency: Currency;
  note: string | null;
  createdAt: Date;
}

export async function getWallet(userId: string): Promise<WalletSummary> {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) throw new CoreError("WALLET_NOT_FOUND");
  return { walletId: wallet.id, balanceMinor: wallet.balanceMinor, currency: wallet.currency };
}

export async function getLedger(userId: string, page: number, pageSize = 8): Promise<{
  entries: LedgerEntry[];
  page: number;
  pages: number;
}> {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) throw new CoreError("WALLET_NOT_FOUND");
  const total = await prisma.walletTransaction.count({ where: { walletId: wallet.id } });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const rows = await prisma.walletTransaction.findMany({
    where: { walletId: wallet.id },
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
  return {
    entries: rows.map((r) => ({
      type: r.type,
      amountMinor: r.amountMinor,
      balanceAfterMinor: r.balanceAfterMinor,
      currency: r.currency,
      note: r.referenceNote,
      createdAt: r.createdAt,
    })),
    page,
    pages,
  };
}

/**
 * Serialized wallet mutation (PRD §6.3): row-locks the wallet, appends a ledger
 * entry, updates the cached balance. Used by admin adjustments and the dev top-up.
 */
export async function adjustWallet(opts: {
  userId: string;
  amountMinor: bigint;
  type: WalletTxType;
  note?: string;
  actorId?: string;
  idempotencyKey?: string;
  /** An admin deduction must not push a wallet below zero (ADJUSTMENT otherwise may). */
  floorZero?: boolean;
}): Promise<bigint> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; balanceMinor: bigint }>>`
      SELECT "id", "balanceMinor" FROM "Wallet" WHERE "userId" = ${opts.userId} FOR UPDATE`;
    const wallet = locked[0];
    if (!wallet) throw new CoreError("WALLET_NOT_FOUND");

    const newBalance = wallet.balanceMinor + opts.amountMinor;
    if (newBalance < 0n && (opts.type !== "ADJUSTMENT" || (opts.floorZero && opts.amountMinor < 0n))) throw new CoreError("INSUFFICIENT_BALANCE");

    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: opts.type,
        amountMinor: opts.amountMinor,
        balanceAfterMinor: newBalance,
        currency: (await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } })).currency,
        referenceNote: opts.note,
        actorId: opts.actorId,
        idempotencyKey: opts.idempotencyKey,
      },
    });
    await tx.wallet.update({ where: { id: wallet.id }, data: { balanceMinor: newBalance } });
    return newBalance;
  });
}

type WTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Credit (or debit) a wallet INSIDE the caller's transaction — so a status flip
 * and the money move together or not at all. Locks the wallet row, writes the
 * ledger line and the balance. Returns the new balance and the wallet currency.
 */
export async function creditWalletTx(
  tx: WTx,
  opts: { userId: string; amountMinor: bigint; type: WalletTxType; note?: string; idempotencyKey?: string; orderId?: string },
): Promise<{ balance: bigint; currency: Currency }> {
  const locked = await tx.$queryRaw<Array<{ id: string; balanceMinor: bigint; currency: Currency }>>`
    SELECT "id", "balanceMinor", "currency" FROM "Wallet" WHERE "userId" = ${opts.userId} FOR UPDATE`;
  const w = locked[0];
  if (!w) throw new CoreError("WALLET_NOT_FOUND");
  const balance = w.balanceMinor + opts.amountMinor;
  if (balance < 0n && opts.type !== "ADJUSTMENT") throw new CoreError("INSUFFICIENT_BALANCE");
  await tx.walletTransaction.create({
    data: { walletId: w.id, type: opts.type, amountMinor: opts.amountMinor, balanceAfterMinor: balance, currency: w.currency, referenceNote: opts.note, idempotencyKey: opts.idempotencyKey, orderId: opts.orderId },
  });
  await tx.wallet.update({ where: { id: w.id }, data: { balanceMinor: balance } });
  return { balance, currency: w.currency };
}

/**
 * Expire an unpaid order and refund the wallet money applied to it — only if it
 * is still unpaid once its row is locked (see closeUnpaidOrderTx).
 */
export async function refundWalletForOrder(
  _userId: string,
  orderId: string,
  _orderNumber: string,
  amountMinor: number,
): Promise<boolean> {
  if (!amountMinor || amountMinor <= 0) return false;
  const { closeUnpaidOrderTx } = await import("../orders/manual-pay.service.js");
  return prisma.$transaction((tx) => closeUnpaidOrderTx(tx, orderId, "EXPIRED", "expired"));
}


export interface WalletMismatch { walletId: string; userId: string; label: string; currency: Currency; cachedMinor: number; ledgerMinor: number; diffMinor: number }

/**
 * Wallets whose stored balance is not the sum of their ledger. The usual
 * cause was a currency switch before it was recorded in the ledger (the
 * balance was converted, the history was not); anything else is worth a look.
 */
export async function findWalletMismatches(limit = 50): Promise<WalletMismatch[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string; userId: string; currency: Currency; cached: bigint; actual: bigint | null }>>`
    SELECT w."id", w."userId", w."currency", w."balanceMinor" AS "cached", SUM(t."amountMinor") AS "actual"
    FROM "Wallet" w
    LEFT JOIN "WalletTransaction" t ON t."walletId" = w."id"
    GROUP BY w."id", w."userId", w."currency", w."balanceMinor"
    HAVING w."balanceMinor" <> COALESCE(SUM(t."amountMinor"), 0)
    LIMIT ${limit}`;
  if (rows.length === 0) return [];
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, telegramHandle: true, firstName: true, telegramId: true } });
  return rows.map((r) => {
    const u = users.find((x) => x.id === r.userId);
    const cached = Number(r.cached);
    const ledger = Number(r.actual ?? 0n);
    return {
      walletId: r.id, userId: r.userId, currency: r.currency, cachedMinor: cached, ledgerMinor: ledger, diffMinor: cached - ledger,
      label: u?.telegramHandle ? `@${u.telegramHandle}` : (u?.firstName ?? (u?.telegramId ? String(u.telegramId) : r.userId.slice(-6))),
    };
  });
}

/**
 * Bring a wallet's ledger in line with its balance by posting the difference
 * as one ADJUSTMENT row. The balance the customer sees does not change — the
 * history just gets the entry it was missing.
 */
export async function repairWalletLedger(walletId: string, actorId?: string): Promise<{ repaired: boolean; diffMinor: number }> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; balanceMinor: bigint; currency: Currency }>>`
      SELECT "id", "balanceMinor", "currency" FROM "Wallet" WHERE "id" = ${walletId} FOR UPDATE`;
    const w = locked[0];
    if (!w) return { repaired: false, diffMinor: 0 };
    const sum = await tx.walletTransaction.aggregate({ where: { walletId }, _sum: { amountMinor: true } });
    const diff = w.balanceMinor - (sum._sum.amountMinor ?? 0n);
    if (diff === 0n) return { repaired: false, diffMinor: 0 };
    await tx.walletTransaction.create({
      data: { walletId, type: "ADJUSTMENT", amountMinor: diff, balanceAfterMinor: w.balanceMinor, currency: w.currency, referenceNote: "ledger repair (reconciliation)", actorId },
    });
    return { repaired: true, diffMinor: Number(diff) };
  });
}
