import { loadConfig } from "@gis/config";
import { prisma, type Currency } from "@gis/database";
import { createHmac, timingSafeEqual } from "node:crypto";
import { convertPriceMinor } from "./fx.js";
import { effectivePriceMinor } from "./pricing.js";
import { getRedis } from "./redis.js";
import { productRatings } from "./followup.service.js";
import { getHideSoldOut, stockMapFor, UNLIMITED_STOCK } from "./catalog/catalog.service.js";
import { getWallet } from "./wallet/wallet.service.js";

/**
 * Data for the Telegram Mini App storefront (apps/api serves the page).
 *
 * The page is a catalogue: grid, search, category chips, product sheet. The
 * purchase itself is handed back to the bot through the product deep link
 * (t.me/<bot>?start=p_<slug>), so every payment rail, coupon and wallet rule
 * stays in one place. The catalogue is public and cached a minute; the
 * personal bits (name, currency, balance) need a valid initData.
 */

export interface MiniAppProduct {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  iconEmoji: string | null;
  categoryId: string | null;
  fromPriceMinor: number | null;
  wasPriceMinor: number | null;
  onSale: boolean;
  inStock: boolean;
  stock: number | null;
  rating: number | null;
  ratingCount: number;
  variants: Array<{ id: string; name: string; priceMinor: number | null; inStock: boolean }>;
}

export interface MiniAppCatalog {
  store: string;
  currency: Currency;
  botUsername: string | null;
  categories: Array<{ id: string; name: string; emoji: string | null; count: number }>;
  products: MiniAppProduct[];
  generatedAt: string;
}

export async function buildMiniAppCatalog(currency: Currency): Promise<MiniAppCatalog> {
  const redis = getRedis();
  const key = `miniapp:catalog:${currency}`;
  try {
    const raw = await redis.get(key);
    if (raw) return JSON.parse(raw) as MiniAppCatalog;
  } catch { /* build */ }

  const cfg = loadConfig();
  const [products, cats, hideSoldOut, botRow] = await Promise.all([
    prisma.product.findMany({
      where: { status: "ACTIVE", deletedAt: null },
      orderBy: [{ pinRank: "desc" }, { sortOrder: "asc" }, { createdAt: "desc" }],
      include: {
        variants: {
          where: { isActive: true, deletedAt: null },
          orderBy: { createdAt: "asc" },
          include: { prices: { where: { tier: { name: "RETAIL" } } } },
        },
      },
      take: 400,
    }),
    // Every active category, not just the roots: products usually live in
    // sub-categories, and a chip per leaf is what a storefront shows anyway.
    prisma.category.findMany({ where: { isActive: true, deletedAt: null }, orderBy: { sortOrder: "asc" }, select: { id: true, name: true, emoji: true } }).catch(() => []),
    getHideSoldOut(),
    prisma.setting.findUnique({ where: { key: "bot.username" } }),
  ]);
  const [ratings, stockMap] = await Promise.all([
    productRatings(products.map((p) => p.id)).catch(() => new Map()),
    stockMapFor(products.map((p) => ({
      id: p.id, type: p.type, supplierId: p.supplierId, supplierStock: p.supplierStock,
      reusable: p.reusableSecretEnc !== null, reusableStock: p.reusableStock,
      manual: p.fulfillmentMode === "MANUAL", manualStock: p.manualStock,
      variantIds: p.variants.map((v) => v.id),
    }))).catch(() => new Map<string, number>()),
  ]);
  const now = new Date();
  const out: MiniAppProduct[] = [];
  for (const p of products) {
    const variants = p.variants.map((v) => {
      const exact = v.prices.find((pr) => pr.currency === currency) ?? v.prices[0];
      const base = exact ? (exact.currency === currency ? exact.amountMinor : convertPriceMinor(exact.amountMinor, exact.currency as Currency, currency)) : null;
      const units = stockMap.get(v.id) ?? UNLIMITED_STOCK;
      return { id: v.id, name: v.name, priceMinor: base === null ? null : effectivePriceMinor(base, p, now, 1), basePriceMinor: base, inStock: units > 0, units };
    });
    const priced = variants.filter((v) => v.priceMinor !== null);
    if (priced.length === 0) continue;
    const inStock = variants.some((v) => v.inStock);
    if (hideSoldOut && !inStock) continue;
    const cheapest = priced.reduce((a, b) => ((a.priceMinor ?? 0) <= (b.priceMinor ?? 0) ? a : b));
    const onSale = cheapest.basePriceMinor !== null && cheapest.priceMinor !== null && cheapest.priceMinor < cheapest.basePriceMinor;
    const r = ratings.get(p.id) as { avg: number; count: number } | undefined;
    const counted = variants.filter((v) => v.units !== UNLIMITED_STOCK);
    const stock = counted.length === 0 ? null : counted.reduce((s, v) => s + v.units, 0);
    out.push({
      id: p.id, slug: p.slug, name: p.name, description: p.description, imageUrl: p.imageUrl, iconEmoji: p.iconEmoji, categoryId: p.categoryId,
      fromPriceMinor: cheapest.priceMinor, wasPriceMinor: onSale ? cheapest.basePriceMinor : null, onSale, inStock, stock,
      rating: r && r.count > 0 ? Math.round(r.avg * 10) / 10 : null, ratingCount: r?.count ?? 0,
      variants: variants.map((v) => ({ id: v.id, name: v.name, priceMinor: v.priceMinor, inStock: v.inStock })),
    });
  }
  const counts = new Map<string, number>();
  for (const p of out) if (p.categoryId) counts.set(p.categoryId, (counts.get(p.categoryId) ?? 0) + 1);
  const categories = cats
    .map((c) => ({ id: c.id, name: c.name, emoji: c.emoji, count: counts.get(c.id) ?? 0 }))
    .filter((c) => c.count > 0);
  const botUsername = cfg.BOT_USERNAME ?? ((botRow?.value as { username?: string } | null)?.username ?? null);
  const catalog: MiniAppCatalog = { store: cfg.STORE_NAME, currency, botUsername, categories, products: out, generatedAt: new Date().toISOString() };
  await redis.set(key, JSON.stringify(catalog), "EX", 60).catch(() => undefined);
  return catalog;
}

/** The bot records its own @username at startup so the API can build deep links without extra config. */
export async function rememberBotUsername(username: string | undefined): Promise<void> {
  if (!username) return;
  const value = { username };
  await prisma.setting.upsert({ where: { key: "bot.username" }, create: { key: "bot.username", value }, update: { value } }).catch(() => undefined);
}

export interface MiniAppUser {
  telegramId: string;
  firstName: string | null;
  username: string | null;
  languageCode: string | null;
}

/**
 * Verify Telegram WebApp initData (HMAC-SHA256 over the sorted
 * data-check-string with key = HMAC("WebAppData", bot token)) and reject
 * anything older than a day. Returns the user it vouches for, or null.
 */
export function verifyInitData(initData: string, maxAgeSec = 86_400): MiniAppUser | null {
  if (!initData || initData.length > 8192) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const pairs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort();
  const secret = createHmac("sha256", "WebAppData").update(loadConfig().BOT_TOKEN).digest();
  const expected = createHmac("sha256", secret).update(pairs.join("\n")).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const authDate = Number(params.get("auth_date") ?? 0);
  if (!Number.isFinite(authDate) || Date.now() / 1000 - authDate > maxAgeSec) return null;
  try {
    const u = JSON.parse(params.get("user") ?? "{}") as { id?: number; first_name?: string; username?: string; language_code?: string };
    if (!u.id) return null;
    return { telegramId: String(u.id), firstName: u.first_name ?? null, username: u.username ?? null, languageCode: u.language_code ?? null };
  } catch {
    return null;
  }
}

/** What the Mini App shows in its header for a verified Telegram user. */
export async function miniAppProfile(telegramId: string): Promise<{ known: boolean; currency: Currency; balanceMinor: number; balanceCurrency: Currency; firstName: string | null; orders: number }> {
  const u = await prisma.user.findFirst({ where: { telegramId: BigInt(telegramId) }, select: { id: true, currency: true, firstName: true } });
  if (!u) return { known: false, currency: "USD", balanceMinor: 0, balanceCurrency: "USD", firstName: null, orders: 0 };
  const [wallet, orders] = await Promise.all([getWallet(u.id).catch(() => null), prisma.order.count({ where: { userId: u.id, status: { in: ["COMPLETED", "PAID", "PENDING_FULFILLMENT"] } } })]);
  // The wallet keeps its own currency; after a currency switch it differs from
  // the price currency, so the balance is labelled with the wallet's.
  return { known: true, currency: u.currency as Currency, balanceMinor: wallet ? Number(wallet.balanceMinor) : 0, balanceCurrency: (wallet?.currency ?? u.currency) as Currency, firstName: u.firstName, orders };
}
