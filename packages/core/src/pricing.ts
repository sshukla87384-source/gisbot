/**
 * Flash-sale pricing. A product carries an optional percentage discount
 * (basis points) active within an optional [saleStartsAt, saleEndsAt] window.
 * The same helper is used for display (bot) and for the actual charge
 * (checkout re-pricing), so a sale is never merely cosmetic.
 */
import { loadConfig } from "@gis/config";

export interface SaleFields {
  salePercentBp: number | null;
  saleStartsAt: Date | null;
  saleEndsAt: Date | null;
}

export function isSaleActive(p: SaleFields, now: Date = new Date()): boolean {
  if (!p.salePercentBp || p.salePercentBp <= 0) return false;
  if (p.saleStartsAt && p.saleStartsAt.getTime() > now.getTime()) return false;
  if (p.saleEndsAt && p.saleEndsAt.getTime() <= now.getTime()) return false;
  return true;
}

/** Discounted price in minor units (rounded), or the original if no sale is active. */
export function effectivePriceMinor(amountMinor: number, p: SaleFields, now: Date = new Date()): number {
  if (!isSaleActive(p, now)) return amountMinor;
  const bp = Math.min(Math.max(p.salePercentBp ?? 0, 0), 9000); // cap at 90% off
  return Math.round((amountMinor * (10000 - bp)) / 10000);
}

/**
 * Resolve a retail price in the requested currency. If a product was priced in
 * only one currency (e.g. INR only from the web panel), convert to the other
 * using the wizard's rate — so every product stays visible AND buyable no matter
 * which currency the customer is on. Returns null only when there is no price at all.
 */
export function priceInCurrency(
  prices: Array<{ currency: string; amountMinor: number }>,
  want: "INR" | "USD",
): number | null {
  const exact = prices.find((p) => p.currency === want);
  if (exact) return exact.amountMinor;
  const other = prices[0];
  if (!other) return null;
  const rate = loadConfig().BINANCE_USDT_INR_RATE || 90; // INR per USD
  if (want === "USD" && other.currency === "INR") return Math.max(1, Math.round(other.amountMinor / rate));
  if (want === "INR" && other.currency === "USD") return Math.max(1, Math.round(other.amountMinor * rate));
  return other.amountMinor;
}
