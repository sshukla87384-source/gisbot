import { prisma, type Currency, type WalletTxType } from "@gis/database";
import { CoreError } from "@gis/shared";

export interface WalletSummary {
  walletId: string;
  balanceMinor: bigint;
  currency: Currency;
}

export interface LedgerEntry {
  type: WalletTxType;
  amountMinor: bigint;
  balanceAfterMinor: bigint;
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
}): Promise<bigint> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; balanceMinor: bigint }>>`
      SELECT "id", "balanceMinor" FROM "Wallet" WHERE "userId" = ${opts.userId} FOR UPDATE`;
    const wallet = locked[0];
    if (!wallet) throw new CoreError("WALLET_NOT_FOUND");

    const newBalance = wallet.balanceMinor + opts.amountMinor;
    if (newBalance < 0n && opts.type !== "ADJUSTMENT") throw new CoreError("INSUFFICIENT_BALANCE");

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

/**
 * Refund wallet money that was applied to an order which is being cancelled or
 * expired, then mark the order so it can never be refunded twice. Idempotent
 * via the wallet ledger's unique idempotency key.
 */
export async function refundWalletForOrder(
  userId: string,
  orderId: string,
  orderNumber: string,
  amountMinor: number,
): Promise<boolean> {
  if (!amountMinor || amountMinor <= 0) return false;
  return prisma.$transaction(async (tx) => {
    // SELECT ... FOR UPDATE, not findUnique. This writes an ABSOLUTE balance, so
    // an unlocked read lets a concurrent checkout or top-up interleave: both read
    // the same balance, both write their own total, and one movement vanishes.
    // adjustWallet and applyWalletTx already lock; this refund path did not.
    const locked = await tx.$queryRaw<Array<{ id: string; balanceMinor: bigint; currency: Currency }>>`
      SELECT "id", "balanceMinor", "currency" FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE`;
    const w = locked[0];
    if (!w) return false;
    const already = await tx.walletTransaction.findFirst({ where: { idempotencyKey: `refund-cancel:${orderId}` } });
    if (already) return false;
    const back = w.balanceMinor + BigInt(amountMinor);
    await tx.walletTransaction.create({
      data: {
        walletId: w.id, type: "REFUND", amountMinor: BigInt(amountMinor), balanceAfterMinor: back,
        currency: w.currency, orderId, referenceNote: `expired ${orderNumber}`,
        idempotencyKey: `refund-cancel:${orderId}`,
      },
    });
    await tx.wallet.update({ where: { id: w.id }, data: { balanceMinor: back } });
    await tx.order.update({ where: { id: orderId }, data: { status: "EXPIRED", walletUsedMinor: 0 } });
    return true;
  });
}
