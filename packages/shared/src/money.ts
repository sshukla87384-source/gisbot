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
  // Sign is carried by hand: -50 paise has a major part of 0n, so the minus
  // would vanish if we let the number formatter print it.
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const sign = negative ? "-" : "";
  const major = abs / divisor;
  const frac = (abs % divisor).toString().padStart(meta.decimals, "0");
  const majorStr = new Intl.NumberFormat(meta.locale).format(major);
  return meta.decimals === 0 ? `${sign}${meta.symbol}${majorStr}` : `${sign}${meta.symbol}${majorStr}.${frac}`;
}
