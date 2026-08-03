import { loadConfig } from "@gis/config";
import { prisma, type Currency } from "@gis/database";

/** Default INR per 1 USDT when the admin has not set one. */
export const INR_PER_USDT_DEFAULT = 100;
const SETTING_KEY = "fx.inr_per_usdt";
const TTL_MS = 60_000;

// Single in-process copy of the rate so every conversion in a request agrees.
// Kept sync for callers, refreshed from the DB in the background.
let cachedRate = INR_PER_USDT_DEFAULT;
let loadedAt = 0;

/**
 * Units of `currency` per 1 USDT — THE one rate used for every INR↔USDT
 * conversion (wallet deductions, deposits, Binance quotes, price display), so
 * they can never disagree. Editable by the admin; defaults to 100.
 */
export function usdtRate(currency: Currency): number {
  if (currency === "INR") return cachedRate;
  return loadConfig().BINANCE_USDT_USD_RATE; // USD per USDT (normally 1)
}

/** Read the admin-set rate, refreshing the cache when stale. */
export async function getInrPerUsdt(): Promise<number> {
  if (Date.now() - loadedAt < TTL_MS) return cachedRate;
  try {
    const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
    const v = Number((row?.value as { rate?: number } | null)?.rate);
    cachedRate = Number.isFinite(v) && v > 0 ? v : INR_PER_USDT_DEFAULT;
  } catch {
    // DB unavailable — keep whatever we had
  }
  loadedAt = Date.now();
  return cachedRate;
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Load the rate at startup AND keep it fresh. Every process (bot, worker, api)
 * re-reads it periodically, so an admin edit reaches them all without a restart.
 */
export async function primeFxRate(): Promise<number> {
  loadedAt = 0;
  const v = await getInrPerUsdt();
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      loadedAt = 0;
      void getInrPerUsdt().catch(() => undefined);
    }, TTL_MS);
    refreshTimer.unref?.(); // never hold the process open
  }
  return v;
}

/** Admin: set how many INR equal 1 USDT (e.g. 100). */
export async function setInrPerUsdt(rate: number): Promise<number> {
  const v = Number(rate);
  if (!Number.isFinite(v) || v <= 0) throw new Error("Rate must be a positive number");
  const value = { rate: v };
  await prisma.setting.upsert({ where: { key: SETTING_KEY }, create: { key: SETTING_KEY, value }, update: { value } });
  cachedRate = v;
  loadedAt = Date.now();
  return v;
}

/** Convert an integer minor-unit amount between currencies. Rounds to the nearest minor unit. */
export function convertMinor(amountMinor: number, from: Currency, to: Currency): number {
  if (from === to) return Math.round(amountMinor);
  const inUsdt = amountMinor / usdtRate(from);
  return Math.round(inUsdt * usdtRate(to));
}

/** The USDT value of a minor-unit amount, as a 2dp string (what a customer actually sends/spends). */
export function toUsdt(amountMinor: number, currency: Currency): string {
  return (amountMinor / 100 / usdtRate(currency)).toFixed(2);
}
