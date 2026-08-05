import { prisma } from "@gis/database";
import { invalidate } from "./redis.js";
import { adjustWallet } from "./wallet/wallet.service.js";
import { enqueueTelegramMessage } from "./queues.js";
import { convertMinor } from "./fx.js";
import { lifetimeSpend } from "./loyalty.service.js";
import { promoEnabled } from "./promos.service.js";
import type { Currency } from "@gis/database";

/**
 * Spin-to-win as a SPEND CHALLENGE, per the agreed spec:
 * the wheel assigns a task ("spend X and earn a wallet reward"), and the reward
 * is capped at 2% of the target.
 *
 * REWARD_CAP_BP is a hard code rule, deliberately not a setting — it cannot be
 * raised from the admin panel by accident.
 */
export const REWARD_CAP_BP = 200; // 200 basis points = 2%
const SETTING = "spin.config";

export interface SpinConfig {
  enabled: boolean;
  targetsMinor: number[]; // legacy challenge mode (kept for existing rows)
  rewardBp: number; // capped at REWARD_CAP_BP
  expiryDays: number;
  /** Purchases below this win nothing ("better luck next time"). */
  minSpendMinor: number;
  /** Hard ceiling on a single spin reward. */
  maxRewardMinor: number;
  /** Most spins one customer may take per calendar day. */
  maxSpinsPerDay: number;
}

// Enabled by default (requested). Rewards stay bounded by REWARD_CAP_BP: with
// these targets the most anyone can earn per challenge is $1 / $2 / $5.
const DEFAULTS: SpinConfig = { enabled: true, targetsMinor: [5_000, 10_000, 25_000], rewardBp: 200, expiryDays: 14, minSpendMinor: 1_000, maxRewardMinor: 1, maxSpinsPerDay: 3 };

export async function getSpinConfig(): Promise<SpinConfig> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING } }).catch(() => null);
  const v = (row?.value ?? null) as Partial<SpinConfig> | null;
  return {
    enabled: v?.enabled ?? DEFAULTS.enabled,
    targetsMinor: Array.isArray(v?.targetsMinor) && v.targetsMinor.length ? v.targetsMinor : DEFAULTS.targetsMinor,
    // Never trust a stored value above the cap.
    rewardBp: Math.min(REWARD_CAP_BP, Math.max(1, Number(v?.rewardBp ?? DEFAULTS.rewardBp))),
    expiryDays: Math.min(90, Math.max(1, Number(v?.expiryDays ?? DEFAULTS.expiryDays))),
    minSpendMinor: Math.max(0, Number(v?.minSpendMinor ?? DEFAULTS.minSpendMinor)),
    maxRewardMinor: Math.max(1, Number(v?.maxRewardMinor ?? DEFAULTS.maxRewardMinor)),
    maxSpinsPerDay: Math.max(1, Math.min(50, Number(v?.maxSpinsPerDay ?? DEFAULTS.maxSpinsPerDay))),
  };
}

export async function setSpinConfig(patch: Partial<SpinConfig>): Promise<SpinConfig> {
  const cur = await getSpinConfig();
  const next: SpinConfig = {
    enabled: patch.enabled ?? cur.enabled,
    targetsMinor: (patch.targetsMinor ?? cur.targetsMinor).filter((n) => n > 0).slice(0, 6),
    rewardBp: Math.min(REWARD_CAP_BP, Math.max(1, patch.rewardBp ?? cur.rewardBp)),
    expiryDays: Math.min(90, Math.max(1, patch.expiryDays ?? cur.expiryDays)),
    minSpendMinor: Math.max(0, patch.minSpendMinor ?? cur.minSpendMinor),
    maxRewardMinor: Math.max(1, patch.maxRewardMinor ?? cur.maxRewardMinor),
    maxSpinsPerDay: Math.max(1, Math.min(50, patch.maxSpinsPerDay ?? cur.maxSpinsPerDay)),
  };
  await prisma.setting.upsert({ where: { key: SETTING }, create: { key: SETTING, value: next as never }, update: { value: next as never } });
  return next;
}

/** Reward for a target — always ≤ 2% of it, and at least 1 minor unit. */
export function rewardFor(targetMinor: number, rewardBp: number): number {
  const bp = Math.min(REWARD_CAP_BP, Math.max(1, rewardBp));
  return Math.max(1, Math.floor((targetMinor * bp) / 10_000));
}

export interface ChallengeView {
  id: string;
  targetMinor: number;
  rewardMinor: number;
  currency: Currency;
  progressMinor: number;
  remainingMinor: number;
  pct: number;
  expiresAt: Date;
  claimable: boolean;
}

async function viewOf(c: { id: string; targetMinor: number; rewardMinor: number; currency: string; baselineMinor: number; expiresAt: Date; userId: string }): Promise<ChallengeView> {
  const spend = await lifetimeSpend(c.userId);
  const since = Math.max(0, spend.minor - c.baselineMinor);
  const progress = Math.min(c.targetMinor, since);
  return {
    id: c.id,
    targetMinor: c.targetMinor,
    rewardMinor: c.rewardMinor,
    currency: c.currency as Currency,
    progressMinor: progress,
    remainingMinor: Math.max(0, c.targetMinor - since),
    pct: Math.min(100, Math.round((since / Math.max(1, c.targetMinor)) * 100)),
    expiresAt: c.expiresAt,
    claimable: since >= c.targetMinor,
  };
}

export async function activeChallenge(userId: string): Promise<ChallengeView | null> {
  const c = await prisma.spinChallenge.findFirst({ where: { userId, status: "ACTIVE" }, orderBy: { createdAt: "desc" } });
  if (!c) return null;
  if (c.expiresAt < new Date()) {
    await prisma.spinChallenge.update({ where: { id: c.id }, data: { status: "EXPIRED" } }).catch(() => undefined);
    return null;
  }
  return viewOf(c);
}

/** Draw a challenge. One active at a time. */
export async function spin(userId: string): Promise<{ ok: boolean; reason?: string; challenge?: ChallengeView }> {
  const cfg = await getSpinConfig();
  if (!cfg.enabled || !(await promoEnabled("spin"))) return { ok: false, reason: "DISABLED" };
  const existing = await activeChallenge(userId);
  if (existing) return { ok: false, reason: "ALREADY_ACTIVE", challenge: existing };

  const spend = await lifetimeSpend(userId);
  const target = cfg.targetsMinor[Math.floor(Math.random() * cfg.targetsMinor.length)] ?? cfg.targetsMinor[0]!;
  const reward = rewardFor(target, cfg.rewardBp);
  const c = await prisma.spinChallenge.create({
    data: {
      userId,
      targetMinor: target,
      rewardMinor: reward,
      currency: spend.currency,
      baselineMinor: spend.minor, // only spend AFTER the spin counts
      expiresAt: new Date(Date.now() + cfg.expiryDays * 86_400_000),
    },
  });
  return { ok: true, challenge: await viewOf(c) };
}

/**
 * Claim a completed challenge. Verified from real completed orders, credited
 * once — the ledger's unique idempotency key makes a double-tap impossible.
 */
export async function claimChallenge(userId: string, challengeId: string): Promise<{ ok: boolean; reason?: string; creditedMinor?: number }> {
  const c = await prisma.spinChallenge.findFirst({ where: { id: challengeId, userId } });
  if (!c) return { ok: false, reason: "NOT_FOUND" };
  if (c.status !== "ACTIVE") return { ok: false, reason: "ALREADY_CLAIMED" };
  if (c.expiresAt < new Date()) {
    await prisma.spinChallenge.update({ where: { id: c.id }, data: { status: "EXPIRED" } });
    return { ok: false, reason: "EXPIRED" };
  }
  const v = await viewOf(c);
  if (!v.claimable) return { ok: false, reason: "NOT_REACHED" };

  // Pay in the WALLET's currency, capped again as a belt-and-braces check.
  const w = await prisma.wallet.findUnique({ where: { userId }, select: { currency: true } });
  const walletCur = (w?.currency ?? c.currency) as Currency;
  const capped = Math.min(c.rewardMinor, rewardFor(c.targetMinor, REWARD_CAP_BP));
  const credit = walletCur === (c.currency as Currency) ? capped : convertMinor(capped, c.currency as Currency, walletCur);

  await prisma.spinChallenge.update({ where: { id: c.id }, data: { status: "COMPLETED", claimedAt: new Date() } });
  await adjustWallet({
    userId,
    amountMinor: BigInt(credit),
    type: "CASHBACK",
    note: `Spin challenge reward (target ${(c.targetMinor / 100).toFixed(2)})`,
    idempotencyKey: `spin:${c.id}`,
  });
  await invalidate(`loyal:spend:${userId}`).catch(() => undefined);
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { telegramId: true } });
  if (u?.telegramId) {
    await enqueueTelegramMessage(
      u.telegramId,
      `🎉 <b>Challenge complete!</b>\n\n💰 <b>${(credit / 100).toFixed(2)}</b> has been added to your wallet.\n\nSpin again for a new challenge. 🎡`,
    ).catch(() => undefined);
  }
  return { ok: true, creditedMinor: credit };
}

export async function spinStats(): Promise<{ active: number; completed: number; paidMinor: number }> {
  const [active, completed, agg] = await Promise.all([
    prisma.spinChallenge.count({ where: { status: "ACTIVE" } }),
    prisma.spinChallenge.count({ where: { status: "COMPLETED" } }),
    prisma.spinChallenge.aggregate({ where: { status: "COMPLETED" }, _sum: { rewardMinor: true } }),
  ]);
  return { active, completed, paidMinor: agg._sum.rewardMinor ?? 0 };
}

/* ── Per-purchase spin: 1 purchase = 1 spin ───────────────────────────────── */

export interface PurchaseSpinResult {
  ok: boolean;
  reason?: "DISABLED" | "NOT_FOUND" | "NOT_ELIGIBLE" | "ALREADY_SPUN" | "DAILY_LIMIT" | "ON_MISSION";
  spinsToday?: number;
  maxSpinsPerDay?: number;
  won?: boolean;
  rewardMinor?: number;
  orderValueMinor?: number;
  minSpendMinor?: number;
  currency?: Currency;
}

/** Has this order already been spun? */
export async function orderSpun(orderId: string): Promise<boolean> {
  if (!orderId) return false;
  return (await prisma.spinChallenge.findUnique({ where: { orderId }, select: { id: true } })) !== null;
}

/**
 * One spin per completed purchase.
 * Below `minSpendMinor` the spin loses ("better luck next time"). Otherwise the
 * reward is 2% of the order, hard-capped by `maxRewardMinor` — so a big order
 * cannot pay out more than the ceiling you set.
 * Credited once: the ledger key is derived from the ORDER, not the spin row.
 */
export async function spinForOrder(userId: string, orderId: string): Promise<PurchaseSpinResult> {
  const cfg = await getSpinConfig();
  if (!cfg.enabled || !(await promoEnabled("spin"))) return { ok: false, reason: "DISABLED" };

  // Daily cap, regardless of how many orders they place.
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  // A customer on a Mission has chosen that reward path — no spins as well.
  if (await activeChallenge(userId)) return { ok: false, reason: "ON_MISSION" };

  const spinsToday = await prisma.spinChallenge.count({ where: { userId, createdAt: { gte: dayStart }, orderId: { not: null } } });
  if (spinsToday >= cfg.maxSpinsPerDay) {
    return { ok: false, reason: "DAILY_LIMIT", spinsToday, maxSpinsPerDay: cfg.maxSpinsPerDay };
  }

  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    select: { status: true, subtotalMinor: true, discountMinor: true, currency: true },
  });
  if (!order) return { ok: false, reason: "NOT_FOUND" };
  if (!["COMPLETED", "PAID", "PENDING_FULFILLMENT"].includes(order.status)) return { ok: false, reason: "NOT_ELIGIBLE" };
  if (await orderSpun(orderId)) return { ok: false, reason: "ALREADY_SPUN" };

  const value = Math.max(0, order.subtotalMinor - order.discountMinor);
  const orderCur = order.currency as Currency;
  // Compare against the threshold in the ORDER's currency.
  const threshold = orderCur === "USD" ? cfg.minSpendMinor : convertMinor(cfg.minSpendMinor, "USD" as Currency, orderCur);
  const won = value >= threshold;

  // Randomised between 0.01% (1bp) and the configured rate, then hard-capped —
  // so two identical orders do not always pay the same, but nothing exceeds the ceiling.
  const drawnBp = 1 + Math.floor(Math.random() * Math.max(1, Math.min(REWARD_CAP_BP, cfg.rewardBp)));
  const capped = Math.min(cfg.maxRewardMinor, rewardFor(value, drawnBp));
  const reward = won ? Math.max(1, capped) : 0;

  // Record the spin first, so a double-tap cannot produce a second one.
  const row = await prisma.spinChallenge
    .create({
      data: {
        orderId, userId, won,
        targetMinor: value, rewardMinor: reward, currency: orderCur,
        baselineMinor: value, status: "COMPLETED", claimedAt: new Date(),
        expiresAt: new Date(),
      },
    })
    .catch(() => null);
  if (!row) return { ok: false, reason: "ALREADY_SPUN" };

  if (won && reward > 0) {
    const w = await prisma.wallet.findUnique({ where: { userId }, select: { currency: true } });
    const walletCur = (w?.currency ?? orderCur) as Currency;
    const credit = walletCur === orderCur ? reward : convertMinor(reward, orderCur, walletCur);
    await adjustWallet({
      userId,
      amountMinor: BigInt(Math.max(1, credit)),
      type: "CASHBACK",
      note: `Spin win on order`,
      idempotencyKey: `spin-order:${orderId}`,
    });
    await invalidate(`loyal:spend:${userId}`).catch(() => undefined);
  }
  return {
    ok: true, won, rewardMinor: reward, orderValueMinor: value, minSpendMinor: threshold,
    currency: orderCur, spinsToday: spinsToday + 1, maxSpinsPerDay: cfg.maxSpinsPerDay,
  };
}
