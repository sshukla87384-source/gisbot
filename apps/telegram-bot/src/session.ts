import { getRedis } from "@gis/core";
import type { StorageAdapter } from "grammy";
import type { SessionData } from "./ctx.js";

const TTL_SECONDS = 60 * 60 * 24; // 24 h (Architecture doc §3.5)

/** Redis-backed grammY session storage — stateless bot processes. */
export function redisSessionStorage(): StorageAdapter<SessionData> {
  const redis = getRedis();
  const key = (k: string) => `bot:sess:${k}`;
  return {
    async read(k) {
      const raw = await redis.get(key(k));
      return raw ? (JSON.parse(raw) as SessionData) : undefined;
    },
    async write(k, value) {
      await redis.set(key(k), JSON.stringify(value), "EX", TTL_SECONDS);
    },
    async delete(k) {
      await redis.del(key(k));
    },
  };
}
