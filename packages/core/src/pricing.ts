/**
 * Flash-sale pricing. A product carries an optional percentage discount
 * (basis points) active within an optional [saleStartsAt, saleEndsAt] window.
 * The same helper is used for display (bot) and for the actual charge
 * (checkout re-pricing), so a sale is never merely cosmetic.
 */
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
