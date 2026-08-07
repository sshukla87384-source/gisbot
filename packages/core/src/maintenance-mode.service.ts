import { prisma } from "@gis/database";
import { getRedis } from "./redis.js";

/**
 * Shop-wide maintenance mode.
 *
 * `maintenance.enabled` has been seeded since the beginning but nothing ever
 * read it and no UI ever set it, so the shop could not actually be closed.
 * This is the missing half.
 *
 * The flag is cached in Redis because it is checked on EVERY customer update;
 * hitting Postgres each time would put a query in front of every keystroke.
 */
const KEY = "maintenance.enabled";
const MSG_KEY = "maintenance.message";
const CACHE = "maint:on";
const CACHE_MSG = "maint:msg";
const TTL_SEC = 30;

export const DEFAULT_MAINTENANCE_MESSAGE =
  "🛠 <b>We're briefly closed for maintenance.</b>\n\nYour account, wallet balance and past orders are all safe. Please check back shortly.";

export interface MaintenanceState {
  enabled: boolean;
  message: string;
}

/** Read the flag, Redis-cached. Falls back to OPEN if the DB is unreachable. */
export async function getMaintenance(): Promise<MaintenanceState> {
  try {
    const redis = getRedis();
    const [on, msg] = await Promise.all([redis.get(CACHE), redis.get(CACHE_MSG)]);
    if (on !== null) return { enabled: on === "1", message: msg || DEFAULT_MAINTENANCE_MESSAGE };
  } catch { /* cache miss or Redis down → read through */ }

  try {
    const [row, msgRow] = await Promise.all([
      prisma.setting.findUnique({ where: { key: KEY } }),
      prisma.setting.findUnique({ where: { key: MSG_KEY } }),
    ]);
    // Seeded as a bare boolean; the admin toggle writes { on: boolean }.
    // Accept both so an existing seeded value is not misread as "closed".
    const raw = row?.value as unknown;
    const enabled = typeof raw === "boolean" ? raw : (raw as { on?: boolean } | null)?.on === true;
    const message = ((msgRow?.value as { text?: string } | null)?.text ?? "").trim() || DEFAULT_MAINTENANCE_MESSAGE;
    try {
      const redis = getRedis();
      await Promise.all([
        redis.set(CACHE, enabled ? "1" : "0", "EX", TTL_SEC),
        redis.set(CACHE_MSG, message, "EX", TTL_SEC),
      ]);
    } catch { /* caching is best-effort */ }
    return { enabled, message };
  } catch {
    // Never lock customers out because a lookup failed.
    return { enabled: false, message: DEFAULT_MAINTENANCE_MESSAGE };
  }
}

export async function setMaintenance(enabled: boolean, message?: string): Promise<MaintenanceState> {
  const value = { on: enabled };
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
  if (message !== undefined) {
    const text = message.trim().slice(0, 1000);
    await prisma.setting.upsert({
      where: { key: MSG_KEY },
      create: { key: MSG_KEY, value: { text } },
      update: { value: { text } },
    });
  }
  // Drop the cache so the change takes effect immediately rather than in 30s.
  try {
    const redis = getRedis();
    await Promise.all([redis.del(CACHE), redis.del(CACHE_MSG)]);
  } catch { /* ignore */ }
  return getMaintenance();
}
