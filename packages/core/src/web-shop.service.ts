import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { loadConfig } from "@gis/config";
import { prisma, type Currency } from "@gis/database";
import { REFERRAL_PREFIX } from "@gis/shared";
import { getProductView, UNLIMITED_STOCK } from "./catalog/catalog.service.js";
import { productRating } from "./followup.service.js";
import { resolveTelegramUser } from "./users/user.service.js";
import { sanitizeTelegramHtml } from "./tg-html.js";
import { publicImageUrl } from "./miniapp.service.js";
import { getRedis, invalidate } from "./redis.js";
import { enqueueEmail } from "./queues.js";
import { emailSendingConfigured } from "./smtp.js";

/**
 * The shop as a normal website (apps/api serves the page at /shop).
 *
 * Same customers, wallet, orders and products as the bot: a visitor logs in
 * with the Telegram Login Widget, which identifies the SAME user row the bot
 * uses (found or created by telegramId), so their balance and orders are
 * shared. Everything that moves money goes through the same core functions
 * as the bot and the Mini App.
 */

// ── On / off ─────────────────────────────────────────────────────────────────

const ENABLED_KEY = "webshop.enabled";

export async function getWebShopEnabled(): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key: ENABLED_KEY } }).catch(() => null);
  return (row?.value as { on?: boolean } | null | undefined)?.on !== false;
}

export async function setWebShopEnabled(on: boolean): Promise<void> {
  await prisma.setting.upsert({ where: { key: ENABLED_KEY }, create: { key: ENABLED_KEY, value: { on } }, update: { value: { on } } });
  await invalidate("cat:*"); // product cards carry the web shop link
}

// ── Telegram Login Widget ────────────────────────────────────────────────────

export interface TelegramLogin {
  id: number | string;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number | string;
  hash: string;
}

/**
 * Check a Telegram Login Widget payload: HMAC-SHA256 of the sorted
 * "key=value" lines with key = SHA256(bot token), at most a day old.
 * (Not the Mini App rule — that one uses HMAC("WebAppData", token).)
 */
export function verifyTelegramLogin(p: TelegramLogin, maxAgeSec = 86_400): boolean {
  if (!p || typeof p.hash !== "string" || !/^[a-f0-9]{64}$/i.test(p.hash)) return false;
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === "hash" || v === undefined || v === null || v === "") continue;
    fields[k] = String(v);
  }
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHash("sha256").update(loadConfig().BOT_TOKEN).digest();
  const expected = createHmac("sha256", secret).update(check).digest();
  const given = Buffer.from(p.hash, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  const at = Number(p.auth_date);
  return Number.isFinite(at) && Date.now() / 1000 - at <= maxAgeSec;
}

/** The shop customer behind a verified login — created exactly as the bot would, with the referral kept. */
export async function webLoginUser(p: TelegramLogin, ref?: string | null): Promise<{ id: string; status: string }> {
  const { user } = await resolveTelegramUser({
    telegramId: BigInt(String(p.id)),
    ...(p.first_name ? { firstName: p.first_name } : {}),
    ...(p.last_name ? { lastName: p.last_name } : {}),
    ...(p.username ? { username: p.username } : {}),
    ...(ref && /^[A-Za-z0-9_-]{3,40}$/.test(ref) ? { startPayload: `${REFERRAL_PREFIX}${ref}` } : {}),
  });
  return { id: user.id, status: (user as { status?: string }).status ?? "ACTIVE" };
}

// ── Session cookie (HMAC-signed, no server state) ────────────────────────────

const SESSION_DAYS = 30;

function sessionKey(): Buffer {
  const cfg = loadConfig();
  return createHash("sha256").update(`webshop-session|${cfg.JWT_SECRET ?? cfg.BOT_TOKEN}`).digest();
}

/** Bumped on logout: every cookie carrying an older version stops working. */
async function sessionVersion(userId: string): Promise<number> {
  return Number(await getRedis().get(`shopsess:${userId}`).catch(() => null)) || 0;
}

export async function revokeWebSessions(userId: string): Promise<void> {
  await getRedis().incr(`shopsess:${userId}`);
}

export async function makeWebSession(userId: string): Promise<{ token: string; maxAgeSec: number }> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86_400;
  const body = Buffer.from(JSON.stringify({ u: userId, e: exp, v: await sessionVersion(userId) })).toString("base64url");
  const sig = createHmac("sha256", sessionKey()).update(body).digest("base64url");
  return { token: `${body}.${sig}`, maxAgeSec: SESSION_DAYS * 86_400 };
}

export function readWebSession(token: string | undefined | null): { id: string; v: number } | null {
  if (!token || token.length > 512) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", sessionKey()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const v = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { u?: string; e?: number; v?: number };
    if (!v.u || !v.e || v.e < Date.now() / 1000) return null;
    return { id: v.u, v: Number(v.v) || 0 };
  } catch {
    return null;
  }
}

export interface WebShopUser {
  id: string;
  /** null for a customer who signed up with email on the website. */
  telegramId: bigint | null;
  email: string | null;
  currency: Currency;
  firstName: string | null;
  referralCode: string;
}

/** The signed-in customer, or null (unknown, banned or logged out). */
export async function webSessionUser(token: string | undefined | null): Promise<WebShopUser | null> {
  const s = readWebSession(token);
  if (!s) return null;
  if (s.v !== (await sessionVersion(s.id))) return null; // logged out since
  const id = s.id;
  const u = await prisma.user.findFirst({
    where: { id, status: "ACTIVE" },
    select: { id: true, telegramId: true, email: true, emailVerified: true, currency: true, firstName: true, referralCode: true },
  });
  if (!u) return null;
  // A customer reaches the shop with Telegram or with a verified email.
  if (u.telegramId === null && !(u.email && u.emailVerified)) return null;
  return { id: u.id, telegramId: u.telegramId, email: u.emailVerified ? u.email : null, currency: u.currency as Currency, firstName: u.firstName, referralCode: u.referralCode };
}

// ── Email login (one-time code) ──────────────────────────────────────────────

const EMAIL_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const CODE_TTL_SEC = 600;
const CODE_MAX_TRIES = 5;

export function normalizeEmail(raw: string): string | null {
  const e = String(raw ?? "").trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

/** Can the website offer "log in with email"? (needs SMTP or Resend + EMAIL_FROM) */
export function emailLoginAvailable(): boolean {
  return emailSendingConfigured();
}

const codeKey = (email: string) => `shopotp:${createHash("sha256").update(email).digest("hex")}`;
const codeHash = (email: string, code: string) => createHmac("sha256", sessionKey()).update(`${email}|${code}`).digest("hex");

/** Email a 6-digit login code (valid 10 minutes, 5 tries). */
export async function sendEmailLoginCode(email: string): Promise<void> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await getRedis().set(codeKey(email), JSON.stringify({ h: codeHash(email, code), t: 0 }), "EX", CODE_TTL_SEC);
  const store = loadConfig().STORE_NAME;
  await enqueueEmail({
    to: email,
    subject: `${code} is your ${store} login code`,
    html: `<div style="font-family:Arial,sans-serif;max-width:480px"><h2>${store.replace(/</g, "&lt;")}</h2><p>Your login code:</p><p style="font-size:32px;font-weight:bold;letter-spacing:6px;margin:10px 0">${code}</p><p style="color:#666">It works for 10 minutes. If you didn't try to log in, ignore this email — nobody can get in without this code.</p></div>`,
  });
}

/** True once, for the right code; wrong codes count towards the limit. */
export async function checkEmailLoginCode(email: string, code: string): Promise<boolean> {
  const redis = getRedis();
  const k = codeKey(email);
  const raw = await redis.get(k).catch(() => null);
  if (!raw) return false;
  let v: { h?: string; t?: number };
  try { v = JSON.parse(raw) as { h?: string; t?: number }; } catch { return false; }
  if ((v.t ?? 0) >= CODE_MAX_TRIES || !v.h || !/^\d{6}$/.test(code)) { if ((v.t ?? 0) >= CODE_MAX_TRIES) await redis.del(k).catch(() => undefined); return false; }
  const a = Buffer.from(codeHash(email, code));
  const b = Buffer.from(v.h);
  if (a.length === b.length && timingSafeEqual(a, b)) { await redis.del(k).catch(() => undefined); return true; }
  await redis.set(k, JSON.stringify({ h: v.h, t: (v.t ?? 0) + 1 }), "KEEPTTL").catch(() => undefined);
  return false;
}

/** Wallet set to 0 and no orders: an account that can be merged away safely. */
async function isEmptyAccount(userId: string): Promise<boolean> {
  const [orders, wallet] = await Promise.all([
    prisma.order.count({ where: { userId } }),
    prisma.wallet.findUnique({ where: { userId }, select: { balanceMinor: true } }).catch(() => null),
  ]);
  return orders === 0 && Number(wallet?.balanceMinor ?? 0) === 0;
}

/** The customer for a verified email — found, or created like a new bot customer (wallet, role, referral). */
export async function webEmailLoginUser(email: string, ref?: string | null): Promise<{ id: string; status: string }> {
  const existing = await prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } }, select: { id: true, status: true, emailVerified: true } });
  if (existing) {
    if (!existing.emailVerified) await prisma.user.update({ where: { id: existing.id }, data: { emailVerified: true } });
    return { id: existing.id, status: existing.status };
  }
  let referredById: string | undefined;
  if (ref && /^[A-Za-z0-9_-]{3,40}$/.test(ref)) {
    const r = await prisma.user.findUnique({ where: { referralCode: ref }, select: { id: true } }).catch(() => null);
    if (r) referredById = r.id;
  }
  const customerRole = await prisma.role.findUnique({ where: { name: "CUSTOMER" } });
  const currency = "USD" as Currency;
  const name = (email.split("@")[0] ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 30) || "Customer";
  const user = await prisma.user.create({
    data: {
      email,
      emailVerified: true,
      firstName: name,
      currency,
      ...(referredById ? { referredById } : {}),
      wallet: { create: { currency } },
      ...(customerRole ? { roles: { create: { roleId: customerRole.id } } } : {}),
    },
    select: { id: true, status: true },
  });
  await prisma.activityLog.create({ data: { userId: user.id, event: "web.signup", meta: { via: "email", referred: Boolean(referredById) } } }).catch(() => undefined);
  return { id: user.id, status: user.status };
}

export type LinkResult = { ok: true; switchTo?: string } | { ok: false; message: string };

/**
 * Add a verified email to the signed-in (Telegram) customer, so they can also
 * log in with it. If that email already has its own, EMPTY website account,
 * the email moves over; an account with orders or balance is never merged.
 */
export async function linkEmailToUser(userId: string, email: string): Promise<LinkResult> {
  const other = await prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" }, id: { not: userId } }, select: { id: true, telegramId: true } });
  if (other) {
    if (other.telegramId !== null || !(await isEmptyAccount(other.id))) {
      return { ok: false, message: "That email already belongs to another account with orders or balance. Log in with it, or contact support to merge." };
    }
    await prisma.user.update({ where: { id: other.id }, data: { email: null, emailVerified: false } });
  }
  await prisma.user.update({ where: { id: userId }, data: { email, emailVerified: true } });
  return { ok: true };
}

// ── Telegram login through the bot (no Login Widget, no BotFather domain) ────
//
// The page asks for a one-time token and opens t.me/<bot>?start=wl_<token>;
// the bot asks "Log in to the website?" and, on ✅, records who confirmed;
// the page polls and gets its session. Works on phones and without /setdomain.

const BOT_LOGIN_TTL = 600;
const blKey = (t: string) => `botlogin:${t}`;

type BotLoginState = { u?: string; link?: string };

/** A new login token. `linkTo`: the signed-in (email) account that wants Telegram linked. */
export async function createBotLogin(linkTo?: string): Promise<string> {
  const token = createHash("sha256").update(`${Date.now()}|${randomInt(0, 2 ** 47)}|${Math.random()}`).digest("base64url").slice(0, 24).replace(/[^A-Za-z0-9]/g, "x");
  await getRedis().set(blKey(token), JSON.stringify({ ...(linkTo ? { link: linkTo } : {}) } satisfies BotLoginState), "EX", BOT_LOGIN_TTL);
  return token;
}

export function isBotLoginToken(t: string): boolean {
  return /^[A-Za-z0-9]{24}$/.test(t);
}

/** In the bot: the customer confirmed. False when the token is unknown, expired or used. */
export async function approveBotLogin(token: string, userId: string): Promise<boolean> {
  if (!isBotLoginToken(token)) return false;
  const redis = getRedis();
  const raw = await redis.get(blKey(token)).catch(() => null);
  if (!raw) return false;
  let v: BotLoginState;
  try { v = JSON.parse(raw) as BotLoginState; } catch { return false; }
  if (v.u) return v.u === userId;
  await redis.set(blKey(token), JSON.stringify({ ...v, u: userId }), "KEEPTTL");
  return true;
}

/** Is this token a "link Telegram to my email account" request? (the bot words its question accordingly) */
export async function botLoginIsLink(token: string): Promise<boolean> {
  if (!isBotLoginToken(token)) return false;
  const raw = await getRedis().get(blKey(token)).catch(() => null);
  try { return Boolean(raw && (JSON.parse(raw) as BotLoginState).link); } catch { return false; }
}

/** On the page: "pending", "expired", or the confirmed customer (the token is used up). */
export async function takeBotLogin(token: string): Promise<{ state: "pending" | "expired" } | { state: "ok"; userId: string; linkTo?: string }> {
  if (!isBotLoginToken(token)) return { state: "expired" };
  const redis = getRedis();
  const raw = await redis.get(blKey(token)).catch(() => null);
  if (!raw) return { state: "expired" };
  let v: BotLoginState;
  try { v = JSON.parse(raw) as BotLoginState; } catch { return { state: "expired" }; }
  if (!v.u) return { state: "pending" };
  await redis.del(blKey(token)).catch(() => undefined);
  return { state: "ok", userId: v.u, ...(v.link ? { linkTo: v.link } : {}) };
}

/**
 * Join the signed-in email account (`meId`) with the Telegram customer the bot
 * knows (`tgUserId`), so the bot and the website share ONE wallet:
 *   - the Telegram row is empty (just created by /start) → Telegram moves onto this account;
 *   - this account is empty → its email moves onto the Telegram account, and the session switches there;
 *   - both have orders or balance → refused (never mixes two wallets).
 */
export async function linkBotUserToAccount(meId: string, tgUserId: string): Promise<LinkResult> {
  if (meId === tgUserId) return { ok: true };
  const [me, tg] = await Promise.all([
    prisma.user.findUnique({ where: { id: meId }, select: { telegramId: true, email: true, emailVerified: true } }),
    prisma.user.findUnique({ where: { id: tgUserId }, select: { telegramId: true, telegramHandle: true, firstName: true, lastName: true, email: true } }),
  ]);
  if (!me || !tg || tg.telegramId === null) return { ok: false, message: "Account not found." };
  if (me.telegramId !== null) return { ok: false, message: "This account is already linked to another Telegram." };
  if (!tg.email && (await isEmptyAccount(tgUserId))) {
    // The empty row the bot just made gives up its Telegram id (nothing else is lost).
    await prisma.$transaction([
      prisma.user.update({ where: { id: tgUserId }, data: { telegramId: null } }),
      prisma.user.update({ where: { id: meId }, data: { telegramId: tg.telegramId, telegramHandle: tg.telegramHandle, ...(tg.firstName ? { firstName: tg.firstName } : {}), ...(tg.lastName ? { lastName: tg.lastName } : {}) } }),
    ]);
    return { ok: true };
  }
  if (await isEmptyAccount(meId)) {
    if (me.email && me.emailVerified && !tg.email) {
      await prisma.$transaction([
        prisma.user.update({ where: { id: meId }, data: { email: null, emailVerified: false } }),
        prisma.user.update({ where: { id: tgUserId }, data: { email: me.email, emailVerified: true } }),
      ]);
    }
    return { ok: true, switchTo: tgUserId };
  }
  return { ok: false, message: "This Telegram already has its own account with orders or balance. Log out and log in with Telegram instead, or contact support to merge." };
}

// ── Product page ─────────────────────────────────────────────────────────────

const ALLOWED = { dropTags: ["blockquote"] };
const strip = (html: string | null): string | null => {
  if (!html) return null;
  // The website shows the plain glyph of a premium emoji (it cannot render Telegram's).
  const h = sanitizeTelegramHtml(html.replace(/<tg-emoji[^>]*>([\s\S]*?)<\/tg-emoji>/gi, "$1"), ALLOWED).trim();
  return h || null;
};

/** Same line rules as the bot's product card: ✅ per description line, numbered steps, bulleted terms. */
function formatLines(html: string | null, kind: "desc" | "steps" | "bullets"): string | null {
  if (!html) return null;
  const lines = html.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (kind !== "desc" && lines[0] && /^(?:<[^>]+>|[\p{Extended_Pictographic}\uFE0F\s])*(?:how\s*to\s*use|terms?\s*(?:&amp;|&|and)?\s*conditions?)\s*:?\s*(?:<\/[^>]+>|\s)*$/iu.test(lines[0])) lines.shift();
  if (lines.length === 0) return null;
  const own = /^(?:<[^>]+>)*\s*(?:\d{1,2}\s*[.)\-:]|[•▪▫◾◽‣·*]|[\p{Extended_Pictographic}])/u;
  const anyOwn = lines.some((l) => own.test(l));
  let n = 0;
  return lines.map((l) => {
    if (anyOwn) return l.replace(/^-\s+/, "• ");
    const t = l.replace(/^-\s+/, "");
    return kind === "steps" ? `<b>${++n}.</b> ${t}` : kind === "bullets" ? `• ${t}` : `✅ ${t}`;
  }).join("\n");
}

/** One product, the same card the bot shows, as data for the web page. */
export async function webShopProduct(productId: string, currency: Currency, userId?: string) {
  const p = await getProductView(productId, currency, userId, "DIRECT");
  const [rating, slugRow, stock] = await Promise.all([
    productRating(productId).catch(() => null),
    prisma.product.findUnique({ where: { id: productId }, select: { slug: true, imageUrl: true, type: true, webImages: true } }),
    Promise.resolve(p.variants.map((v) => v.stock)),
  ]);
  const unlimited = (n: number) => n >= 1_000_000 || n >= UNLIMITED_STOCK;
  return {
    id: p.id,
    slug: slugRow?.slug ?? null,
    name: p.name.replace(/<[^>]+>/g, ""),
    iconEmoji: p.iconEmoji,
    imageUrl: publicImageUrl(slugRow?.webImages?.[0] ?? slugRow?.imageUrl ?? p.imageUrl),
    // The website gallery (admin: product → 🌐 Website images); the bot image when there is none.
    images: (slugRow?.webImages?.length ? slugRow.webImages : [slugRow?.imageUrl ?? p.imageUrl]).map((u) => publicImageUrl(u)).filter((u): u is string => Boolean(u)),
    unit: slugRow?.type === "LICENSE_KEY" ? "code" : slugRow?.type === "DIGITAL_ACCOUNT" ? "account" : null,
    description: formatLines(strip(p.descriptionHtml ?? (p.description ? p.description.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : null)), "desc"),
    howToUse: formatLines(strip(p.howToUse), "steps"),
    terms: formatLines(strip(p.terms), "bullets"),
    onSale: p.onSale,
    saleEndsAt: p.saleEndsAt?.toISOString() ?? null,
    bulk: p.bulkLadder,
    automatic: p.fulfillmentMode === "AUTOMATIC" || p.supplierBacked,
    warranty: p.warranty ? { hours: p.warrantyHours } : null,
    personalPrice: p.hasCustomPrice,
    rating: rating && rating.count >= 3 ? { avg: Math.round(rating.avg * 10) / 10, count: rating.count } : null,
    currency,
    variants: p.variants.map((v, i) => ({
      id: v.id,
      name: /^(standard|default|regular|-)?$/i.test(v.name.trim()) ? null : v.name,
      priceMinor: v.priceMinor,
      wasMinor: v.originalPriceMinor,
      stock: unlimited(stock[i] ?? 0) ? null : (stock[i] ?? 0),
      inStock: (stock[i] ?? 0) > 0,
    })),
  };
}
