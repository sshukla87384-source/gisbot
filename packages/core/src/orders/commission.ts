import { prisma } from "@gis/database";
import type { Prisma } from "@gis/database";


type Tx = Prisma.TransactionClient;

/**
 * Marketplace commission accrual (PRD §6.6).
 *
 * This used to live inline in the gateway fulfilment path and NOWHERE else, so
 * every wallet, BNPL, UPI, Binance and manually-delivered sale of a reseller's
 * product accrued zero commission. Those are the primary rails here, which meant
 * resellers were unpaid on nearly every sale they made.
 *
 * One helper, called at every point an item is actually delivered — and only
 * when it is delivered, since the old code accrued for items that failed to
 * assign and were later refunded to the customer.
 */
async function getSettingInt(key: string, fallback: number): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key } }).catch(() => null);
  const v = row?.value as { value?: number } | number | null;
  const n = typeof v === "number" ? v : typeof v?.value === "number" ? v.value : fallback;
  return Number.isFinite(n) ? n : fallback;
}

export async function accrueCommissionTx(
  tx: Tx,
  item: { id: string; resellerIdSnap: string | null; totalMinor: number },
  currency: string,
): Promise<void> {
  if (!item.resellerIdSnap) return;
  // Idempotent: CommissionEntry.orderItemId is unique, so a replay or a second
  // delivery attempt cannot pay twice.
  const existing = await tx.commissionEntry.findUnique({ where: { orderItemId: item.id }, select: { id: true } });
  if (existing) return;

  const profile = await tx.resellerProfile.findUnique({ where: { id: item.resellerIdSnap } });
  const bp = profile?.commissionPct ?? (await getSettingInt("reseller.commission_pct_bp", 1000));
  const commission = Math.floor((item.totalMinor * bp) / 10_000);
  const holdDays = profile?.holdDays ?? 7;
  await tx.commissionEntry.create({
    data: {
      orderItemId: item.id,
      resellerId: item.resellerIdSnap,
      grossMinor: item.totalMinor,
      commissionMinor: commission,
      netMinor: item.totalMinor - commission,
      currency: currency as "INR" | "USD",
      holdUntil: new Date(Date.now() + holdDays * 86_400_000),
    },
  });
}

/** Non-transactional variant for the manual-delivery path. */
export async function accrueCommission(orderItemId: string): Promise<void> {
  const item = await prisma.orderItem.findUnique({
    where: { id: orderItemId },
    select: { id: true, resellerIdSnap: true, totalMinor: true, order: { select: { currency: true } } },
  });
  if (!item?.resellerIdSnap) return;
  await prisma.$transaction((tx) => accrueCommissionTx(tx, item, item.order.currency));
}
