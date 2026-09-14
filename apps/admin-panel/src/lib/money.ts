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

/** Parse a major-unit input ("149.99") into integer minor units (14999). Returns null when invalid. */
export function toMinor(major: string | number): number | null {
  const value = typeof major === "number" ? major : Number.parseFloat(major.trim());
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/** Convert minor units to a major-unit string suitable for an <input>. */
export function fromMinor(minor: number | null | undefined): string {
  if (typeof minor !== "number" || !Number.isFinite(minor)) return "";
  return (minor / 100).toFixed(2);
}
