import { getRedis } from "../redis.js";
import { httpJson } from "./types.js";

/**
 * USD prices for the volatile coins the terminal quotes (SOL, TON, LTC).
 * CoinGecko's public endpoint, no key, cached two minutes so a burst of
 * checkouts is one request. A stale price (up to 30 min) is better than no
 * checkout when the feed hiccups; beyond that the coin is simply not offered.
 */
const IDS = "solana,the-open-network,litecoin,binancecoin,matic-network,tron";
const KEY = "terminal:prices";
const STALE_KEY = "terminal:prices:stale";

export type PriceMap = Record<string, number>;

export async function getUsdPrices(): Promise<PriceMap> {
  const redis = getRedis();
  try {
    const raw = await redis.get(KEY);
    if (raw) return JSON.parse(raw) as PriceMap;
  } catch { /* fetch */ }
  try {
    const r = await httpJson<Record<string, { usd?: number }>>(`https://api.coingecko.com/api/v3/simple/price?ids=${IDS}&vs_currencies=usd`, { timeoutMs: 10_000 });
    const out: PriceMap = {};
    for (const [id, v] of Object.entries(r)) if (typeof v.usd === "number" && v.usd > 0) out[id] = v.usd;
    if (Object.keys(out).length === 0) throw new Error("empty price response");
    await redis.set(KEY, JSON.stringify(out), "EX", 120).catch(() => undefined);
    await redis.set(STALE_KEY, JSON.stringify(out), "EX", 1800).catch(() => undefined);
    return out;
  } catch (e) {
    try {
      const stale = await redis.get(STALE_KEY);
      if (stale) return JSON.parse(stale) as PriceMap;
    } catch { /* fall through */ }
    throw e instanceof Error ? e : new Error(String(e));
  }
}

export async function usdPrice(priceId: string): Promise<number> {
  const p = (await getUsdPrices())[priceId];
  if (!p) throw new Error(`no USD price for ${priceId}`);
  return p;
}
