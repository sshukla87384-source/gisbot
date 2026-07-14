import { adjustWallet, dispatchDueBroadcasts, enqueueAdminAlert, getRedis, pollBinancePayments } from "@gis/core";
import { prisma } from "@gis/database";

/**
 * Scheduled maintenance jobs (Architecture doc §3.4 "cron" row).
 * Plain intervals + Redis NX locks: safe if multiple workers ever run.
 */

async function withLock(key: string, ttlSec: number, fn: () => Promise<void>): Promise<void> {
  const redis = getRedis();
  const token = `${process.pid}:${Date.now()}`;
  const acquired = await redis.set(`lock:${key}`, token, "EX", ttlSec, "NX");
  if (!acquired) return;
  try {
    await fn();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`cron ${key} failed`, { error: String(e) });
  }
}

/** Release expired soft-reservations and expire stale unpaid orders (every 60 s). */
async function sweepReservationsAndOrders(): Promise<void> {
  const now = new Date();
  const [keys, accounts] = await Promise.all([
    prisma.licenseKey.updateMany({
      where: { status: "RESERVED", reservedUntil: { lt: now } },
      data: { status: "AVAILABLE", reservedUntil: null },
    }),
    prisma.digitalAccount.updateMany({
      where: { status: "RESERVED", reservedUntil: { lt: now } },
      data: { status: "AVAILABLE", reservedUntil: null },
    }),
  ]);
  const expired = await prisma.order.updateMany({
    where: { status: "PENDING_PAYMENT", expiresAt: { lt: now } },
    data: { status: "EXPIRED" },
  });
  if (keys.count + accounts.count + expired.count > 0) {
    await prisma.auditLog.create({
      data: {
        actorType: "SYSTEM",
        action: "cron.sweep",
        entityType: "System",
        after: { releasedKeys: keys.count, releasedAccounts: accounts.count, expiredOrders: expired.count },
      },
    });
  }
}

/** Credit matured commissions and referral rewards to wallets (every 10 min). */
async function releaseHolds(): Promise<void> {
  const now = new Date();

  const commissions = await prisma.commissionEntry.findMany({
    where: { holdUntil: { lt: now }, releasedAt: null, clawedBackAt: null },
    take: 200,
  });
  for (const entry of commissions) {
    const profile = await prisma.resellerProfile.findUnique({ where: { id: entry.resellerId } });
    if (!profile) continue;
    const wallet = await prisma.wallet.findUnique({ where: { userId: profile.userId } });
    if (!wallet || wallet.currency !== entry.currency) {
      await enqueueAdminAlert(`⚠️ Commission ${entry.id}: wallet currency mismatch — manual settlement required`);
      continue;
    }
    await adjustWallet({
      userId: profile.userId,
      amountMinor: BigInt(entry.netMinor),
      type: "COMMISSION",
      note: `commission ${entry.orderItemId}`,
      idempotencyKey: `comm:${entry.id}`,
    }).catch(() => undefined); // unique idempotencyKey → replay-safe
    await prisma.commissionEntry.update({ where: { id: entry.id }, data: { releasedAt: now } });
  }

  const rewards = await prisma.referralReward.findMany({
    where: { status: "PENDING_HOLD", holdUntil: { lt: now } },
    include: { referred: { select: { id: true } } },
    take: 200,
  });
  for (const reward of rewards) {
    const order = await prisma.order.findUnique({ where: { id: reward.orderId } });
    // Anti-fraud (PRD §6.5): withhold if the qualifying order was refunded.
    if (!order || ["REFUNDED", "PARTIALLY_REFUNDED", "CANCELLED"].includes(order.status)) {
      await prisma.referralReward.update({
        where: { id: reward.id },
        data: { status: "WITHHELD", withheldReason: "qualifying order refunded/cancelled" },
      });
      continue;
    }
    const wallet = await prisma.wallet.findUnique({ where: { userId: reward.referrerId } });
    if (!wallet || wallet.currency !== reward.currency) {
      await prisma.referralReward.update({
        where: { id: reward.id },
        data: { status: "WITHHELD", withheldReason: "wallet currency mismatch" },
      });
      continue;
    }
    await adjustWallet({
      userId: reward.referrerId,
      amountMinor: BigInt(reward.amountMinor),
      type: "REFERRAL_REWARD",
      note: `referral reward (${reward.orderId})`,
      idempotencyKey: `refr:${reward.id}`,
    }).catch(() => undefined);
    await prisma.referralReward.update({
      where: { id: reward.id },
      data: { status: "CREDITED", creditedAt: now },
    });
  }
}

/** Low-stock alerts to the admin channel, at most once per variant per day (hourly). */
async function lowStockAlerts(): Promise<void> {
  const redis = getRedis();
  const variants = await prisma.$queryRaw<
    Array<{ id: string; name: string; productName: string; threshold: number; available: bigint }>
  >`
    SELECT v."id", v."name", p."name" AS "productName", v."lowStockThreshold" AS "threshold",
           COUNT(k."id") FILTER (WHERE k."status" = 'AVAILABLE' AND k."deletedAt" IS NULL) AS "available"
    FROM "ProductVariant" v
    JOIN "Product" p ON p."id" = v."productId"
    LEFT JOIN "LicenseKey" k ON k."variantId" = v."id"
    WHERE v."deletedAt" IS NULL AND v."isActive" = true
      AND p."type" IN ('LICENSE_KEY', 'DIGITAL_ACCOUNT') AND p."status" = 'ACTIVE'
    GROUP BY v."id", v."name", p."name", v."lowStockThreshold"
    HAVING COUNT(k."id") FILTER (WHERE k."status" = 'AVAILABLE' AND k."deletedAt" IS NULL) <= v."lowStockThreshold"`;
  for (const v of variants) {
    const dedupeKey = `alert:lowstock:${v.id}`;
    const first = await redis.set(dedupeKey, "1", "EX", 86_400, "NX");
    if (first) {
      await enqueueAdminAlert(`📉 Low stock: ${v.productName} · ${v.name} — ${v.available} left`);
    }
  }
}

/** Ledger reconciliation: cached balance must equal SUM(ledger) (daily). */
async function reconcileWallets(): Promise<void> {
  const mismatches = await prisma.$queryRaw<Array<{ id: string; cached: bigint; actual: bigint | null }>>`
    SELECT w."id", w."balanceMinor" AS "cached", SUM(t."amountMinor") AS "actual"
    FROM "Wallet" w
    LEFT JOIN "WalletTransaction" t ON t."walletId" = w."id"
    GROUP BY w."id", w."balanceMinor"
    HAVING w."balanceMinor" <> COALESCE(SUM(t."amountMinor"), 0)`;
  if (mismatches.length > 0) {
    await enqueueAdminAlert(
      `🚨 Wallet reconciliation found ${mismatches.length} mismatch(es): ${mismatches
        .slice(0, 5)
        .map((m) => m.id)
        .join(", ")}`,
    );
  }
}

/** Fire scheduled / recurring broadcasts whose time has come (every 60 s). */
async function runScheduledBroadcasts(): Promise<void> {
  await dispatchDueBroadcasts();
}

/** Auto-confirm Binance Pay orders when the matching payment lands (every 60 s). */
async function runBinancePoll(): Promise<void> {
  await pollBinancePayments();
}

export function startCronJobs(): Array<ReturnType<typeof setInterval>> {
  const every = (sec: number, key: string, ttl: number, fn: () => Promise<void>) =>
    setInterval(() => void withLock(key, ttl, fn), sec * 1000);

  // Kick the sweep once at boot so restarts don't delay releases.
  void withLock("sweep", 55, sweepReservationsAndOrders);

  return [
    every(60, "sweep", 55, sweepReservationsAndOrders),
    every(60, "broadcasts", 55, runScheduledBroadcasts),
    every(60, "binancepoll", 55, runBinancePoll),
    every(600, "holds", 590, releaseHolds),
    every(3600, "lowstock", 3590, lowStockAlerts),
    every(86_400, "reconcile", 86_390, reconcileWallets),
  ];
}
