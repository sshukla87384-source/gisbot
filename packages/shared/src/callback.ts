import { z } from "zod";

/**
 * Telegram callback-data codec (Bot UX doc §1).
 * Format: <ns>:<action>[:arg...] — hard 64-byte Telegram limit enforced at build time.
 */
export function cb(...parts: Array<string | number>): string {
  const data = parts.join(":");
  if (Buffer.byteLength(data, "utf8") > 64) {
    throw new Error(`callback_data exceeds 64 bytes: ${data}`);
  }
  return data;
}

export const callbackSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9_:\-.]+$/i, "malformed callback data");

export interface ParsedCallback {
  ns: string;
  action: string;
  args: string[];
}

/** Parse and validate incoming callback data. Returns null for anything unexpected. */
export function parseCb(data: unknown): ParsedCallback | null {
  const checked = callbackSchema.safeParse(data);
  if (!checked.success) return null;
  const [ns, action, ...args] = checked.data.split(":");
  if (!ns || !action) return null;
  return { ns, action, args };
}

export function intArg(args: string[], index: number, fallback = 0): number {
  const raw = args[index];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
