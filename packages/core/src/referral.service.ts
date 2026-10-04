import { promoFlagsCached } from "./promos.service.js";
import { prisma, type Currency, type Prisma } from "@gis/database";
import { convertMinor } from "./fx.js";
import { enqueueTelegramMessage } from "./queues.js";
import { adjustWallet } from "./wallet/wallet.service.js";

type Tx = Prisma.TransactionClient;

async function settingInt(tx: Tx, key: string, fallback: number): Promise<number> {
  const r = await tx.setting.findUnique({ where: { key } });
  return typeof r?.value === "number" ? r.value : fallback;
}

export const REF_FIRST_KEY = "referral.reward_pct_bp";
export const REF_REPEAT_KEY = "referral.reward_pct_bp_repeat";
export const REF_HOLD_KEY = "referral.hold_hours";
/** Months after a friend's FIRST purchase during which repeat commission is paid (0 = lifetime). */
export const REF_MONTHS_KEY = "referral.commission_months";

/**
 * Create a held referral reward for the referrer, if the buyer was referred.
 * Tiered: first purchase = first-rate (default 5%), later purchases = repeat-rate
 * (default 2%). Both rates are admin-configurable. One reward per order (unique).
 */
export async function grantReferralRewardTx(
  tx: Tx,
  opts: { referrerId: string | null; referredId: string; orderId: string; netMinor: number; currency: "INR" | "USD"; isFirst: boolean },
): Promise<void> {
  // Referral promotion can be switched off by an admin — stop the PAYOUT, not just the UI.
  if (!promoFlagsCached().referral) return;
  if (!opts.referrerId || opts.netMinor <= 0) return;
  // Never pay someone for referring themselves. Attribution refuses it at /start,
  // but the payout is where the money leaves, so it is checked here too.
  if (opts.referrerId === opts.referredId) return;
  if (!opts.isFirst) {
    // Repeat commission runs for a window after the friend's first purchase
    // when the admin set one ("earn for the next 6 months"); 0 = lifetime.
    const months = await settingInt(tx, REF_MONTHS_KEY, 0);
    if (months > 0) {
      const friend = await tx.user.findUnique({ where: { id: opts.referredId }, select: { firstPurchaseAt: true } });
      const since = friend?.firstPurchaseAt ? Date.now() - friend.firstPurchaseAt.getTime() : 0;
      if (since > months * 30.44 * 86_400_000) return;
    }
  }
  const bp = opts.isFirst ? await settingInt(tx, REF_FIRST_KEY, 500) : await settingInt(tx, REF_REPEAT_KEY, 200);
  if (bp <= 0) return;
  const amount = Math.floor((opts.netMinor * bp) / 10_000);
  if (amount <= 0) return;
  const existing = await tx.referralReward.findUnique({ where: { orderId: opts.orderId } });
  if (existing) return;
  const holdHours = await settingInt(tx, REF_HOLD_KEY, 48);
  await tx.referralReward.create({
    data: {
      referrerId: opts.referrerId,
      referredId: opts.referredId,
      orderId: opts.orderId,
      amountMinor: amount,
      currency: opts.currency,
      status: "PENDING_HOLD",
      holdUntil: new Date(Date.now() + holdHours * 3_600_000),
    },
  });
}

export interface ReferralConfig { firstPct: number; repeatPct: number; holdHours: number; commissionMonths: number }

export async function getReferralConfig(): Promise<ReferralConfig> {
  const rows = await prisma.setting.findMany({ where: { key: { in: [REF_FIRST_KEY, REF_REPEAT_KEY, REF_HOLD_KEY, REF_MONTHS_KEY] } } });
  const val = (k: string, fb: number) => {
    const v = rows.find((r) => r.key === k)?.value;
    return typeof v === "number" ? v : fb;
  };
  return { firstPct: val(REF_FIRST_KEY, 500) / 100, repeatPct: val(REF_REPEAT_KEY, 200) / 100, holdHours: val(REF_HOLD_KEY, 48), commissionMonths: Math.max(0, Math.round(val(REF_MONTHS_KEY, 0))) };
}

/** How long repeat commission keeps flowing after a friend's first purchase (0 = lifetime, max 120 months). */
export async function setReferralCommissionMonths(months: number): Promise<void> {
  const m = Math.max(0, Math.min(120, Math.round(months)));
  await prisma.setting.upsert({ where: { key: REF_MONTHS_KEY }, create: { key: REF_MONTHS_KEY, value: m }, update: { value: m } });
}

/**
 * Credit matured referral rewards (hold passed) to the referrer's wallet.
 * The cron runs it for everyone every 10 minutes; the customer's "Transfer to
 * wallet" button runs it for one referrer right now. Replay-safe through the
 * ledger's unique idempotency key.
 */
export async function releaseMaturedReferralRewards(opts: { referrerId?: string; limit?: number } = {}): Promise<{ credited: number; creditedMinor: number; currency: Currency | null }> {
  const now = new Date();
  const rewards = await prisma.referralReward.findMany({
    where: { status: "PENDING_HOLD", holdUntil: { lt: now }, ...(opts.referrerId ? { referrerId: opts.referrerId } : {}) },
    take: opts.limit ?? 200,
  });
  let credited = 0;
  let creditedMinor = 0;
  let currency: Currency | null = null;
  for (const reward of rewards) {
    const order = await prisma.order.findUnique({ where: { id: reward.orderId }, select: { status: true } });
    // Anti-fraud: withhold if the qualifying order was refunded.
    if (!order || ["REFUNDED", "PARTIALLY_REFUNDED", "CANCELLED"].includes(order.status)) {
      await prisma.referralReward.update({ where: { id: reward.id }, data: { status: "WITHHELD", withheldReason: "qualifying order refunded/cancelled" } });
      continue;
    }
    const wallet = await prisma.wallet.findUnique({ where: { userId: reward.referrerId }, select: { currency: true } });
    if (!wallet) {
      await prisma.referralReward.update({ where: { id: reward.id }, data: { status: "WITHHELD", withheldReason: "no wallet" } });
      continue;
    }
    // Rewards are created in the ORDER's currency; convert to the wallet's.
    const rewardMinor = wallet.currency === reward.currency ? reward.amountMinor : convertMinor(reward.amountMinor, reward.currency, wallet.currency);
    let paid = false;
    try {
      await adjustWallet({ userId: reward.referrerId, amountMinor: BigInt(rewardMinor), type: "REFERRAL_REWARD", note: `referral reward (${reward.orderId})`, idempotencyKey: `refr:${reward.id}` });
      paid = true;
    } catch (e) {
      paid = (e as { code?: string } | null)?.code === "P2002"; // already in the ledger → mark it
    }
    if (!paid) continue; // stays PENDING_HOLD — retried next tick
    await prisma.referralReward.update({ where: { id: reward.id }, data: { status: "CREDITED", creditedAt: now } });
    credited++;
    creditedMinor += rewardMinor;
    currency = wallet.currency;
  }
  return { credited, creditedMinor, currency };
}

/** What the customer sees on Refer & Earn: held vs credited, and when the next hold lifts. */
export async function referralEarnings(userId: string): Promise<{ heldMinor: number; heldCurrency: Currency; heldCount: number; nextReleaseAt: Date | null; readyCount: number }> {
  const now = new Date();
  const [wallet, held, ready, next] = await Promise.all([
    prisma.wallet.findUnique({ where: { userId }, select: { currency: true } }),
    prisma.referralReward.findMany({ where: { referrerId: userId, status: "PENDING_HOLD" }, select: { amountMinor: true, currency: true } }),
    prisma.referralReward.count({ where: { referrerId: userId, status: "PENDING_HOLD", holdUntil: { lt: now } } }),
    prisma.referralReward.findFirst({ where: { referrerId: userId, status: "PENDING_HOLD", holdUntil: { gte: now } }, orderBy: { holdUntil: "asc" }, select: { holdUntil: true } }),
  ]);
  const cur = (wallet?.currency ?? "USD") as Currency;
  const heldMinor = held.reduce((s, r) => s + (r.currency === cur ? r.amountMinor : convertMinor(r.amountMinor, r.currency, cur)), 0);
  return { heldMinor, heldCurrency: cur, heldCount: held.length, nextReleaseAt: next?.holdUntil ?? null, readyCount: ready };
}

/** Set a referral reward rate (percent, e.g. 5 or 2). */
export async function setReferralRate(kind: "first" | "repeat", pct: number): Promise<void> {
  const key = kind === "first" ? REF_FIRST_KEY : REF_REPEAT_KEY;
  const bp = Math.max(0, Math.round(pct * 100));
  await prisma.setting.upsert({ where: { key }, create: { key, value: bp }, update: { value: bp } });
}

// ── Referral milestones ──────────────────────────────────────────────────────
//
// "After 10 referrals, $0.50 cashback." A ladder of tiers on top of the
// per-order percentage: when a referrer's count of friends reaches a tier,
// the tier's reward is credited to their wallet once. Counting PURCHASED
// friends (default) is the honest metric — "invited" is one tap per fake
// account. Payouts are idempotent through the wallet ledger's unique key
// (refmile:<userId>:<count>), so no extra table is needed and the dashboard
// can read totals straight from the ledger.

export interface MilestoneTier { count: number; rewardUsd: number }
export interface MilestoneConfig {
  enabled: boolean;
  /** What "a referral" means for the ladder. */
  mode: "purchased" | "invited";
  /** Ascending by count. */
  tiers: MilestoneTier[];
  /** Keep paying the LAST tier's reward every time another `lastTier.count` friends arrive. */
  repeatLast: boolean;
}

const MILESTONE_KEY = "referral.milestones";
const MILESTONE_DEFAULT: MilestoneConfig = { enabled: false, mode: "purchased", tiers: [], repeatLast: false };
const MILESTONE_PREFIX = "refmile:";

export async function getMilestoneConfig(): Promise<MilestoneConfig> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: MILESTONE_KEY } });
    const v = row?.value as Partial<MilestoneConfig> | null | undefined;
    if (!v || typeof v !== "object") return MILESTONE_DEFAULT;
    const tiers = Array.isArray(v.tiers)
      ? v.tiers
          .map((t) => ({ count: Math.round(Number((t as MilestoneTier).count)), rewardUsd: Number((t as MilestoneTier).rewardUsd) }))
          .filter((t) => Number.isFinite(t.count) && t.count > 0 && Number.isFinite(t.rewardUsd) && t.rewardUsd > 0)
          .sort((a, b) => a.count - b.count)
      : [];
    return { enabled: v.enabled === true, mode: v.mode === "invited" ? "invited" : "purchased", tiers, repeatLast: v.repeatLast === true };
  } catch {
    return MILESTONE_DEFAULT;
  }
}

export async function setMilestoneConfig(patch: Partial<MilestoneConfig>): Promise<MilestoneConfig> {
  const cur = await getMilestoneConfig();
  const next: MilestoneConfig = { ...cur, ...patch };
  // One tier per count; ascending; sane bounds.
  const byCount = new Map<number, number>();
  for (const t of next.tiers) {
    const count = Math.round(t.count);
    const usd = Math.round(t.rewardUsd * 100) / 100;
    if (count >= 1 && count <= 100_000 && usd > 0 && usd <= 10_000) byCount.set(count, usd);
  }
  const tiers = [...byCount.entries()].map(([count, rewardUsd]) => ({ count, rewardUsd })).sort((a, b) => a.count - b.count).slice(0, 20);
  const value = { enabled: next.enabled, mode: next.mode, tiers, repeatLast: next.repeatLast };
  await prisma.setting.upsert({ where: { key: MILESTONE_KEY }, create: { key: MILESTONE_KEY, value }, update: { value } });
  return { ...next, tiers };
}

/** Add or replace one tier. */
export async function addMilestoneTier(count: number, rewardUsd: number): Promise<MilestoneConfig> {
  const cur = await getMilestoneConfig();
  return setMilestoneConfig({ tiers: [...cur.tiers.filter((t) => t.count !== Math.round(count)), { count: Math.round(count), rewardUsd }] });
}

export async function removeMilestoneTier(count: number): Promise<MilestoneConfig> {
  const cur = await getMilestoneConfig();
  return setMilestoneConfig({ tiers: cur.tiers.filter((t) => t.count !== count) });
}

/** Every milestone count a referrer with `n` friends has reached. */
export function milestonesReached(cfg: MilestoneConfig, n: number): Array<{ count: number; rewardUsd: number }> {
  const out: Array<{ count: number; rewardUsd: number }> = [];
  for (const t of cfg.tiers) if (n >= t.count) out.push(t);
  const last = cfg.tiers[cfg.tiers.length - 1];
  if (cfg.repeatLast && last && n >= last.count * 2) {
    for (let c = last.count * 2; c <= n && out.length < 500; c += last.count) out.push({ count: c, rewardUsd: last.rewardUsd });
  }
  return out;
}

/** The next tier above `n`, for the customer's progress bar. */
export function nextMilestone(cfg: MilestoneConfig, n: number): MilestoneTier | null {
  for (const t of cfg.tiers) if (n < t.count) return t;
  const last = cfg.tiers[cfg.tiers.length - 1];
  if (cfg.repeatLast && last) {
    const next = (Math.floor(n / last.count) + 1) * last.count;
    return { count: next, rewardUsd: last.rewardUsd };
  }
  return null;
}

async function referralCount(userId: string, mode: MilestoneConfig["mode"]): Promise<number> {
  return prisma.user.count({ where: { referredById: userId, ...(mode === "purchased" ? { firstPurchaseAt: { not: null } } : {}) } });
}

/** Customer-facing: where this referrer stands on the ladder. */
export async function milestoneProgress(userId: string): Promise<{ cfg: MilestoneConfig; count: number; next: MilestoneTier | null; paidUsd: number } | null> {
  const cfg = await getMilestoneConfig();
  if (!cfg.enabled || cfg.tiers.length === 0) return null;
  const [count, paid] = await Promise.all([
    referralCount(userId, cfg.mode),
    prisma.walletTransaction.findMany({ where: { idempotencyKey: { startsWith: `${MILESTONE_PREFIX}${userId}:` } }, select: { referenceNote: true } }),
  ]);
  // The note carries the USD figure ("milestone 10 friends · $0.50"), so the
  // total is currency-independent even after a wallet currency switch.
  const paidUsd = paid.reduce((s, t) => s + (Number(/\$([0-9.]+)/.exec(t.referenceNote ?? "")?.[1] ?? 0) || 0), 0);
  return { cfg, count, next: nextMilestone(cfg, count), paidUsd: Math.round(paidUsd * 100) / 100 };
}

/**
 * Pay every milestone that is reached but not yet credited. Cron calls it
 * every few minutes; the admin dashboard can run it on demand. Returns how
 * many payouts were made. Each payout is announced to the referrer.
 */
export async function runReferralMilestones(pageSize = 200, maxPages = 50): Promise<number> {
  const cfg = await getMilestoneConfig();
  if (!cfg.enabled || cfg.tiers.length === 0) return 0;
  const minCount = cfg.tiers[0]?.count ?? 1;
  // Paged through to the end: the top-N referrers stay at the top once they
  // are fully paid, so a fixed `take` would never reach referrer N+1.
  const grouped: Array<{ referredById: string | null; _count: { _all: number } }> = [];
  for (let page = 0; page < maxPages; page++) {
    const batch = await prisma.user.groupBy({
      by: ["referredById"],
      where: { referredById: { not: null }, ...(cfg.mode === "purchased" ? { firstPurchaseAt: { not: null } } : {}) },
      _count: { _all: true },
      having: { referredById: { _count: { gte: minCount } } },
      orderBy: { referredById: "asc" },
      skip: page * pageSize,
      take: pageSize,
    });
    grouped.push(...batch);
    if (batch.length < pageSize) break;
  }
  let paid = 0;
  for (const g of grouped) {
    const referrerId = g.referredById;
    if (!referrerId) continue;
    const n = g._count._all;
    const reached = milestonesReached(cfg, n);
    if (reached.length === 0) continue;
    const done = await prisma.walletTransaction.findMany({
      where: { idempotencyKey: { startsWith: `${MILESTONE_PREFIX}${referrerId}:` } },
      select: { idempotencyKey: true },
    });
    const doneKeys = new Set(done.map((d) => d.idempotencyKey));
    const [wallet, user] = await Promise.all([
      prisma.wallet.findUnique({ where: { userId: referrerId }, select: { currency: true } }),
      prisma.user.findUnique({ where: { id: referrerId }, select: { telegramId: true, status: true } }),
    ]);
    if (!wallet || !user || user.status !== "ACTIVE") continue;
    for (const m of reached) {
      const key = `${MILESTONE_PREFIX}${referrerId}:${m.count}`;
      if (doneKeys.has(key)) continue;
      const usdMinor = Math.round(m.rewardUsd * 100);
      const amountMinor = wallet.currency === "USD" ? usdMinor : convertMinor(usdMinor, "USD", wallet.currency);
      if (amountMinor <= 0) continue;
      try {
        await adjustWallet({
          userId: referrerId,
          amountMinor: BigInt(amountMinor),
          type: "CASHBACK",
          note: `milestone ${m.count} friends · $${m.rewardUsd.toFixed(2)}`,
          idempotencyKey: key,
        });
      } catch (e) {
        if ((e as { code?: string } | null)?.code === "P2002") continue; // already paid by a parallel run
        throw e;
      }
      paid++;
      if (user.telegramId) {
        const what = cfg.mode === "purchased" ? "friends who bought" : "friends invited";
        await enqueueTelegramMessage(
          user.telegramId,
          `🏆 <b>Referral milestone!</b>\n\n<b>${m.count} ${what}</b> — <b>$${m.rewardUsd.toFixed(2)}</b> cashback has been added to your 💰 Wallet.\n\nKeep sharing your link to reach the next one 🚀`,
        ).catch(() => undefined);
      }
    }
  }
  return paid;
}

/** Admin dashboard figures. */
export async function milestoneDashboard(): Promise<{
  cfg: MilestoneConfig;
  payouts: number;
  paidUsd: number;
  eligibleReferrers: number;
  top: Array<{ userId: string; handle: string | null; firstName: string | null; invited: number; purchased: number }>;
}> {
  const cfg = await getMilestoneConfig();
  const [paidRows, inviteGroups, buyGroups] = await Promise.all([
    prisma.walletTransaction.findMany({ where: { idempotencyKey: { startsWith: MILESTONE_PREFIX } }, select: { referenceNote: true } }),
    prisma.user.groupBy({ by: ["referredById"], where: { referredById: { not: null } }, _count: { _all: true }, orderBy: { _count: { referredById: "desc" } }, take: 10 }),
    prisma.user.groupBy({ by: ["referredById"], where: { referredById: { not: null }, firstPurchaseAt: { not: null } }, _count: { _all: true }, orderBy: { _count: { referredById: "desc" } }, take: 10 }),
  ]);
  const paidUsd = paidRows.reduce((s, t) => s + (Number(/\$([0-9.]+)/.exec(t.referenceNote ?? "")?.[1] ?? 0) || 0), 0);
  const ids = [...new Set([...inviteGroups, ...buyGroups].map((g) => g.referredById).filter((x): x is string => Boolean(x)))];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, telegramHandle: true, firstName: true } }) : [];
  const invitedBy = new Map(inviteGroups.map((g) => [g.referredById, g._count._all] as const));
  const purchasedBy = new Map(buyGroups.map((g) => [g.referredById, g._count._all] as const));
  const primary = cfg.mode === "purchased" ? buyGroups : inviteGroups;
  const top = primary.slice(0, 5).flatMap((g) => {
    const u = users.find((x) => x.id === g.referredById);
    return u ? [{ userId: u.id, handle: u.telegramHandle, firstName: u.firstName, invited: invitedBy.get(u.id) ?? 0, purchased: purchasedBy.get(u.id) ?? 0 }] : [];
  });
  const minCount = cfg.tiers[0]?.count ?? Number.POSITIVE_INFINITY;
  const eligibleReferrers = primary.filter((g) => g._count._all >= minCount).length;
  return { cfg, payouts: paidRows.length, paidUsd: Math.round(paidUsd * 100) / 100, eligibleReferrers, top };
}
