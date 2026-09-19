import { adjustWallet, autoRefundStuckStock, dispatchDueBroadcasts, enqueueAdminAlert, getRedis,
  refundWalletForOrder,
  logWallet,
  retryPendingSupplierFulfilment,
  runAutoPromo,
  runRecoverySweep,
  runQualitySweep,
  reconcile,
  profitReport,
  sendResellerStatements,
  pollBinancePayments,
  pollUpiCredits,
  convertMinor,
  clearPaymentPrompts,
  sweepResolvedOrderPrompts,
  releaseCouponForOrderTx,
  resetPricesForSoldOut,
  syncAllSuppliers,
} from "@gis/core";
import { prisma } from "@gis/database";

/**
 * Scheduled maintenance jobs (Architecture doc §3.4 "cron" row).
 * Plain intervals + Redis NX locks: safe if multiple workers ever run.
 */

/**
 * The lock is NOT released at the end by default: for the once-a-day jobs the
 * TTL *is* the schedule (they tick hourly and the ~24 h lock is what holds them
 * to once a day), so releasing it would make them run every hour.
 *
 * `releaseWhenDone` is for the other kind of job, where the TTL is meant to be
 * a cap on how long one run may take rather than a period gate. Those need a
 * TTL comfortably longer than the interval — otherwise a slow run outlives its
 * own lock and the next tick starts a second copy on top of it — and that is
 * only safe if a normal-length run hands the lock back so the next tick still
 * runs on time.
 */
async function withLock(key: string, ttlSec: number, fn: () => Promise<void>, releaseWhenDone = false): Promise<void> {
  const token = `${process.pid}:${Date.now()}`;
  let acquired: string | null = null;
  try {
    const redis = getRedis();
    acquired = await redis.set(`lock:${key}`, token, "EX", ttlSec, "NX");
  } catch (e) {
    // Every tick is fired as `void withLock(...)`, so a rejection here is an
    // UNHANDLED rejection — i.e. one Redis blip taking the worker process down.
    // eslint-disable-next-line no-console
    console.error(`cron ${key} lock failed`, { error: String(e) });
    return;
  }
  if (!acquired) return;
  try {
    await fn();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`cron ${key} failed`, { error: String(e) });
  } finally {
    if (releaseWhenDone) {
      try {
        const redis = getRedis();
        // Compare before deleting: a run that DID overrun its TTL must not
        // delete the lock a later tick has since taken, or both keep running.
        if ((await redis.get(`lock:${key}`)) === token) await redis.del(`lock:${key}`);
      } catch {
        // Couldn't release — the TTL still expires it, just later.
      }
    }
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
  // Refund any wallet money applied to a part-paid order BEFORE expiring it —
  // otherwise the customer's balance is silently destroyed with the order.
  const dying = await prisma.order.findMany({
    where: { status: "PENDING_PAYMENT", expiresAt: { lt: now }, walletUsedMinor: { gt: 0 } },
    select: { id: true, userId: true, orderNumber: true, walletUsedMinor: true },
    // Bounded like the expiry pass below: this loop runs one transaction per row
    // on a 60 s tick, so an unbounded backlog would run past even the generous
    // runtime cap on the sweep lock and have the next tick start on top of it.
    take: 200,
  });
  for (const o of dying) {
    try {
      await refundWalletForOrder(o.userId, o.id, o.orderNumber, o.walletUsedMinor);
    } catch (e) {
      // leave it PENDING_PAYMENT so the next run retries rather than losing the money
      void logWallet("cron.expireRefund", `Refund failed for ${o.orderNumber} — order left pending for retry`, {
        orderId: o.id, amountMinor: o.walletUsedMinor, error: String(e).slice(0, 200),
      });
    }
  }
  // Recover any paid-but-undelivered supplier items before anything else.
  await retryPendingSupplierFulfilment(20).catch(() => undefined);
  // Rotating promo post, if the admin enabled it.
  await runAutoPromo().catch(() => undefined);

  // Collect the ids first: an expired order's "pay this amount" card has to be
  // taken out of the customer's chat, and updateMany does not say which rows it
  // touched.
  const expiring = await prisma.order.findMany({
    where: { status: "PENDING_PAYMENT", expiresAt: { lt: now }, walletUsedMinor: 0 },
    select: { id: true },
    take: 500,
  });
  // One order per transaction, so each expiry and the return of its coupon are
  // atomic together. The status is re-checked inside the same statement: the
  // webhook that pays an order can land between the SELECT above and this
  // UPDATE, and matching on id alone stamped EXPIRED over a PAID order — money
  // taken, order dead.
  let expiredCount = 0;
  for (const o of expiring) {
    const hit = await prisma.$transaction(async (tx) => {
      const r = await tx.order.updateMany({
        where: { id: o.id, status: "PENDING_PAYMENT" },
        data: { status: "EXPIRED" },
      });
      // The coupon was burned when the order was created; an order that dies
      // unpaid has to hand it back, or a single-use code is destroyed by an
      // abandoned checkout.
      if (r.count > 0) await releaseCouponForOrderTx(tx, o.id);
      return r.count;
    }).catch(() => 0);
    expiredCount += hit;
    await clearPaymentPrompts(o.id).catch(() => undefined);
  }
  const expired = { count: expiredCount };

  // Catch-all for every OTHER way an order stops awaiting payment — a rail
  // cancelling the previous attempt, a gateway rejection, an admin cancelling by
  // hand. Those used to leave the payment card and the whole UTR conversation in
  // the customer's chat for good.
  await sweepResolvedOrderPrompts(async (ids) => {
    const rows = await prisma.order.findMany({
      where: { id: { in: ids }, status: { not: "PENDING_PAYMENT" } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }).catch(() => 0);
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

/**
 * Did the wallet credit actually land? A replay hits the ledger's unique
 * idempotencyKey (P2002), which means the money IS there and the entry can be
 * closed. Anything else — DB down, wallet vanished — means it is NOT, and the
 * entry must stay open for the next tick. Swallowing every error and marking it
 * paid regardless is how a reseller never receives a matured commission.
 */
async function credited(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return true;
  } catch (e) {
    return (e as { code?: string } | null)?.code === "P2002";
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
    if (!wallet) {
      await enqueueAdminAlert(`⚠️ Commission ${entry.id}: no wallet — manual settlement required`);
      continue;
    }
    // Entries are created in the ORDER's currency, wallets are USD, and nothing
    // syncs the two — so this used to `continue` WITHOUT setting releasedAt on
    // every INR order: the reseller was never paid and the same entry re-alerted
    // every 10 minutes forever. Convert exactly, like spin and referral do.
    const commMinor = wallet.currency === entry.currency
      ? entry.netMinor
      : convertMinor(entry.netMinor, entry.currency, wallet.currency);
    const paid = await credited(adjustWallet({
      userId: profile.userId,
      amountMinor: BigInt(commMinor),
      type: "COMMISSION",
      note: `commission ${entry.orderItemId}`,
      idempotencyKey: `comm:${entry.id}`,
    })); // unique idempotencyKey → replay-safe
    if (!paid) continue; // not credited — leave it matured so the next run retries
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
    if (!wallet) {
      await prisma.referralReward.update({
        where: { id: reward.id },
        data: { status: "WITHHELD", withheldReason: "no wallet" },
      });
      continue;
    }
    // Rewards are created in the ORDER's currency; wallets are USD. Treating a
    // mismatch as fraud meant the referral programme silently never paid out on
    // a single INR order. Convert exactly instead.
    const rewardMinor = wallet.currency === reward.currency
      ? reward.amountMinor
      : convertMinor(reward.amountMinor, reward.currency, wallet.currency);
    const paid = await credited(adjustWallet({
      userId: reward.referrerId,
      amountMinor: BigInt(rewardMinor),
      type: "REFERRAL_REWARD",
      note: `referral reward (${reward.orderId})`,
      idempotencyKey: `refr:${reward.id}`,
    }));
    if (!paid) continue; // still PENDING_HOLD — retried on the next tick
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

/** Remind anyone who left a payment half-finished — once each (every 5 min). */
async function recoverAbandonedCheckouts(): Promise<void> {
  const { sent } = await runRecoverySweep(30);
  if (sent > 0) {
    await prisma.auditLog.create({
      data: { actorType: "SYSTEM", action: "cron.recovery", entityType: "Order", after: { reminded: sent } },
    }).catch(() => undefined);
  }
}

/** Catch a faulty batch early: complaint rate per product (every 6 h). */
async function qualitySweep(): Promise<void> {
  const { flagged, paused } = await runQualitySweep();
  if (flagged > 0) {
    await enqueueAdminAlert(
      [
        `⚠️ <b>Delivery quality warning</b>`,
        "",
        `${flagged} product(s) are above your complaint threshold${paused > 0 ? ` — ${paused} auto-paused` : ""}.`,
        "",
        paused > 0
          ? "They are hidden from the shop until you check them."
          : "Nothing was paused — auto-pause is off, so this is just a heads-up.",
      ].join("\n"),
      [{ text: "📉 Delivery quality", callbackData: "adm:qual", style: "primary" }],
    ).catch(() => undefined);
  }
}

/** Money summary once a day, so problems surface without being looked for. */
async function dailyMoneySummary(): Promise<void> {
  const [r, p] = await Promise.all([reconcile(24), profitReport(1)]);
  const usd = (m: number): string => `$${(m / 100).toFixed(2)}`;
  await enqueueAdminAlert(
    [
      "📒 <b>Daily money summary</b> <i>(last 24h)</i>",
      "",
      `💵 Revenue: <b>${usd(p.revenueMinor)}</b>   ·   Cost: <b>${usd(p.costMinor)}</b>`,
      `📈 Profit: <b>${usd(p.profitMinor)}</b>${p.marginBp !== null ? `  (${(p.marginBp / 100).toFixed(1)}% margin)` : ""}`,
      ...(p.unpricedUnits > 0 ? [`⚠️ ${p.unpricedUnits} unit(s) had no cost set — profit above excludes them.`] : []),
      "",
      `🏦 Wallet money you hold: <b>${usd(r.walletLiabilityMinorUsd)}</b> across ${r.walletCount} wallet(s)`,
      `⬇️ Deposits: ${usd(r.depositsMinor)}   ·   🛍 Spent: ${usd(r.purchasesMinor)}   ·   ↩️ Refunds: ${usd(r.refundsMinor)}`,
      ...(r.unfulfilledPaidOrders > 0 ? [`🚨 <b>${r.unfulfilledPaidOrders} paid order(s) not yet delivered</b> (${usd(r.unfulfilledPaidValueMinor)})`] : []),
      ...(r.driftWallets > 0 ? [`🚨 <b>${r.driftWallets} wallet(s) disagree with their ledger</b> (${usd(r.driftMinor)}) — check this.`] : []),
      ...(p.lossMakers.length > 0 ? ["", `📉 <b>Sold below cost:</b> ${p.lossMakers.slice(0, 3).map((l) => l.name).join(", ")}`] : []),
    ].join("\n"),
    [{ text: "💰 Profit & margin", callbackData: "adm:fin", style: "primary" }, { text: "📒 Reconciliation", callbackData: "adm:recon", style: "primary" }],
  ).catch(() => undefined);
}

/**
 * Auto-confirm Binance payments (every 2 min).
 *
 * This existed but was never scheduled, so "Auto-confirms when payment arrives"
 * was a lie: anyone who paid and waited had their order expire with their USDT
 * gone unless they pasted a transaction id by hand.
 */
async function binancePoll(): Promise<void> {
  await pollUpiCredits().catch(() => 0);
  const n = await pollBinancePayments();
  if (n > 0) {
    await prisma.auditLog.create({
      data: { actorType: "SYSTEM", action: "cron.binancePoll", entityType: "Order", after: { confirmed: n } },
    }).catch(() => undefined);
  }
}

/** Daily statement to every API user / reseller (once a day). */
async function resellerStatements(): Promise<void> {
  const { sent, skipped } = await sendResellerStatements();
  if (sent > 0) {
    await prisma.auditLog.create({
      data: { actorType: "SYSTEM", action: "cron.resellerStatements", entityType: "User", after: { sent, skipped } },
    }).catch(() => undefined);
  }
}

/** Fire scheduled / recurring broadcasts whose time has come (every 60 s). */
async function runScheduledBroadcasts(): Promise<void> {
  await dispatchDueBroadcasts();
}

/** Runtime caps (seconds) for the jobs whose lock is released when they finish. */
const SWEEP_LOCK_TTL = 600;
const SUPSYNC_LOCK_TTL = 1800;

export function startCronJobs(): Array<ReturnType<typeof setInterval>> {
  const every = (sec: number, key: string, ttl: number, fn: () => Promise<void>, releaseWhenDone = false) =>
    setInterval(() => void withLock(key, ttl, fn, releaseWhenDone), sec * 1000);

  // Kick the sweep once at boot so restarts don't delay releases.
  void withLock("sweep", SWEEP_LOCK_TTL, sweepReservationsAndOrders, true);

  return [
    // The 55 s lock this used to take was SHORTER than the job: the sweep calls
    // retryPendingSupplierFulfilment(20), and each of those is a supplier HTTP
    // call with an 8 s timeout — well over two minutes on a bad day, plus up to
    // 200 wallet refunds. The lock expired mid-run and the next tick started a
    // second sweep alongside the first. TTL is now a real runtime cap, released
    // as soon as the run ends so the 60 s cadence is unchanged.
    every(60, "sweep", SWEEP_LOCK_TTL, sweepReservationsAndOrders, true),
    every(60, "broadcasts", 55, runScheduledBroadcasts),
    every(600, "holds", 590, releaseHolds),
    every(3600, "lowstock", 3590, lowStockAlerts),
    // A sold-out product must not keep advertising a sale price, and its
    // temporary customer prices go with it.
    every(300, "saleoos", 290, async () => { await resetPricesForSoldOut(); }),
    // Supplier stock and prices, every 5 minutes: what they sold out of comes
    // off our shelves, and a price rise follows through with the markup.
    //
    // syncAllSuppliers walks every active supplier one at a time — an 8 s
    // catalogue fetch each, then a write pass over that supplier's products —
    // so a handful of suppliers with real catalogues runs past the 290 s this
    // used to lock for. Same fix as the sweep: generous runtime cap, released
    // on completion so the 5-minute cadence stands.
    every(300, "supsync", SUPSYNC_LOCK_TTL, async () => { await syncAllSuppliers(); }, true),
    every(1800, "refundstock", 1790, async () => { await autoRefundStuckStock(); }),
    // The once-a-day jobs TICK hourly and are held to once a day by a ~24 h lock
    // instead of a 24 h setInterval. An interval that long never fires at all on
    // a service that is redeployed more often than once a day: every restart put
    // the timer back to zero, so the reconciliation, the money summary and the
    // reseller statements simply never ran. The lock lives in Redis, so it
    // survives the restart the timer did not.
    every(3600, "reconcile", 86_390, reconcileWallets),
    every(120, "binancepoll", 110, binancePoll),
    every(300, "recovery", 290, recoverAbandonedCheckouts),
    every(3600, "quality", 21_590, qualitySweep),
    every(3600, "moneysummary", 86_390, dailyMoneySummary),
    every(3600, "resellerstmt", 86_390, resellerStatements),
  ];
}
