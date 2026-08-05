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
  await getInrSurchargeBp().catch(() => undefined);
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      loadedAt = 0;
      surchargeLoadedAt = 0;
      void getInrPerUsdt().catch(() => undefined);
      void getInrSurchargeBp().catch(() => undefined);
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

/**
 * Convert an integer minor-unit amount between currencies, rounding to the
 * nearest minor unit. A positive amount never converts to 0 — that would let a
 * tiny order be fulfilled for free.
 */
export function convertMinor(amountMinor: number, from: Currency, to: Currency): number {
  if (from === to) return Math.round(amountMinor);
  const inUsdt = amountMinor / usdtRate(from);
  const out = Math.round(inUsdt * usdtRate(to));
  if (amountMinor > 0 && out < 1) return 1;
  if (amountMinor < 0 && out > -1) return -1;
  return out;
}

/** The USDT value of a minor-unit amount, as a 2dp string. */
export function toUsdt(amountMinor: number, currency: Currency): string {
  return (amountMinor / 100 / usdtRate(currency)).toFixed(2);
}

/**
 * USDT to charge, as an exact 2dp string (Binance Pay has 2 decimals).
 *
 * Uses INTEGER arithmetic: `amountMinor` and the rate are both scaled by 100, so
 * usdtCents = round(amountMinor / rate). Float maths here is dangerous — an
 * earlier epsilon-nudged ceil() turned ₹2.00 into 0.03 USDT, a 50% overcharge.
 *
 * Rounds to NEAREST cent (never silently up), and a positive amount always
 * quotes at least 0.01. Always pair with `usdtToMinor` so the amount recorded
 * against the order equals the amount the customer was asked to send.
 */
export function toUsdtCharge(amountMinor: number, currency: Currency): string {
  const rate = usdtRate(currency); // currency units per USDT
  if (amountMinor <= 0) return "0.00";
  let cents = Math.round(amountMinor / rate);
  if (cents < 1) cents = 1;
  return (cents / 100).toFixed(2);
}

/** Smallest currency amount that maps to a whole USDT cent (used to avoid rounding). */
export function usdtCentInMinor(currency: Currency): number {
  return Math.max(1, Math.round(usdtRate(currency)));
}

/** Convert a USDT amount string back to minor units of `currency` (exact bookkeeping). */
export function usdtToMinor(usdt: string, currency: Currency): number {
  return Math.round(Number.parseFloat(usdt) * usdtRate(currency) * 100);
}

/* ── INR price surcharge ──────────────────────────────────────────────────────
 * INR/UPI costs you manual verification, so INR PRICES carry a surcharge to
 * steer customers toward instant USDT. Default 5%.
 *
 * Deliberately applied to PRICES ONLY — never to wallet balances, deposits or
 * refunds. Converting money someone already holds must stay exact, or a deposit
 * and a withdrawal of the same amount would not agree.
 */
const SURCHARGE_KEY = "fx.inr_surcharge_bp";
export const INR_SURCHARGE_BP_DEFAULT = 500; // 500bp = 5%

let cachedSurcharge = INR_SURCHARGE_BP_DEFAULT;
let surchargeLoadedAt = 0;

export function inrSurchargeBp(): number {
  return cachedSurcharge;
}

export async function getInrSurchargeBp(): Promise<number> {
  if (Date.now() - surchargeLoadedAt < TTL_MS) return cachedSurcharge;
  try {
    const row = await prisma.setting.findUnique({ where: { key: SURCHARGE_KEY } });
    const v = Number((row?.value as { bp?: number } | null)?.bp);
    cachedSurcharge = Number.isFinite(v) && v >= 0 ? v : INR_SURCHARGE_BP_DEFAULT;
  } catch {
    /* keep last known */
  }
  surchargeLoadedAt = Date.now();
  return cachedSurcharge;
}

/** Admin: set the INR price surcharge in basis points (500 = 5%). */
export async function setInrSurchargeBp(bp: number): Promise<number> {
  const v = Math.max(0, Math.min(5000, Math.round(bp))); // cap at 50% as a sanity guard
  await prisma.setting.upsert({
    where: { key: SURCHARGE_KEY },
    create: { key: SURCHARGE_KEY, value: { bp: v } as never },
    update: { value: { bp: v } as never },
  });
  cachedSurcharge = v;
  surchargeLoadedAt = Date.now();
  return v;
}

/** INR price for a USD price — FX rate PLUS the surcharge. */
export function priceInrFromUsd(usdMinor: number): number {
  const base = usdMinor * usdtRate("INR");
  return Math.max(1, Math.round((base * (10_000 + cachedSurcharge)) / 10_000));
}

/** USD price for an INR price — removes the surcharge, so the pair round-trips. */
export function priceUsdFromInr(inrMinor: number): number {
  const base = (inrMinor * 10_000) / (10_000 + cachedSurcharge);
  return Math.max(1, Math.round(base / usdtRate("INR")));
}

/**
 * Convert a PRICE between currencies (surcharge-aware). Use this for prices;
 * use convertMinor for balances.
 */
export function convertPriceMinor(amountMinor: number, from: Currency, to: Currency): number {
  if (from === to) return Math.round(amountMinor);
  if (from === "USD" && to === "INR") return priceInrFromUsd(amountMinor);
  if (from === "INR" && to === "USD") return priceUsdFromInr(amountMinor);
  return convertMinor(amountMinor, from, to);
}
