import { createHmac } from "node:crypto";

/**
 * TOTP (RFC 6238) generated locally — HMAC-SHA1, 30s window, 6 digits.
 * Replaces sending customers to 2fa.live: the secret never leaves this server
 * and there is no third-party dependency in the login path.
 */

const STEP = 30;

/** Decode a base32 secret, tolerating spaces, lowercase and missing padding. */
export function base32Decode(input: string): Buffer | null {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (!clean || /[^A-Z2-7]/.test(clean)) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alpha.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return out.length > 0 ? Buffer.from(out) : null;
}

export interface TotpResult { code: string; secondsLeft: number; nextCode: string }

/**
 * Current 6-digit code plus how long it lasts. `nextCode` is included so a
 * customer who is about to run out of time can use the next one instead of
 * being handed a code that expires as they paste it.
 */
export function generateTotp(secret: string, digits = 6, atMs = Date.now()): TotpResult | null {
  const key = base32Decode(secret);
  if (!key) return null;
  const counter = Math.floor(atMs / 1000 / STEP);
  const code = (c: number): string => {
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(Math.floor(c / 0x100000000), 0);
    buf.writeUInt32BE(c % 0x100000000, 4);
    const hmac = createHmac("sha1", key).update(buf).digest();
    const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
    const bin =
      (((hmac[offset] ?? 0) & 0x7f) << 24) |
      (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
      (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
      ((hmac[offset + 3] ?? 0) & 0xff);
    return String(bin % 10 ** digits).padStart(digits, "0");
  };
  return {
    code: code(counter),
    nextCode: code(counter + 1),
    secondsLeft: STEP - Math.floor((atMs / 1000) % STEP),
  };
}

/** Is this string usable as a TOTP secret? */
export function looksLikeTotpSecret(s: string): boolean {
  const b = base32Decode(s);
  return b !== null && b.length >= 10;
}
