import { getRedis } from "./redis.js";

/**
 * Lightweight in-bot log ring. Kept in Redis (capped lists) rather than a table
 * so writing a log line can never slow down or fail a payment path.
 */
export type LogChannel = "error" | "wallet" | "payment" | "supplier";

const KEY = (c: LogChannel): string => `logs:${c}`;
const CAP = 200;

export interface LogEntry {
  at: string;
  level: "error" | "warn" | "info";
  where: string;
  message: string;
  meta?: Record<string, string | number | null>;
}

/** Never throws — logging must not break the thing it is logging. */
export async function logEvent(
  channel: LogChannel,
  level: LogEntry["level"],
  where: string,
  message: string,
  meta?: LogEntry["meta"],
): Promise<void> {
  try {
    const entry: LogEntry = { at: new Date().toISOString(), level, where, message: String(message).slice(0, 600), meta };
    const r = getRedis();
    await r.lpush(KEY(channel), JSON.stringify(entry));
    await r.ltrim(KEY(channel), 0, CAP - 1);
  } catch {
    /* ignore */
  }
}

export const logError = (where: string, err: unknown, meta?: LogEntry["meta"]): Promise<void> =>
  logEvent("error", "error", where, err instanceof Error ? `${err.name}: ${err.message}` : String(err), meta);

export const logWallet = (where: string, message: string, meta?: LogEntry["meta"]): Promise<void> =>
  logEvent("wallet", "warn", where, message, meta);

export async function readLogs(channel: LogChannel, limit = 15): Promise<LogEntry[]> {
  try {
    const raw = await getRedis().lrange(KEY(channel), 0, Math.max(1, limit) - 1);
    return raw.map((r) => JSON.parse(r) as LogEntry);
  } catch {
    return [];
  }
}

export async function clearLogs(channel: LogChannel): Promise<void> {
  try { await getRedis().del(KEY(channel)); } catch { /* ignore */ }
}

export async function logCounts(): Promise<Record<LogChannel, number>> {
  const out = { error: 0, wallet: 0, payment: 0, supplier: 0 } as Record<LogChannel, number>;
  try {
    const r = getRedis();
    for (const c of ["error", "wallet", "payment", "supplier"] as LogChannel[]) out[c] = await r.llen(KEY(c));
  } catch { /* ignore */ }
  return out;
}
