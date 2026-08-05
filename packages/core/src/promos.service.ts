import { prisma } from "@gis/database";

/**
 * Master on/off switches for every reward programme, so an admin can stop a
 * promotion instantly without a deploy. Checked at the point money would be
 * credited, not just where a button is drawn — turning something off must stop
 * the payout, not merely hide the entry point.
 */

const KEY = "promos.flags";

export type PromoKey = "spin" | "referral" | "loyalty" | "cashback";

export interface PromoFlags { spin: boolean; referral: boolean; loyalty: boolean; cashback: boolean }

const DEFAULTS: PromoFlags = { spin: true, referral: true, loyalty: true, cashback: true };

let cache: PromoFlags = DEFAULTS;
let loadedAt = 0;
const TTL = 30_000;

export async function getPromoFlags(): Promise<PromoFlags> {
  if (Date.now() - loadedAt < TTL) return cache;
  try {
    const row = await prisma.setting.findUnique({ where: { key: KEY } });
    const v = (row?.value ?? null) as Partial<PromoFlags> | null;
    cache = {
      spin: v?.spin ?? DEFAULTS.spin,
      referral: v?.referral ?? DEFAULTS.referral,
      loyalty: v?.loyalty ?? DEFAULTS.loyalty,
      cashback: v?.cashback ?? DEFAULTS.cashback,
    };
  } catch {
    /* keep last known */
  }
  loadedAt = Date.now();
  return cache;
}

/** Synchronous read of the cached flags, for hot paths. */
export function promoFlagsCached(): PromoFlags {
  return cache;
}

export async function promoEnabled(key: PromoKey): Promise<boolean> {
  return (await getPromoFlags())[key];
}

export async function setPromoFlag(key: PromoKey, on: boolean): Promise<PromoFlags> {
  const cur = await getPromoFlags();
  const next = { ...cur, [key]: on };
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: next as never }, update: { value: next as never } });
  cache = next;
  loadedAt = Date.now();
  return next;
}
