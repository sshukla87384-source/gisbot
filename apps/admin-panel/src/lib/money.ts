/** Minor-unit decimals per currency — must match packages/shared/src/money.ts. */
const DECIMALS: Record<string, number> = { INR: 2, USD: 2, XTR: 0 };

/** Format an integer minor-unit amount (paise/cents) as a currency string. */
export function formatMinor(minor: number | null | undefined, currency: string | null | undefined): string {
  const code = currency && currency.length === 3 ? currency : "INR";
  const decimals = DECIMALS[code] ?? 2;
  const amount = (minor ?? 0) / 10 ** decimals;
  try {
    return new Intl.NumberFormat(code === "INR" ? "en-IN" : "en-US", {
      style: "currency",
      currency: code,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(amount);
  } catch {
    return `${amount.toFixed(decimals)} ${code}`;
  }
}

/** Decimals for a currency code, defaulting to 2 for anything unknown. */
function decimalsOf(currency?: string | null): number {
  const code = currency && currency.length === 3 ? currency : "";
  return DECIMALS[code] ?? 2;
}

/**
 * Parse a major-unit input ("149.99") into integer minor units (14999).
 * Returns null when invalid.
 *
 * `currency` matters: hard-coding ×100 turned a 500-Star wallet adjustment into
 * 50000 Stars, because XTR has NO minor unit (⭐1 = 1 minor unit).
 */
export function toMinor(major: string | number, currency?: string | null): number | null {
  const value = typeof major === "number" ? major : Number.parseFloat(major.trim());
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 10 ** decimalsOf(currency));
}

/** Convert minor units to a major-unit string suitable for an <input>. */
export function fromMinor(minor: number | null | undefined, currency?: string | null): string {
  if (typeof minor !== "number" || !Number.isFinite(minor)) return "";
  const decimals = decimalsOf(currency);
  return (minor / 10 ** decimals).toFixed(decimals);
}
