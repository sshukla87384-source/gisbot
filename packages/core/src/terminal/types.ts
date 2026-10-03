/**
 * One blockchain the terminal can accept on. Amounts cross this boundary as
 * bigint "units" (wei / sun / lamports / nanoton / litoshi) — never floats.
 */
export interface ChainAdapter {
  /** Network code — matches the picker catalogue (usdtbsc, usdttrc20, usdtmatic, sol, ton, ltc). */
  readonly code: string;
  readonly asset: string;
  readonly chainLabel: string;
  readonly decimals: number;
  /** true for a stablecoin pegged to USD (quote = USD amount). */
  readonly stable: boolean;
  /** Confirmations shown to the customer and required before settlement. */
  readonly confirmations: number;
  /** CoinGecko id for non-stable assets. */
  readonly priceId?: string;
  /** How many decimals to show in the quote. */
  readonly quoteDecimals: number;
  /** Below this USD value a sweep costs more than it moves — leave it. */
  readonly defaultSweepMinUsd: number;

  /** Receive address for derivation slot `index` (0 = main / gas address). */
  address(index: number): Promise<string>;
  /** Is `addr` a plausible address on this chain (payout wallet validation). */
  validateAddress(addr: string): boolean;
  /**
   * What has arrived at a payment address so far.
   * `confirmed` has the chain's required confirmations; `pending` is seen but
   * not yet settled (shown to the customer as "confirming…").
   */
  scan(address: string, index: number): Promise<{ confirmed: bigint; pending: bigint; txids: string[] }>;
  /**
   * Move everything from slot `index` to `payout`. May need more than one tick
   * (e.g. gas has to arrive first): returns `pending` to be called again later,
   * `skipped` when there is nothing worth moving, `done` with the txid.
   */
  sweep(index: number, payout: string, minUnits: bigint): Promise<SweepResult>;
  /** Gas / fee funding the operator must keep topped up, if the chain needs any. */
  gas(): Promise<GasInfo | null>;
}

export type SweepResult =
  | { kind: "done"; txid: string; amount: bigint }
  | { kind: "pending"; note: string }
  | { kind: "skipped"; note: string };

export interface GasInfo {
  address: string;
  symbol: string;
  /** Human amount, e.g. "0.0421". */
  balance: string;
  /** Operator should top up. */
  low: boolean;
  hint: string;
}

/** Format units → decimal string without exponent, trailing zeros trimmed. */
export function fmtUnits(units: bigint, decimals: number, maxDp = decimals): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const s = abs.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals) || "0";
  let frac = decimals > 0 ? s.slice(s.length - decimals) : "";
  if (maxDp < decimals) frac = frac.slice(0, maxDp);
  frac = frac.replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

/** Decimal string → units (truncates beyond `decimals`). */
export function parseUnits(amount: string, decimals: number): bigint {
  const m = /^\s*(\d*)(?:\.(\d*))?\s*$/.exec(amount);
  if (!m) throw new Error(`bad amount ${amount}`);
  const int = m[1] || "0";
  const frac = (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(int) * 10n ** BigInt(decimals) + (decimals > 0 ? BigInt(frac) : 0n);
}

/** Simple JSON GET/POST with a timeout; throws on non-2xx with the body excerpt. */
export async function httpJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 15_000, ...rest } = init;
  const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${url.split("?")[0]}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`non-JSON from ${url.split("?")[0]}: ${text.slice(0, 120)}`);
  }
}
