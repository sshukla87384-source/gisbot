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
  /** Buy this many or more to earn the bulk discount. */
  bulkMinQty?: number | null;
  /** Bulk discount in basis points (1000 = 10% off each unit). */
  bulkPercentBp?: number | null;
}

/** Does this quantity qualify for the product's bulk tier? */
export function isBulkActive(p: SaleFields, qty: number): boolean {
  return Boolean(p.bulkMinQty && p.bulkPercentBp && p.bulkPercentBp > 0 && qty >= p.bulkMinQty);
}

export function isSaleActive(p: SaleFields, now: Date = new Date()): boolean {
  if (!p.salePercentBp || p.salePercentBp <= 0) return false;
  if (p.saleStartsAt && p.saleStartsAt.getTime() > now.getTime()) return false;
  if (p.saleEndsAt && p.saleEndsAt.getTime() <= now.getTime()) return false;
  return true;
}

/** Discounted price in minor units (rounded), or the original if no sale is active. */
export function effectivePriceMinor(
  amountMinor: number,
  p: SaleFields,
  now: Date = new Date(),
  qty = 1,
): number {
  const saleBp = isSaleActive(p, now) ? (p.salePercentBp ?? 0) : 0;
  const bulkBp = isBulkActive(p, qty) ? (p.bulkPercentBp ?? 0) : 0;
  // The BETTER of the two, never both. Stacking a 50% sale onto a 50% bulk tier
  // would sell at a quarter price, which no operator setting either of those
  // numbers intends.
  const bp = Math.min(Math.max(Math.max(saleBp, bulkBp), 0), 9000); // cap at 90% off
  if (bp === 0) return amountMinor;
  return Math.round((amountMinor * (10000 - bp)) / 10000);
}
