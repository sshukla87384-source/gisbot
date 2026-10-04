import { prisma, type Currency } from "@gis/database";
import { CoreError, formatMinor, type CurrencyCode } from "@gis/shared";
import { randomBytes } from "node:crypto";
import { addToCart, clearCart } from "./cart/cart.service.js";
import { convertMinor } from "./fx.js";
import { applyCouponToCart, getCartCoupon, removeCouponFromCart } from "./orders/coupon.service.js";
import { enqueueAdminAlert, enqueueTelegramMessage } from "./queues.js";
import { adjustWallet } from "./wallet/wallet.service.js";

/**
 * Growth features that share one shape: a small admin-set config in the
 * Setting table, a cron or a tap that acts on it, and a system coupon when a
 * discount is involved. Kept together because each one alone is a hundred
 * lines and they lean on the same helpers.
 *
 *   renewals   — "expires in N days, renew −X %" on every time-limited item
 *   combo      — automatic cart-wide discount from the 2nd distinct product
 *   also-bought— cross-sell rows under the checkout, from real co-purchases
 *   gifts      — wallet balance → code → anyone redeems it
 *   first-order cap — new accounts cannot place a large first order
 */

// ── Settings ─────────────────────────────────────────────────────────────────

async function readSetting<T>(key: string, fallback: T, pick: (v: Record<string, unknown>) => T): Promise<T> {
  try {
    const row = await prisma.setting.findUnique({ where: { key } });
    const v = row?.value;
    if (v && typeof v === "object" && !Array.isArray(v)) return pick(v as Record<string, unknown>);
  } catch { /* fallback */ }
  return fallback;
}

async function writeSetting(key: string, value: Record<string, unknown>): Promise<void> {
  await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);

/**
 * A percentage coupon the system owns (RENEW10, COMBO10 …): created on first
 * use, unlimited, never shown in the admin's own list as something to manage.
 */
async function ensureSystemCoupon(code: string, pct: number): Promise<string> {
  const bp = Math.round(pct * 100);
  const existing = await prisma.coupon.findUnique({ where: { code } });
  if (existing) {
    if (existing.valuePct !== bp || !existing.isActive || existing.deletedAt) {
      await prisma.coupon.update({ where: { id: existing.id }, data: { valuePct: bp, isActive: true, deletedAt: null, type: "PERCENTAGE", scope: "GLOBAL", perUserLimit: 100_000, usageLimit: null, expiresAt: null } });
    }
    return existing.id;
  }
  const c = await prisma.coupon.create({
    data: { code, type: "PERCENTAGE", scope: "GLOBAL", valuePct: bp, perUserLimit: 100_000, isActive: true },
  });
  return c.id;
}

// ── Renewal reminders ────────────────────────────────────────────────────────

export interface RenewalConfig {
  enabled: boolean;
  /** Remind this many days before the item expires. */
  daysBefore: number;
  /** Discount on the renewal, percent (0 = none, button still offered). */
  pct: number;
}

const RENEWAL_KEY = "renewal.cfg";

export async function getRenewalConfig(): Promise<RenewalConfig> {
  return readSetting(RENEWAL_KEY, { enabled: true, daysBefore: 3, pct: 10 }, (v) => ({
    enabled: bool(v.enabled, true), daysBefore: Math.max(1, Math.min(30, num(v.daysBefore, 3))), pct: Math.max(0, Math.min(90, num(v.pct, 10))),
  }));
}

export async function setRenewalConfig(patch: Partial<RenewalConfig>): Promise<RenewalConfig> {
  const next = { ...(await getRenewalConfig()), ...patch };
  await writeSetting(RENEWAL_KEY, { enabled: next.enabled, daysBefore: next.daysBefore, pct: next.pct });
  return next;
}

export const renewalCouponCode = (pct: number): string => `RENEW${Math.round(pct)}`;

/**
 * Cron: one reminder per expiring item, never twice. Items whose product or
 * variant is gone are stamped too, so they stop being considered.
 */
export async function runRenewalReminders(limit = 200): Promise<number> {
  const cfg = await getRenewalConfig();
  if (!cfg.enabled) return 0;
  const now = new Date();
  const until = new Date(now.getTime() + cfg.daysBefore * 86_400_000);
  const items = await prisma.orderItem.findMany({
    where: {
      fulfilledAt: { not: null }, renewalRemindedAt: null, replacedAt: null,
      expiresAt: { gt: now, lte: until },
      order: { status: { in: ["COMPLETED", "PAID", "PENDING_FULFILLMENT"] } },
    },
    include: { order: { include: { user: { select: { id: true, telegramId: true, currency: true, firstName: true } } } }, variant: { include: { product: true } } },
    orderBy: { expiresAt: "asc" },
    take: limit,
  });
  let sent = 0;
  for (const it of items) {
    await prisma.orderItem.update({ where: { id: it.id }, data: { renewalRemindedAt: now } }).catch(() => undefined);
    const user = it.order.user;
    const v = it.variant;
    if (user.telegramId == null || !it.expiresAt) continue;
    if (!v.isActive || v.deletedAt || v.product.status !== "ACTIVE" || v.product.deletedAt) continue;
    const days = Math.max(1, Math.ceil((it.expiresAt.getTime() - now.getTime()) / 86_400_000));
    const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const vn = it.variantNameSnap.trim().toLowerCase() === "standard" ? "" : ` · ${esc(it.variantNameSnap)}`;
    const off = cfg.pct > 0 ? ` — <b>${cfg.pct}% off</b> if you renew now` : "";
    await enqueueTelegramMessage(
      user.telegramId,
      [
        `⏰ <b>Expiring soon:</b> ${esc(it.productNameSnap)}${vn}`,
        "",
        `Your access ends in <b>${days} day${days === 1 ? "" : "s"}</b> (${it.expiresAt.toISOString().slice(0, 10)}).`,
        `Renew in one tap and keep going without a gap${off}. 🔁`,
      ].join("\n"),
      { buttons: [
        { text: cfg.pct > 0 ? `🔁 Renew now −${cfg.pct}%` : "🔁 Renew now", callbackData: `rnw:go:${it.id}`, style: "success" },
        { text: "📦 My orders", callbackData: "ord:list:1", style: "primary" },
      ] },
    ).catch(() => undefined);
    sent++;
  }
  return sent;
}

/** The 🔁 Renew tap: the same variant into an empty cart, discount applied. Returns the product name. */
export async function startRenewal(userId: string, orderItemId: string): Promise<{ productName: string; variantId: string; discountPct: number }> {
  const it = await prisma.orderItem.findFirst({
    where: { id: orderItemId, order: { userId } },
    include: { variant: { include: { product: true } }, order: { select: { currency: true } } },
  });
  if (!it) throw new CoreError("ORDER_NOT_FOUND");
  const v = it.variant;
  if (!v.isActive || v.deletedAt || v.product.status !== "ACTIVE" || v.product.deletedAt) throw new CoreError("PRODUCT_NOT_FOUND");
  const cfg = await getRenewalConfig();
  await clearCart(userId);
  await addToCart(userId, v.id, 1);
  if (cfg.pct > 0) {
    await ensureSystemCoupon(renewalCouponCode(cfg.pct), cfg.pct);
    await applyCouponToCart(userId, renewalCouponCode(cfg.pct), it.order.currency as Currency).catch(() => undefined);
  }
  return { productName: it.productNameSnap, variantId: v.id, discountPct: cfg.pct };
}

// ── Combo discount + also-bought ─────────────────────────────────────────────

export interface ComboConfig {
  enabled: boolean;
  /** Discount on the whole cart once it holds `minProducts` distinct products. */
  pct: number;
  minProducts: number;
}

const COMBO_KEY = "combo.cfg";

export async function getComboConfig(): Promise<ComboConfig> {
  return readSetting(COMBO_KEY, { enabled: false, pct: 10, minProducts: 2 }, (v) => ({
    enabled: bool(v.enabled, false), pct: Math.max(1, Math.min(50, num(v.pct, 10))), minProducts: Math.max(2, Math.min(10, num(v.minProducts, 2))),
  }));
}

export async function setComboConfig(patch: Partial<ComboConfig>): Promise<ComboConfig> {
  const next = { ...(await getComboConfig()), ...patch };
  await writeSetting(COMBO_KEY, { enabled: next.enabled, pct: next.pct, minProducts: next.minProducts });
  return next;
}

export const comboCouponCode = (pct: number): string => `COMBO${Math.round(pct)}`;

/**
 * Apply or lift the combo discount for this cart. Runs before the checkout
 * summary is drawn. A coupon the customer typed themselves is never touched.
 * Returns the state the summary should describe.
 */
export async function syncComboDiscount(userId: string, currency: Currency): Promise<{ applied: boolean; pct: number; need: number; distinct: number }> {
  const cfg = await getComboConfig();
  const cart = await prisma.cart.findUnique({ where: { userId }, include: { items: { include: { variant: { select: { productId: true } } } } } });
  const distinct = new Set((cart?.items ?? []).map((i) => i.variant.productId)).size;
  const current = await getCartCoupon(userId, currency).catch(() => null);
  const isCombo = current?.code.startsWith("COMBO") ?? false;
  if (!cfg.enabled) {
    if (isCombo) await removeCouponFromCart(userId).catch(() => undefined);
    return { applied: false, pct: 0, need: 0, distinct };
  }
  const eligible = distinct >= cfg.minProducts;
  if (eligible && (!current || isCombo)) {
    const code = comboCouponCode(cfg.pct);
    if (current?.code !== code) {
      await ensureSystemCoupon(code, cfg.pct);
      await applyCouponToCart(userId, code, currency).catch(() => undefined);
    }
    return { applied: true, pct: cfg.pct, need: 0, distinct };
  }
  if (!eligible && isCombo) await removeCouponFromCart(userId).catch(() => undefined);
  return { applied: false, pct: cfg.pct, need: Math.max(0, cfg.minProducts - distinct), distinct };
}

export interface AlsoBoughtRow {
  productId: string;
  name: string;
  variantId: string;
  priceMinor: number;
  currency: Currency;
}

/**
 * "Customers who bought what is in your cart also bought…": the products most
 * often found in the same completed orders, excluding what is already in the
 * cart. Falls back to the shop's best sellers when there is no co-purchase
 * data yet, so the row is never empty on a young store.
 */
export async function alsoBought(userId: string, currency: Currency, limit = 2): Promise<AlsoBoughtRow[]> {
  const cart = await prisma.cart.findUnique({ where: { userId }, include: { items: { include: { variant: { select: { productId: true } } } } } });
  const inCart = new Set((cart?.items ?? []).map((i) => i.variant.productId));
  if (inCart.size === 0) return [];
  const since = new Date(Date.now() - 90 * 86_400_000);
  const orders = await prisma.orderItem.findMany({
    where: { order: { status: "COMPLETED", createdAt: { gte: since } }, variant: { productId: { in: [...inCart] } } },
    select: { orderId: true },
    distinct: ["orderId"],
    take: 500,
  });
  const counts = new Map<string, number>();
  if (orders.length > 0) {
    const peers = await prisma.orderItem.findMany({
      where: { orderId: { in: orders.map((o) => o.orderId) }, variant: { productId: { notIn: [...inCart] } } },
      select: { variant: { select: { productId: true } } },
      take: 5000,
    });
    for (const p of peers) counts.set(p.variant.productId, (counts.get(p.variant.productId) ?? 0) + 1);
  }
  let candidates = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id).slice(0, limit * 3);
  if (candidates.length < limit) {
    const best = await prisma.orderItem.groupBy({
      by: ["variantId"], where: { order: { status: "COMPLETED", createdAt: { gte: since } } }, _count: { _all: true }, orderBy: { _count: { variantId: "desc" } }, take: 20,
    });
    const vars = await prisma.productVariant.findMany({ where: { id: { in: best.map((b) => b.variantId) } }, select: { id: true, productId: true } });
    for (const v of vars) if (!inCart.has(v.productId) && !candidates.includes(v.productId)) candidates.push(v.productId);
  }
  const products = await prisma.product.findMany({
    where: { id: { in: candidates }, status: "ACTIVE", deletedAt: null },
    include: { variants: { where: { isActive: true, deletedAt: null }, include: { prices: { where: { tier: { name: "RETAIL" } } } }, orderBy: { createdAt: "asc" } } },
  });
  const out: AlsoBoughtRow[] = [];
  for (const id of candidates) {
    const p = products.find((x) => x.id === id);
    if (!p) continue;
    const v = p.variants.find((x) => x.prices.length > 0);
    if (!v) continue;
    const exact = v.prices.find((pr) => pr.currency === currency) ?? v.prices[0];
    if (!exact) continue;
    const priceMinor = exact.currency === currency ? exact.amountMinor : convertMinor(exact.amountMinor, exact.currency as Currency, currency);
    out.push({ productId: p.id, name: p.name, variantId: v.id, priceMinor, currency });
    if (out.length >= limit) break;
  }
  return out;
}

// ── Gift vouchers ────────────────────────────────────────────────────────────

const GIFT_DAYS = 30;
const GIFT_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function giftCode(): string {
  const bytes = randomBytes(10);
  let s = "";
  for (let i = 0; i < 10; i++) s += GIFT_ALPHABET[(bytes[i] ?? 0) % GIFT_ALPHABET.length];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

export interface GiftResult {
  code: string;
  amountMinor: number;
  currency: Currency;
  expiresAt: Date;
  deepLink: string;
}

/** Move wallet balance into a gift code (debited now; refunded if never claimed). */
export async function createGift(userId: string, amountMinor: number, botUsername: string, note?: string): Promise<GiftResult> {
  amountMinor = Math.round(amountMinor);
  if (!Number.isFinite(amountMinor) || amountMinor < 100) throw new CoreError("VALIDATION_FAILED", "Minimum gift is 1.");
  const wallet = await prisma.wallet.findUnique({ where: { userId }, select: { currency: true } });
  if (!wallet) throw new CoreError("WALLET_NOT_FOUND");
  const currency = wallet.currency as Currency;
  const expiresAt = new Date(Date.now() + GIFT_DAYS * 86_400_000);
  let code = giftCode();
  for (let i = 0; i < 5 && (await prisma.giftVoucher.findUnique({ where: { code } })); i++) code = giftCode();
  const voucher = await prisma.giftVoucher.create({ data: { code, senderId: userId, amountMinor, currency, note: note?.slice(0, 120) ?? null, expiresAt } });
  try {
    await adjustWallet({ userId, amountMinor: -BigInt(amountMinor), type: "WITHDRAWAL", note: `Gift ${code}`, idempotencyKey: `gift-send:${voucher.id}` });
  } catch (e) {
    await prisma.giftVoucher.delete({ where: { id: voucher.id } }).catch(() => undefined);
    throw e;
  }
  return { code, amountMinor, currency, expiresAt, deepLink: `https://t.me/${botUsername}?start=gift_${code}` };
}

export type GiftClaim =
  | { ok: true; amountMinor: number; currency: Currency; newBalanceMinor: bigint; fromSelf: boolean }
  | { ok: false; reason: "NOT_FOUND" | "ALREADY_CLAIMED" | "EXPIRED" };

/** Redeem a code into the claimer's wallet, exactly once. */
export async function claimGift(userId: string, rawCode: string): Promise<GiftClaim> {
  const code = rawCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const norm = code.length === 10 ? `${code.slice(0, 5)}-${code.slice(5)}` : rawCode.trim().toUpperCase();
  const v = await prisma.giftVoucher.findUnique({ where: { code: norm } });
  if (!v) return { ok: false, reason: "NOT_FOUND" };
  if (v.status === "CLAIMED") return { ok: false, reason: "ALREADY_CLAIMED" };
  if (v.status !== "PENDING" || v.expiresAt < new Date()) return { ok: false, reason: "EXPIRED" };
  const flipped = await prisma.giftVoucher.updateMany({ where: { id: v.id, status: "PENDING" }, data: { status: "CLAIMED", claimedById: userId, claimedAt: new Date() } });
  if (flipped.count === 0) return { ok: false, reason: "ALREADY_CLAIMED" };
  const wallet = await prisma.wallet.findUnique({ where: { userId }, select: { currency: true } });
  const cur = (wallet?.currency ?? v.currency) as Currency;
  const credit = cur === v.currency ? v.amountMinor : convertMinor(v.amountMinor, v.currency as Currency, cur);
  const bal = await adjustWallet({ userId, amountMinor: BigInt(credit), type: "DEPOSIT", note: `Gift ${v.code} redeemed`, idempotencyKey: `gift-claim:${v.id}` });
  if (v.senderId !== userId) {
    const sender = await prisma.user.findUnique({ where: { id: v.senderId }, select: { telegramId: true } });
    const claimer = await prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, telegramHandle: true } });
    const who = claimer?.telegramHandle ? `@${claimer.telegramHandle}` : (claimer?.firstName ?? "someone");
    if (sender?.telegramId != null) {
      await enqueueTelegramMessage(sender.telegramId, `🎁 Your gift <code>${v.code}</code> (${formatMinor(v.amountMinor, v.currency as CurrencyCode)}) was redeemed by ${who.replace(/</g, "&lt;")}. Thank you for spreading the love! 💖`).catch(() => undefined);
    }
  }
  return { ok: true, amountMinor: credit, currency: cur, newBalanceMinor: bal, fromSelf: v.senderId === userId };
}

/** Cron: give unclaimed gifts back to their senders once they expire. */
export async function refundExpiredGifts(): Promise<number> {
  const rows = await prisma.giftVoucher.findMany({ where: { status: "PENDING", expiresAt: { lt: new Date() } }, take: 100 });
  let n = 0;
  for (const v of rows) {
    const flipped = await prisma.giftVoucher.updateMany({ where: { id: v.id, status: "PENDING" }, data: { status: "REFUNDED" } });
    if (flipped.count === 0) continue;
    await adjustWallet({ userId: v.senderId, amountMinor: BigInt(v.amountMinor), type: "REFUND", note: `Gift ${v.code} expired unclaimed`, idempotencyKey: `gift-refund:${v.id}` }).catch(() => undefined);
    const sender = await prisma.user.findUnique({ where: { id: v.senderId }, select: { telegramId: true } });
    if (sender?.telegramId != null) {
      await enqueueTelegramMessage(sender.telegramId, `↩️ Your gift <code>${v.code}</code> was not redeemed within ${GIFT_DAYS} days — ${formatMinor(v.amountMinor, v.currency as CurrencyCode)} is back in your wallet.`).catch(() => undefined);
    }
    n++;
  }
  return n;
}

export async function listMyGifts(userId: string, limit = 10) {
  return prisma.giftVoucher.findMany({ where: { senderId: userId }, orderBy: { createdAt: "desc" }, take: limit });
}

// ── First-order cap for new accounts ─────────────────────────────────────────

export interface RiskConfig {
  /** 0 = off. Orders above this (USD) from a brand-new account are refused. */
  newUserMaxUsd: number;
  /** How long an account counts as new. */
  newUserHours: number;
}

const RISK_KEY = "risk.cfg";

export async function getRiskConfig(): Promise<RiskConfig> {
  return readSetting(RISK_KEY, { newUserMaxUsd: 0, newUserHours: 24 }, (v) => ({
    newUserMaxUsd: Math.max(0, num(v.newUserMaxUsd, 0)), newUserHours: Math.max(1, Math.min(720, num(v.newUserHours, 24))),
  }));
}

export async function setRiskConfig(patch: Partial<RiskConfig>): Promise<RiskConfig> {
  const next = { ...(await getRiskConfig()), ...patch };
  await writeSetting(RISK_KEY, { newUserMaxUsd: next.newUserMaxUsd, newUserHours: next.newUserHours });
  return next;
}

/**
 * May this customer place an order of this value right now? New accounts
 * with no completed order are capped; everyone else passes. Amount in the
 * user's currency (minor units).
 */
export async function firstOrderAllowed(userId: string, amountMinor: number, currency: Currency): Promise<{ ok: true } | { ok: false; maxUsd: number; hoursLeft: number }> {
  const cfg = await getRiskConfig();
  if (cfg.newUserMaxUsd <= 0) return { ok: true };
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true, firstPurchaseAt: true } });
  if (!user || user.firstPurchaseAt) return { ok: true };
  const ageMs = Date.now() - user.createdAt.getTime();
  if (ageMs > cfg.newUserHours * 3600_000) return { ok: true };
  const usd = convertMinor(amountMinor, currency, "USD") / 100;
  if (usd <= cfg.newUserMaxUsd) return { ok: true };
  const hoursLeft = Math.max(1, Math.ceil((cfg.newUserHours * 3600_000 - ageMs) / 3600_000));
  await enqueueAdminAlert(`🛡 First-order cap hit: new account ${userId.slice(-6)} tried a $${usd.toFixed(2)} order (cap $${cfg.newUserMaxUsd}).`).catch(() => undefined);
  return { ok: false, maxUsd: cfg.newUserMaxUsd, hoursLeft };
}

