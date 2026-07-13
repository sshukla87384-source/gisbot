export type CurrencyCode = "INR" | "USD" | "XTR";

interface CurrencyMeta {
  decimals: number;
  locale: string;
  symbol: string;
}

const META: Record<CurrencyCode, CurrencyMeta> = {
  INR: { decimals: 2, locale: "en-IN", symbol: "₹" },
  USD: { decimals: 2, locale: "en-US", symbol: "$" },
  XTR: { decimals: 0, locale: "en-US", symbol: "⭐" },
};

/** Format integer minor units (paise/cents) for display. Never use floats for arithmetic. */
export function formatMinor(amountMinor: number | bigint, currency: CurrencyCode): string {
  const meta = META[currency];
  const minor = typeof amountMinor === "bigint" ? amountMinor : BigInt(Math.trunc(amountMinor));
  const divisor = BigInt(10 ** meta.decimals);
  const major = minor / divisor;
  const frac = (minor % divisor < 0n ? -(minor % divisor) : minor % divisor).toString().padStart(meta.decimals, "0");
  const majorStr = new Intl.NumberFormat(meta.locale).format(major);
  return meta.decimals === 0 ? `${meta.symbol}${majorStr}` : `${meta.symbol}${majorStr}.${frac}`;
}
