import { loadConfig } from "@gis/config";
import { plainDescription } from "./tg-html.js";
import { prisma, type Currency } from "@gis/database";
import { formatMinor, isCoreError, type CurrencyCode } from "@gis/shared";
import { createHmac, timingSafeEqual } from "node:crypto";
import { convertPriceMinor } from "./fx.js";
import { effectivePriceMinor } from "./pricing.js";
import { getRedis } from "./redis.js";
import { productRatings } from "./followup.service.js";
import { getHideSoldOut, stockMapFor, UNLIMITED_STOCK } from "./catalog/catalog.service.js";
import { getLedger, getWallet } from "./wallet/wallet.service.js";
import { addToCart, clearCart, getCartView } from "./cart/cart.service.js";
import { checkoutWithWallet, type CheckoutResult } from "./orders/checkout.service.js";
import { listOrders, revealOrderDeliveries } from "./orders/order.service.js";
import { buildCombinedDeliveryText, buildDeliveryText, buildDeliveryTxt, combinedDeliveryButtons, credsOf, DELIVERY_FILE_THRESHOLD, type DeliveryLine } from "./orders/assign.js";
import { DELIVERY_FOLLOWUP, deliveryButtons, enqueueTelegramDocument, enqueueTelegramMessage } from "./queues.js";
import { firstOrderAllowed, listMyGifts, syncComboDiscount } from "./growth.service.js";
import { getReferralConfig, milestoneProgress, referralEarnings } from "./referral.service.js";
import { getReferralStats, setUserCurrency } from "./users/user.service.js";
import { tierOf } from "./loyalty.service.js";
import { listTickets } from "./support/ticket.service.js";

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
      id: p.id, slug: p.slug, name: p.name, description: plainDescription(p.description, p.descriptionHtml) || null, imageUrl: publicImageUrl(p.imageUrl), iconEmoji: p.iconEmoji, categoryId: p.categoryId,
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

// ── Signed-in actions (everything the bot menu offers, from the web page) ────

/** Only http(s) can be shown in an <img>; a Telegram file_id (photo sent to the admin) cannot. */
export const publicImageUrl = (url: string | null | undefined): string | null => (url && /^https?:\/\//i.test(url) ? url : null);

/** The customer behind a verified initData, or null when they never started the bot. */
export async function resolveMiniAppUser(initData: string): Promise<{ id: string; telegramId: bigint; currency: Currency; firstName: string | null; referralCode: string; locale: string } | null> {
  const tg = verifyInitData(initData);
  if (!tg) return null;
  const u = await prisma.user.findFirst({
    where: { telegramId: BigInt(tg.telegramId), status: "ACTIVE" },
    select: { id: true, telegramId: true, currency: true, firstName: true, referralCode: true, locale: true },
  });
  if (!u || u.telegramId === null) return null;
  return { id: u.id, telegramId: u.telegramId, currency: u.currency as Currency, firstName: u.firstName, referralCode: u.referralCode, locale: u.locale };
}

export async function miniAppOrders(userId: string, page: number) {
  const r = await listOrders(userId, Math.max(1, page), 10);
  return {
    page: r.page,
    pages: r.pages,
    items: r.items.map((o) => ({ id: o.id, orderNumber: o.orderNumber, status: o.status, totalMinor: o.totalPaidMinor, currency: o.currency, createdAt: o.createdAt.toISOString(), isReplacement: o.isReplacement === true })),
  };
}

/** One order with its items and — for the owner only — the delivered values. */
export async function miniAppOrder(userId: string, orderId: string) {
  const o = await prisma.order.findFirst({
    where: { id: orderId, userId },
    select: {
      id: true, orderNumber: true, status: true, createdAt: true, paidAt: true, currency: true, subtotalMinor: true, discountMinor: true,
      items: { select: { id: true, productNameSnap: true, variantNameSnap: true, quantity: true, fulfilledAt: true, expiresAt: true, replacedAt: true }, orderBy: { id: "asc" } },
      payments: { select: { provider: true, status: true }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!o) return null;
  const delivered = await revealOrderDeliveries(userId, orderId).catch(() => []);
  return {
    id: o.id, orderNumber: o.orderNumber, status: o.status, createdAt: o.createdAt.toISOString(), paidAt: o.paidAt?.toISOString() ?? null,
    currency: o.currency, totalMinor: o.subtotalMinor - o.discountMinor, provider: o.payments[0]?.provider ?? null,
    items: o.items.map((i) => ({ id: i.id, productName: i.productNameSnap, variantName: i.variantNameSnap, quantity: i.quantity, fulfilledAt: i.fulfilledAt?.toISOString() ?? null, expiresAt: i.expiresAt?.toISOString() ?? null, replaced: i.replacedAt !== null })),
    delivered: delivered.map((d) => ({ productName: d.productName, variantName: d.variantName, replaced: d.replaced === true, values: deliveredValues(d.payload) })),
  };
}

/** The labelled values of one delivered unit, in display order. */
function deliveredValues(p: { kind: string; key?: string; username?: string; password?: string; twofa?: string; expiresAt?: string }): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  if (p.key) for (const row of p.key.split(/\r?\n/).map((r) => r.trim()).filter(Boolean)) out.push({ label: /^https?:\/\//i.test(row) ? "Link" : "Key", value: row });
  if (p.username) out.push({ label: "ID", value: p.username });
  if (p.password) out.push({ label: "Password", value: p.password });
  if (p.twofa) out.push({ label: "2FA secret", value: p.twofa });
  if (p.expiresAt) out.push({ label: "Valid until", value: p.expiresAt.slice(0, 10) });
  return out;
}

export async function miniAppWallet(userId: string) {
  const [w, ledger, gifts] = await Promise.all([getWallet(userId), getLedger(userId, 1, 12).catch(() => ({ entries: [], page: 1, pages: 1 })), listMyGifts(userId, 5).catch(() => [])]);
  return {
    balanceMinor: Number(w.balanceMinor),
    currency: w.currency,
    entries: ledger.entries.map((e) => ({ type: e.type, amountMinor: Number(e.amountMinor), balanceAfterMinor: Number(e.balanceAfterMinor), note: e.note, createdAt: e.createdAt.toISOString() })),
    gifts: (gifts as Array<{ code?: string; amountMinor?: number; currency?: string; status?: string; createdAt?: Date }>).map((g) => ({ code: g.code ?? "", amountMinor: g.amountMinor ?? 0, currency: g.currency ?? w.currency, status: g.status ?? "", createdAt: g.createdAt?.toISOString() ?? null })),
  };
}

export async function miniAppReferral(userId: string, referralCode: string, botUsername: string | null) {
  const [stats, cfg, mile, earn, wallet] = await Promise.all([
    getReferralStats(userId), getReferralConfig(), milestoneProgress(userId).catch(() => null), referralEarnings(userId).catch(() => null), getWallet(userId),
  ]);
  return {
    link: botUsername ? `https://t.me/${botUsername}?start=ref_${referralCode}` : null,
    invited: stats.invited,
    purchased: stats.purchased,
    earnedMinor: Number(stats.earnedMinor),
    currency: wallet.currency,
    firstPct: cfg.firstPct,
    repeatPct: cfg.repeatPct,
    holdHours: cfg.holdHours,
    commissionMonths: cfg.commissionMonths,
    milestones: mile ? { mode: mile.cfg.mode, tiers: mile.cfg.tiers, repeatLast: mile.cfg.repeatLast, count: mile.count, next: mile.next, paidUsd: mile.paidUsd } : null,
    held: earn ? { minor: earn.heldMinor, currency: earn.heldCurrency, count: earn.heldCount, readyCount: earn.readyCount, nextReleaseAt: earn.nextReleaseAt?.toISOString() ?? null } : null,
  };
}

export async function miniAppProfileFull(userId: string, telegramId: bigint) {
  const [u, tier, tickets, orders] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, telegramHandle: true, currency: true, locale: true, isVip: true, createdAt: true } }),
    tierOf(userId).catch(() => null),
    listTickets(userId, 1, 5).catch(() => ({ items: [], page: 1, pages: 1 })),
    prisma.order.count({ where: { userId, status: { in: ["COMPLETED", "PAID", "PENDING_FULFILLMENT"] } } }),
  ]);
  return {
    telegramId: telegramId.toString(),
    firstName: u?.firstName ?? null,
    handle: u?.telegramHandle ?? null,
    currency: (u?.currency ?? "USD") as Currency,
    locale: u?.locale ?? "en",
    isVip: u?.isVip === true,
    memberSince: u?.createdAt?.toISOString() ?? null,
    orders,
    tier: tier ? { name: tier.tier.name, perk: tier.tier.perk, next: tier.next ? { name: tier.next.name, toNextMinor: tier.toNextMinor, currency: tier.currency } : null, progressPct: tier.progressPct } : null,
    tickets: (tickets.items as Array<{ id: string; ticketNumber: string; subject: string; status: string }>).map((t) => ({ id: t.id, number: t.ticketNumber, subject: t.subject, status: t.status })),
  };
}

export type MiniAppBuyResult =
  | { ok: true; orderId: string; orderNumber: string; totalMinor: number; currency: Currency; pendingManual: number; delivered: Array<{ productName: string; variantName: string; values: Array<{ label: string; value: string }> }> }
  | { ok: false; reason: "insufficient" | "stock" | "unavailable" | "first_order_cap" | "daily_limit" | "error"; message: string; needMinor?: number; currency?: Currency };

/**
 * Buy one variant with the wallet, from the Mini App. Same gates as the bot's
 * checkout (order limits, combo), the cart is replaced by this one line so
 * what the page quoted is what is charged, and the delivery goes to the chat
 * exactly as a bot purchase would — plus it is returned for the page to show.
 */
export async function miniAppBuyWithWallet(user: { id: string; telegramId: bigint; currency: Currency }, variantId: string, qty: number): Promise<MiniAppBuyResult> {
  const quantity = Math.max(1, Math.min(50, Math.round(qty)));
  try {
    await clearCart(user.id);
    await addToCart(user.id, variantId, quantity);
  } catch {
    return { ok: false, reason: "unavailable", message: "That product is no longer available." };
  }
  const wallet = await getWallet(user.id);
  const cart = await getCartView(user.id, wallet.currency);
  if (!cart.allAvailable) return { ok: false, reason: "stock", message: "Not enough stock for that quantity right now." };
  await syncComboDiscount(user.id, wallet.currency).catch(() => undefined);
  const gate = await firstOrderAllowed(user.id, cart.subtotalMinor, wallet.currency).catch(() => ({ ok: true as const }));
  if (!gate.ok) {
    return gate.reason === "daily_limit"
      ? { ok: false, reason: "daily_limit", message: `Daily limit: up to ${gate.maxPerDay} orders per 24 hours. Please try again later.` }
      : { ok: false, reason: "first_order_cap", message: `New accounts can order up to $${gate.maxUsd} for the first ${gate.hoursLeft} h — start with a smaller order.` };
  }
  if (Number(wallet.balanceMinor) < cart.subtotalMinor) {
    return { ok: false, reason: "insufficient", message: "Wallet balance is too low — top up first.", needMinor: cart.subtotalMinor - Number(wallet.balanceMinor), currency: wallet.currency };
  }
  let result: CheckoutResult;
  try {
    result = await checkoutWithWallet(user.id, "DIRECT");
  } catch (e) {
    const code = isCoreError(e) ? e.code : "";
    if (code === "INSUFFICIENT_BALANCE") return { ok: false, reason: "insufficient", message: "Wallet balance is too low — top up first.", currency: wallet.currency };
    if (code === "OUT_OF_STOCK" || code === "CART_ITEM_UNAVAILABLE") return { ok: false, reason: "stock", message: "Sold out while you were deciding — please pick another option." };
    return { ok: false, reason: "error", message: "Could not complete the purchase. Nothing was charged." };
  }
  // The chat gets the same delivery a bot purchase sends (keys message + the
  // detached navigation), so the customer has it in two places.
  await dispatchDeliveriesToTelegram(user.telegramId, result).catch(() => undefined);
  return {
    ok: true,
    orderId: result.orderId,
    orderNumber: result.orderNumber,
    totalMinor: result.totalMinor,
    currency: result.currency,
    pendingManual: result.pendingManualItems,
    delivered: result.deliveries.map((d) => ({ productName: d.productName, variantName: d.variantName, values: deliveredValues({ kind: d.kind, ...d.secret }) })),
  };
}

async function dispatchDeliveriesToTelegram(telegramId: bigint, r: CheckoutResult): Promise<void> {
  const money = formatMinor(r.totalMinor, r.currency as CurrencyCode);
  const lines: DeliveryLine[] = r.deliveries.map((d) => ({ productName: d.productName, variantName: d.variantName, payload: { kind: d.kind, ...d.secret }, activationGuide: d.activationGuide, allowPwChange: d.allowPwChange }));
  if (lines.length === 1) {
    const d = lines[0]!;
    await enqueueTelegramMessage(telegramId, buildDeliveryText(d.productName, d.variantName, d.payload, d.activationGuide, d.allowPwChange, { amountLabel: money, orderNumber: r.orderNumber }), { buttons: deliveryButtons(credsOf(d.payload), { orderId: r.orderId }), followUp: DELIVERY_FOLLOWUP });
  } else if (lines.length > DELIVERY_FILE_THRESHOLD) {
    await enqueueTelegramDocument(telegramId, `order-${r.orderNumber}.txt`, buildDeliveryTxt(lines, r.orderNumber, { amountLabel: money }), `🎉 Your order is delivered! ${lines.length} items are in the attached file. 💾 Saved in 📦 My Orders.`, undefined, DELIVERY_FOLLOWUP);
  } else if (lines.length > 1) {
    await enqueueTelegramMessage(telegramId, buildCombinedDeliveryText(lines, r.orderNumber, { amountLabel: money }), { buttons: combinedDeliveryButtons(lines, r.orderId), followUp: DELIVERY_FOLLOWUP });
  } else if (r.pendingManualItems > 0) {
    await enqueueTelegramMessage(telegramId, `🧾 <b>Order ${r.orderNumber}</b> — paid ${money} from your wallet (via the web shop).\n🕐 It is being prepared by hand; you'll get it here as soon as it is ready.`);
  }
}

export async function miniAppSetCurrency(userId: string, currency: Currency): Promise<void> {
  await setUserCurrency(userId, currency);
}
