import { loadConfig } from "@gis/config";
import type { Currency } from "@gis/database";

/**
 * Cross-currency conversion for wallet charges. Rates are the same ones used to
 * quote Binance deposits, so a deposit and a purchase always agree:
 *   BINANCE_USDT_INR_RATE = INR per 1 USDT, BINANCE_USDT_USD_RATE = USD per 1 USDT.
 */
export function usdtRate(currency: Currency): number {
  const cfg = loadConfig();
  return currency === "INR" ? cfg.BINANCE_USDT_INR_RATE : cfg.BINANCE_USDT_USD_RATE;
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
