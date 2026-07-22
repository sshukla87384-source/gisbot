import { prisma, type Prisma } from "@gis/database";

type Tx = Prisma.TransactionClient;

async function settingInt(tx: Tx, key: string, fallback: number): Promise<number> {
  const r = await tx.setting.findUnique({ where: { key } });
  return typeof r?.value === "number" ? r.value : fallback;
}

export const REF_FIRST_KEY = "referral.reward_pct_bp";
export const REF_REPEAT_KEY = "referral.reward_pct_bp_repeat";
export const REF_HOLD_KEY = "referral.hold_hours";

/**
 * Create a held referral reward for the referrer, if the buyer was referred.
 * Tiered: first purchase = first-rate (default 5%), later purchases = repeat-rate
 * (default 2%). Both rates are admin-configurable. One reward per order (unique).
 */
export async function grantReferralRewardTx(
  tx: Tx,
  opts: { referrerId: string | null; referredId: string; orderId: string; netMinor: number; currency: "INR" | "USD"; isFirst: boolean },
): Promise<void> {
  if (!opts.referrerId || opts.netMinor <= 0) return;
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

export interface ReferralConfig { firstPct: number; repeatPct: number; holdHours: number }

export async function getReferralConfig(): Promise<ReferralConfig> {
  const rows = await prisma.setting.findMany({ where: { key: { in: [REF_FIRST_KEY, REF_REPEAT_KEY, REF_HOLD_KEY] } } });
  const val = (k: string, fb: number) => {
    const v = rows.find((r) => r.key === k)?.value;
    return typeof v === "number" ? v : fb;
  };
  return { firstPct: val(REF_FIRST_KEY, 500) / 100, repeatPct: val(REF_REPEAT_KEY, 200) / 100, holdHours: val(REF_HOLD_KEY, 48) };
}

/** Set a referral reward rate (percent, e.g. 5 or 2). */
export async function setReferralRate(kind: "first" | "repeat", pct: number): Promise<void> {
  const key = kind === "first" ? REF_FIRST_KEY : REF_REPEAT_KEY;
  const bp = Math.max(0, Math.round(pct * 100));
  await prisma.setting.upsert({ where: { key }, create: { key, value: bp }, update: { value: bp } });
}
