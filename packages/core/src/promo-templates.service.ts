import { prisma } from "@gis/database";
import { loadConfig } from "@gis/config";
import { sendBroadcast } from "./broadcast.service.js";
import { getProductView, UNLIMITED_STOCK } from "./catalog/catalog.service.js";
import { toUsdt } from "./fx.js";
import type { Currency } from "@gis/database";

/**
 * Ready-made announcement styles that auto-fill from the product, so the same
 * item can be promoted repeatedly without the copy looking recycled.
 *
 * Uses Telegram <blockquote> for the bar-quote look. Rotation is deliberate:
 * the auto-poster never sends the same style twice in a row for a product.
 */

export const PROMO_STYLES = ["launch", "lastchance", "sellingfast", "features", "pricedrop", "restock"] as const;
export type PromoStyle = (typeof PROMO_STYLES)[number];

export const STYLE_LABELS: Record<PromoStyle, string> = {
  launch: "🚀 Launch / Only X USDT",
  lastchance: "⚡ Last chance",
  sellingfast: "🔥 Selling fast",
  features: "✅ Feature list",
  pricedrop: "📉 Price drop",
  restock: "🔔 Back in stock",
};

const esc = (x: string): string => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface PromoContext {
  name: string;
  icon: string;
  priceUsdt: string;
  stock: number | null;
  bullets: string[];
  bot: string;
  store: string;
}

/** Pull everything a template needs from the product. */
export async function promoContext(productId: string): Promise<PromoContext | null> {
  const p = await prisma.product.findUnique({
    where: { id: productId },
    select: { name: true, iconEmoji: true, description: true, status: true },
  });
  if (!p || p.status !== "ACTIVE") return null;
  const view = await getProductView(productId, "USD" as Currency).catch(() => null);
  const priced = (view?.variants ?? []).map((v) => v.priceMinor).filter((n): n is number => n !== null);
  const cheapest = priced.length ? Math.min(...priced) : null;
  const unlimited = (view?.variants ?? []).some((v) => v.stock >= UNLIMITED_STOCK);
  const units = (view?.variants ?? []).reduce((n, v) => n + (v.stock >= UNLIMITED_STOCK ? 0 : v.stock), 0);
  // Bullets from the description: one per line/• so feature lists render cleanly.
  const bullets = (p.description ?? "")
    .split(/\r?\n|•|·/)
    .map((x) => x.replace(/^[\s\-*✅]+/, "").trim())
    .filter((x) => x.length > 2 && x.length < 60)
    .slice(0, 5);
  return {
    name: p.name,
    icon: p.iconEmoji ?? "",
    priceUsdt: cheapest !== null ? toUsdt(cheapest, "USD" as Currency) : "—",
    stock: unlimited ? null : units,
    bullets,
    bot: loadConfig().BOT_USERNAME ?? "",
    store: loadConfig().STORE_NAME,
  };
}

/** Render one style. Returns HTML ready for Telegram. */
export function renderPromo(style: PromoStyle, c: PromoContext): string {
  const n = `${c.icon ? `${c.icon} ` : ""}<b>${esc(c.name)}</b>`;
  const price = `<b>${c.priceUsdt} USDT</b>`;
  const stockLine = c.stock === null ? "" : `📦 Only <b>${c.stock}</b> left in stock`;
  const bulletBlock = c.bullets.length
    ? `<blockquote>${c.bullets.map((b) => `✅ <i>${esc(b)}</i>`).join("\n")}</blockquote>`
    : "";
  const buy = c.bot ? `🔔 BUY NOW @${c.bot}` : "";

  switch (style) {
    case "launch":
      return [
        `${c.icon ? `${c.icon} ` : ""}<b>${esc(c.name)} — Only ${c.priceUsdt} USDT</b>`,
        "",
        "⚠️ <i>Price can change without notice.</i>",
        "",
        n,
        `💲 Price: ${price} Only`,
        "⚡ Instant Delivery",
        bulletBlock,
        "",
        "📈 Once today's stock is gone, this offer may not return at the same price.",
        buy,
      ].filter(Boolean).join("\n");

    case "lastchance":
      return [
        `⚡ <b>Last chance to grab ${esc(c.name)}</b>`,
        "",
        `💸 Only ${price}`,
        "⚡ Instant Delivery",
        "",
        `<blockquote>${c.icon ? `${c.icon} ` : ""}<i>Once today's stock is gone, the deal is gone.</i></blockquote>`,
        stockLine,
      ].filter(Boolean).join("\n");

    case "sellingfast":
      return [
        `👀 <b>${esc(c.name)} is selling fast.</b>`,
        "",
        "<i>No reservations.</i>",
        "<i>No holds.</i>",
        "<i>First payment = First delivery.</i>",
        "",
        `<blockquote>${c.icon ? `${c.icon} ` : ""}<i>Secure yours before someone else does.</i></blockquote>`,
        stockLine,
      ].filter(Boolean).join("\n");

    case "features":
      return [
        `${n} — ${price}`,
        "",
        "⚡ Instant Delivery · 🛡 Warranty on eligible items",
        bulletBlock || `<blockquote><i>Everything you need, delivered in seconds.</i></blockquote>`,
        "",
        stockLine,
      ].filter(Boolean).join("\n");

    case "pricedrop":
      return [
        "📉 <b>PRICE DROP</b>",
        "",
        `${n}`,
        `✅ Now ${price}`,
        "",
        `<blockquote><i>Grab it before it goes back up.</i></blockquote>`,
        stockLine,
      ].filter(Boolean).join("\n");

    case "restock":
      return [
        "🔔 <b>BACK IN STOCK</b>",
        "",
        `${n} — ${price}`,
        "⚡ Instant Delivery",
        "",
        `<blockquote><i>These went fast last time.</i></blockquote>`,
        stockLine,
      ].filter(Boolean).join("\n");
  }
}

const LAST_KEY = (productId: string): string => `promo.last:${productId}`;

/** Pick a style we did not use last time for this product. */
async function nextStyle(productId: string): Promise<PromoStyle> {
  const row = await prisma.setting.findUnique({ where: { key: LAST_KEY(productId) } }).catch(() => null);
  const last = (row?.value as { style?: string } | null)?.style;
  const pool = PROMO_STYLES.filter((s) => s !== last);
  const pick = pool[Math.floor(Math.random() * pool.length)] ?? "launch";
  await prisma.setting
    .upsert({ where: { key: LAST_KEY(productId) }, create: { key: LAST_KEY(productId), value: { style: pick } as never }, update: { value: { style: pick } as never } })
    .catch(() => undefined);
  return pick;
}

/** Announce a product with one style (or "auto" to rotate). */
export async function announcePromo(
  productId: string,
  style: PromoStyle | "auto" = "auto",
  segment: "all" | "customers" | "resellers" = "all",
): Promise<{ ok: boolean; targets?: number; style?: PromoStyle }> {
  const c = await promoContext(productId);
  if (!c) return { ok: false };
  const chosen = style === "auto" ? await nextStyle(productId) : style;
  const p = await prisma.product.findUnique({ where: { id: productId }, select: { slug: true } });
  const url = c.bot && p ? `https://t.me/${c.bot}?start=p_${p.slug}` : undefined;
  const res = await sendBroadcast({
    title: "",
    body: renderPromo(chosen, c),
    bodyIsHtml: true,
    segment,
    createdById: "promo",
    buttonText: url ? "🛒 Buy Now" : undefined,
    buttonUrl: url,
    buttonStyle: "success",
  });
  return { ok: true, targets: res.targets, style: chosen };
}

/* ── Auto-poster ──────────────────────────────────────────────────────────── */

const AUTO_KEY = "promo.auto";

export interface AutoPromoConfig { enabled: boolean; everyHours: number; productIds: string[]; lastRunAt: string | null }

export async function getAutoPromo(): Promise<AutoPromoConfig> {
  const row = await prisma.setting.findUnique({ where: { key: AUTO_KEY } }).catch(() => null);
  const v = (row?.value ?? null) as Partial<AutoPromoConfig> | null;
  return {
    enabled: v?.enabled ?? false,
    everyHours: Math.max(1, Number(v?.everyHours ?? 12)),
    productIds: Array.isArray(v?.productIds) ? v.productIds : [],
    lastRunAt: v?.lastRunAt ?? null,
  };
}

export async function setAutoPromo(patch: Partial<AutoPromoConfig>): Promise<AutoPromoConfig> {
  const cur = await getAutoPromo();
  const next = { ...cur, ...patch };
  await prisma.setting.upsert({ where: { key: AUTO_KEY }, create: { key: AUTO_KEY, value: next as never }, update: { value: next as never } });
  return next;
}

/**
 * Called by the worker. Posts ONE product with a rotated style when due, so the
 * channel gets steady variety instead of a burst of near-identical messages.
 */
export async function runAutoPromo(): Promise<{ posted: boolean; style?: string; product?: string }> {
  const cfg = await getAutoPromo();
  if (!cfg.enabled) return { posted: false };
  if (cfg.lastRunAt && Date.now() - new Date(cfg.lastRunAt).getTime() < cfg.everyHours * 3_600_000) return { posted: false };

  // Chosen products first; otherwise anything active and in stock.
  let ids = cfg.productIds;
  if (ids.length === 0) {
    const rows = await prisma.product.findMany({
      where: { status: "ACTIVE", deletedAt: null },
      orderBy: [{ pinRank: "desc" }, { createdAt: "desc" }],
      take: 20,
      select: { id: true },
    });
    ids = rows.map((r) => r.id);
  }
  if (ids.length === 0) return { posted: false };
  const productId = ids[Math.floor(Math.random() * ids.length)] as string;
  const r = await announcePromo(productId, "auto");
  await setAutoPromo({ lastRunAt: new Date().toISOString() });
  const p = await prisma.product.findUnique({ where: { id: productId }, select: { name: true } });
  return { posted: r.ok, style: r.style, product: p?.name };
}
