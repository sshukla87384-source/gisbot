import { loadConfig } from "@gis/config";
import type { Currency } from "@gis/database";

/**
 * THE single INR↔USDT rate for the whole store: exactly 100 INR = 1 USDT.
 * Pinned deliberately (not read from env) so a deposit, a wallet deduction, a
 * Binance quote and a price conversion can never disagree with each other.
 */
export const INR_PER_USDT = 100;

/** Units of `currency` per 1 USDT. */
export function usdtRate(currency: Currency): number {
  if (currency === "INR") return INR_PER_USDT;
  return loadConfig().BINANCE_USDT_USD_RATE; // USD per USDT (normally 1)
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
