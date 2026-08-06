import { createHmac, randomBytes } from "node:crypto";
import { loadConfig } from "@gis/config";
import { prisma } from "@gis/database";
import { decryptSecret, encryptSecret } from "@gis/shared";

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

// ─────────────────────── Admin panel second factor ───────────────────────
//
// The passcode alone is one secret in one Telegram chat. If that chat or the
// passcode ever leaks, the whole store is open: prices, stock, wallets, keys.
// A TOTP code costs the operator two seconds and removes that single point of
// failure entirely.

const ADMIN_TOTP_SETTING = "admin.totp";

export interface AdminTotpState {
  enabled: boolean;
  /** Enrolled but not yet confirmed with a working code. */
  pending: boolean;
}

/** Random base32 secret, 32 chars (160 bits) — what authenticator apps expect. */
export function newTotpSecret(): string {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes = randomBytes(32);
  let out = "";
  for (const b of bytes) out += alpha[b % 32];
  return out;
}

/** Accepts the previous, current and next window, so a slow clock still works. */
export function verifyTotp(secret: string, code: string, atMs = Date.now()): boolean {
  const clean = code.replace(/\D/g, "");
  if (clean.length < 6) return false;
  for (const drift of [-1, 0, 1]) {
    const t = generateTotp(secret, 6, atMs + drift * STEP * 1000);
    if (t && timingSafeEqualStr(t.code, clean)) return true;
  }
  return false;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Enrol a second factor. Deliberately stored as `pending` until the operator
 * proves one code works — enabling it unverified is how people lock themselves
 * out of their own store.
 */
export async function beginAdminTotp(): Promise<{ secret: string; uri: string } | { error: "ALREADY_ENABLED" }> {
  // Refuse while 2FA is ON. This upserts `enabled: false`, so any holder of an
  // admin session (which never expires) could send adm:twofaon and silently
  // downgrade the panel to single-factor. Switching off requires a code, so
  // starting again must too.
  if ((await readAdminTotp()).enabled) return { error: "ALREADY_ENABLED" };
  const secret = newTotpSecret();
  const store = loadConfig().STORE_NAME || "Store";
  await prisma.setting.upsert({
    where: { key: ADMIN_TOTP_SETTING },
    create: { key: ADMIN_TOTP_SETTING, value: { secretEnc: encryptSecret(secret, loadConfig().ENCRYPTION_MASTER_KEY), enabled: false } as never },
    update: { value: { secretEnc: encryptSecret(secret, loadConfig().ENCRYPTION_MASTER_KEY), enabled: false } as never },
  });
  const label = encodeURIComponent(`${store} Admin`);
  return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(store)}&digits=6&period=30` };
}

async function readAdminTotp(): Promise<{ secret: string | null; enabled: boolean }> {
  const row = await prisma.setting.findUnique({ where: { key: ADMIN_TOTP_SETTING } }).catch(() => null);
  const v = (row?.value ?? null) as { secretEnc?: string; enabled?: boolean } | null;
  if (!v?.secretEnc) return { secret: null, enabled: false };
  try {
    return { secret: decryptSecret(v.secretEnc, loadConfig().ENCRYPTION_MASTER_KEY), enabled: v.enabled === true };
  } catch {
    return { secret: null, enabled: false };
  }
}

export async function adminTotpState(): Promise<AdminTotpState> {
  const { secret, enabled } = await readAdminTotp();
  return { enabled, pending: secret !== null && !enabled };
}

/** Turn it on, but only if the code proves the authenticator app is set up. */
export async function confirmAdminTotp(code: string): Promise<boolean> {
  const { secret } = await readAdminTotp();
  if (!secret || !verifyTotp(secret, code)) return false;
  await prisma.setting.update({
    where: { key: ADMIN_TOTP_SETTING },
    data: { value: { secretEnc: encryptSecret(secret, loadConfig().ENCRYPTION_MASTER_KEY), enabled: true } as never },
  });
  return true;
}

/** Login check. Returns true when 2FA is off — callers need no special case. */
export async function adminTotpRequired(): Promise<boolean> {
  return (await readAdminTotp()).enabled;
}

export async function checkAdminTotp(code: string): Promise<boolean> {
  const { secret, enabled } = await readAdminTotp();
  if (!enabled || !secret) return true;
  return verifyTotp(secret, code);
}

/** Switching it off requires a valid code — otherwise it protects nothing. */
export async function disableAdminTotp(code: string): Promise<boolean> {
  const { secret, enabled } = await readAdminTotp();
  if (!enabled || !secret) return true;
  if (!verifyTotp(secret, code)) return false;
  await prisma.setting.delete({ where: { key: ADMIN_TOTP_SETTING } }).catch(() => undefined);
  return true;
}
