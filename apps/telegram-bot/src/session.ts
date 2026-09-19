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
      if (!raw) return undefined;
      try {
        return JSON.parse(raw) as SessionData;
      } catch {
        // A truncated or hand-edited value used to throw out of the session
        // middleware on EVERY update, which bricked that chat until the key
        // expired 24 h later. Starting fresh loses a half-finished wizard; the
        // alternative lost the whole bot for that customer.
        return undefined;
      }
    },
    async write(k, value) {
      await redis.set(key(k), JSON.stringify(value), "EX", TTL_SECONDS);
    },
    async delete(k) {
      await redis.del(key(k));
    },
  };
}
