import { z } from "zod";

/**
 * Telegram callback-data codec (Bot UX doc §1).
 * Format: <ns>:<action>[:arg...] — hard 64-byte Telegram limit enforced at build time.
 */
/**
 * Characters allowed in callback data.
 *
 * `~` is the argument separator used throughout the admin panel
 * (`adm:suprmx:<id>~delete`). It was missing here, so parseCb rejected every
 * one of those payloads and the whole family of buttons — remove vendor, bulk
 * show/hide/delete products, supplier catalog paging and filters, reseller
 * payout limits, review rejection, button colour — did nothing at all.
 *
 * Keep this in sync with `cb()`. Do not add `:` semantics-breaking characters.
 */
const CALLBACK_CHARS = /^[a-z0-9_:~\-.]+$/i;

export function cb(...parts: Array<string | number>): string {
  const data = parts.join(":");
  if (Buffer.byteLength(data, "utf8") > 64) {
    throw new Error(`callback_data exceeds 64 bytes: ${data}`);
  }
  // Build-time symmetry with parseCb. Without this, a payload containing a
  // character the parser rejects still produced a perfectly good-looking
  // button that silently did nothing when tapped — every tap answered
  // "Menu expired" and the action never ran. Fail loudly here instead.
  if (!CALLBACK_CHARS.test(data)) {
    throw new Error(`callback_data has characters parseCb will reject: ${data}`);
  }
  return data;
}
export const callbackSchema = z
  .string()
  .max(64)
  .regex(CALLBACK_CHARS, "malformed callback data");

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
