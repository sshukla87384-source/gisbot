/**
 * Durations an admin types, in one place.
 *
 * Warranty windows and key validity used to be whole days, because the columns
 * were `warrantyDays` / `durationDays`. A six-hour trial account had to be sold
 * as "1 day", which is eight times the window actually intended — and a
 * one-hour window could not be expressed at all.
 *
 * Hours are now the unit everywhere. Admins still think in days most of the
 * time, so the parser accepts both and the formatter reads them back the way
 * they were meant: 72 hours prints as "3d", 78 as "3d 6h".
 */

/** Longest window we accept: 10 years. Anything above is a typo, not a plan. */
const MAX_HOURS = 24 * 365 * 10;

/**
 * Parse an admin-typed duration into whole hours.
 *
 * Accepts, case-insensitively, in any order and with or without spaces:
 *   "36"        → 36 hours   (a bare number means HOURS)
 *   "3d"        → 72
 *   "2d 6h"     → 54
 *   "1w"        → 168
 *   "90m"       → 2          (minutes round UP: a 90-minute window must not
 *                             silently become one hour)
 *   "0", "-", "none", "unlimited", "" → null (no limit)
 *
 * Returns null for "no limit", and undefined when the text is not a duration
 * at all — the two mean different things to the caller, so they are distinct.
 */
export function parseDurationHours(input: string): number | null | undefined {
  const raw = input.trim().toLowerCase();
  if (raw === "" || raw === "-" || raw === "0" || raw === "none" || raw === "unlimited") return null;

  // Reject anything containing characters we do not understand, rather than
  // silently parsing the digits out of "3 dayz lol" and acting on it.
  if (!/^[\d\s.dhwm]+$/.test(raw)) return undefined;

  const units: Record<string, number> = { w: 168, d: 24, h: 1, m: 1 / 60 };
  let hours = 0;
  let matched = false;

  for (const m of raw.matchAll(/(\d+(?:\.\d+)?)\s*([wdhm]?)/g)) {
    const amount = m[1];
    if (amount === undefined) continue;
    const n = Number.parseFloat(amount);
    if (!Number.isFinite(n) || n < 0) return undefined;
    hours += n * (units[m[2] || "h"] ?? 1);
    matched = true;
  }
  if (!matched) return undefined;

  // Round up, never down. Rounding down would hand the customer a window
  // shorter than the one the admin typed.
  const whole = Math.ceil(hours - 1e-9);
  if (whole <= 0) return null;
  if (whole > MAX_HOURS) return undefined;
  return whole;
}

/** "3d", "3d 6h", "6h", or "unlimited" for null. Never prints "0d". */
export function formatDuration(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || hours <= 0) return "unlimited";
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  if (d === 0) return `${h}h`;
  if (h === 0) return `${d}d`;
  return `${d}d ${h}h`;
}

/**
 * The window to actually use, given the hour column and the legacy day column.
 *
 * Rows written before hours existed only have days, and both are null when
 * there is no limit — so this is the only place that decides, and every caller
 * asks it rather than reimplementing the fallback and getting it subtly wrong.
 */
export function effectiveHours(hours: number | null | undefined, legacyDays: number | null | undefined): number | null {
  if (hours !== null && hours !== undefined && hours > 0) return hours;
  if (legacyDays !== null && legacyDays !== undefined && legacyDays > 0) return legacyDays * 24;
  return null;
}

/** Whole days, rounded up, for the day-granular fields we still publish. */
export function hoursToDays(hours: number | null | undefined): number | null {
  if (hours === null || hours === undefined || hours <= 0) return null;
  return Math.ceil(hours / 24);
}
