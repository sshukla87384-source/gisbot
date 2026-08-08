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
  /** Quantity discount ladder. */
  bulkTiers?: unknown;
}

export interface BulkTier {
  minQty: number;
  percentBp: number;
}

/**
 * Read a product's discount ladder, sorted by quantity.
 *
 * Tolerates junk: a malformed row is dropped rather than throwing, because a
 * bad tier must never take a product off sale. Falls back to the legacy single
 * tier so products configured before the ladder existed keep working.
 */
export function bulkTiersOf(p: SaleFields): BulkTier[] {
  const raw = Array.isArray(p.bulkTiers) ? p.bulkTiers : [];
  const tiers: BulkTier[] = [];
  for (const t of raw) {
    const minQty = Number((t as { minQty?: unknown })?.minQty);
    const percentBp = Number((t as { percentBp?: unknown })?.percentBp);
    if (!Number.isFinite(minQty) || !Number.isFinite(percentBp)) continue;
    if (minQty < 2 || percentBp <= 0 || percentBp > 9000) continue;
    tiers.push({ minQty: Math.round(minQty), percentBp: Math.round(percentBp) });
  }
  if (tiers.length === 0 && p.bulkMinQty && p.bulkPercentBp && p.bulkPercentBp > 0) {
    tiers.push({ minQty: p.bulkMinQty, percentBp: p.bulkPercentBp });
  }
  return tiers.sort((a, b) => a.minQty - b.minQty);
}

/**
 * The best discount this quantity earns, in basis points.
 *
 * Takes the largest percentage among qualifying tiers rather than the
 * highest quantity, so a ladder entered out of order — or one where a bigger
 * quantity was given a smaller discount by mistake — never charges a bulk
 * buyer more than a smaller order would have.
 */
export function bulkBpFor(p: SaleFields, qty: number): number {
  let best = 0;
  for (const t of bulkTiersOf(p)) if (qty >= t.minQty && t.percentBp > best) best = t.percentBp;
  return best;
}

/** Does this quantity qualify for any bulk tier? */
export function isBulkActive(p: SaleFields, qty: number): boolean {
  return bulkBpFor(p, qty) > 0;
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
  const bulkBp = bulkBpFor(p, qty);
  // The BETTER of the two, never both. Stacking a 50% sale onto a 50% bulk tier
  // would sell at a quarter price, which no operator setting either of those
  // numbers intends.
  const bp = Math.min(Math.max(Math.max(saleBp, bulkBp), 0), 9000); // cap at 90% off
  if (bp === 0) return amountMinor;
  return Math.round((amountMinor * (10000 - bp)) / 10000);
}
