import { loadConfig } from "@gis/config";
import { Redis } from "ioredis";

const globalForRedis = globalThis as unknown as { __gisRedis?: Redis };

export function getRedis(): Redis {
  if (!globalForRedis.__gisRedis) {
    globalForRedis.__gisRedis = new Redis(loadConfig().REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
    });
  }
  return globalForRedis.__gisRedis;
}

/**
 * Namespace cache versions. Invalidating a namespace bumps a counter instead of
 * scanning and deleting keys, so it is O(1) and never blocks Redis. Stale keys
 * are simply orphaned and expire on their own TTL.
 */
const verMemo = new Map<string, { v: number; until: number }>();
const VER_MEMO_MS = 1000;

async function nsVersion(ns: string): Promise<number> {
  const now = Date.now();
  const memo = verMemo.get(ns);
  if (memo && memo.until > now) return memo.v;
  let v = 1;
  try {
    const raw = await getRedis().get(`cachever:${ns}`);
    v = raw ? Number.parseInt(raw, 10) || 1 : 1;
  } catch {
    v = 1;
  }
  verMemo.set(ns, { v, until: now + VER_MEMO_MS });
  return v;
}

/** Cache-aside helper with JSON serialization (Architecture doc §3.5). */
export async function cached<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
  const redis = getRedis();
  const ns = key.split(":")[0] ?? key;
  const versioned = `${ns}:v${await nsVersion(ns)}:${key.slice(ns.length + 1)}`;
  try {
    const hit = await redis.get(versioned);
    if (hit !== null) return JSON.parse(hit) as T;
  } catch {
    // cache unavailable — fall through and compute
  }
  const value = await fn();
  try {
    await redis.set(versioned, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    // best-effort
  }
  return value;
}

/**
 * Drop cached entries. A trailing `:*` (e.g. "cat:*") bumps that namespace's
 * version — instant, and the reason admin edits no longer stall the bot.
 * Anything else falls back to a non-blocking SCAN + UNLINK.
 */
export async function invalidate(pattern: string): Promise<void> {
  const redis = getRedis();
  if (pattern.endsWith(":*")) {
    const ns = pattern.slice(0, -2);
    try {
      const v = await redis.incr(`cachever:${ns}`);
      verMemo.set(ns, { v, until: Date.now() + VER_MEMO_MS });
    } catch {
      // best-effort
    }
    return;
  }
  // An EXACT key: delete it directly, using the same versioned name `cached`
  // wrote it under. This used to fall into the SCAN below and match nothing —
  // cached("a:b") is stored at "a:v3:b", so MATCH "a:b" never hit. So it deleted
  // nothing AND swept the entire keyspace to do it, thousands of round trips on
  // the same Redis connection grammY reads sessions from. It ran on every order.
  if (!pattern.includes("*")) {
    try {
      const ns = pattern.split(":")[0] ?? pattern;
      const versioned = `${ns}:v${await nsVersion(ns)}:${pattern.slice(ns.length + 1)}`;
      await redis.unlink(versioned);
    } catch {
      // best-effort
    }
    return;
  }
  try {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 200);
      cursor = next;
      if (keys.length > 0) await redis.unlink(...keys);
    } while (cursor !== "0");
  } catch {
    // best-effort
  }
}
