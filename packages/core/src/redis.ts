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

/** Cache-aside helper with JSON serialization (Architecture doc §3.5). */
export async function cached<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
  const redis = getRedis();
  const hit = await redis.get(key);
  if (hit !== null) return JSON.parse(hit) as T;
  const value = await fn();
  await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  return value;
}

export async function invalidate(pattern: string): Promise<void> {
  const redis = getRedis();
  const keys = await redis.keys(pattern);
  if (keys.length > 0) await redis.del(...keys);
}
