import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { loadConfig } from "@gis/config";
import { prisma, type Currency } from "@gis/database";
import { REFERRAL_PREFIX } from "@gis/shared";
import { getProductView, UNLIMITED_STOCK } from "./catalog/catalog.service.js";
import { productRating } from "./followup.service.js";
import { resolveTelegramUser } from "./users/user.service.js";
import { sanitizeTelegramHtml } from "./tg-html.js";
import { publicImageUrl } from "./miniapp.service.js";
import { getRedis } from "./redis.js";

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

/** The signed-in customer, or null (unknown, banned or logged out). */
export async function webSessionUser(token: string | undefined | null): Promise<{ id: string; telegramId: bigint; currency: Currency; firstName: string | null; referralCode: string } | null> {
  const s = readWebSession(token);
  if (!s) return null;
  if (s.v !== (await sessionVersion(s.id))) return null; // logged out since
  const id = s.id;
  const u = await prisma.user.findFirst({
    where: { id, status: "ACTIVE" },
    select: { id: true, telegramId: true, currency: true, firstName: true, referralCode: true },
  });
  if (!u || u.telegramId === null) return null;
  return { id: u.id, telegramId: u.telegramId, currency: u.currency as Currency, firstName: u.firstName, referralCode: u.referralCode };
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
    prisma.product.findUnique({ where: { id: productId }, select: { slug: true, imageUrl: true, type: true } }),
    Promise.resolve(p.variants.map((v) => v.stock)),
  ]);
  const unlimited = (n: number) => n >= 1_000_000 || n >= UNLIMITED_STOCK;
  return {
    id: p.id,
    slug: slugRow?.slug ?? null,
    name: p.name.replace(/<[^>]+>/g, ""),
    iconEmoji: p.iconEmoji,
    imageUrl: publicImageUrl(slugRow?.imageUrl ?? p.imageUrl),
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
