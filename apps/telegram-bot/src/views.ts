import {
  getCartView,
  getLedger,
  getProductView,
  getReferralStats,
  getWallet,
  getButtonConfig,
  getCartCoupon,
  getBnplStatus,
  listCategories,
  listOrders,
  listOrderItems,
  listProducts,
  listApiKeysByOwner,
  listTickets,
  listVault,
  type CartView,
} from "@gis/core";
import { prisma, type Currency } from "@gis/database";
import { loadConfig } from "@gis/config";
import { PROVIDER_LABELS, listEnabledProviders } from "@gis/payments";
import { cb } from "@gis/shared";
import { InlineKeyboard } from "grammy";
import type { BotUser } from "./ctx.js";
import { backToMenuRow, navRow, escapeHtml, fmt, mainMenuKeyboard, mainMenuText, paginationRow } from "./ui.js";
import { LOCALES, t } from "./i18n.js";
import { header, bold, num, HR, e } from "./premium.js";
import { sbtn } from "./keyboard.js";

export interface View {
  text: string;
  kb: InlineKeyboard;
  photo?: string; // optional image URL → product card / broadcast image
}

export async function menuView(user: BotUser): Promise<View> {
  const [wallet, orderCount] = await Promise.all([
    getWallet(user.id),
    prisma.order.count({ where: { userId: user.id } }),
  ]);
  const btnCfg = await getButtonConfig();
  return { text: mainMenuText(user, wallet.balanceMinor, orderCount), kb: mainMenuKeyboard(user, btnCfg) };
}

export async function shopHomeView(user: BotUser, page: number): Promise<View> {
  const result = await listProducts({ currency: user.currency as Currency, page, pageSize: 20, userId: user.id });
  const kb = new InlineKeyboard();
  for (const p of result.items) {
    const price = p.fromPriceMinor === null ? "—" : `from ${fmt(p.fromPriceMinor, user.currency)}`;
    const stock = p.inStock ? "" : " · ❌ out of stock";
    const icon = p.iconEmoji ? `${p.iconEmoji} ` : "";
    const sale = p.onSale ? "🔥 " : "";
    kb.add(sbtn(`${sale}${icon}${p.name} — ${price}${stock}`, cb("shp", "prod", p.id), p.inStock ? "success" : "danger")).row();
  }
  paginationRow(kb, "shp", "home", result.page, result.pages);
  kb.row().text("📂 All Categories", cb("shp", "root"));
  backToMenuRow(kb);
  return {
    text: result.items.length > 0 ? "🛍 <b>All Products</b> — tap an item to buy" : "🛍 The shop is being restocked — check back soon!",
    kb,
  };
}

export async function categoriesView(parentId: string | null): Promise<View> {
  const cats = await listCategories(parentId);
  const kb = new InlineKeyboard();
  for (const c of cats) {
    kb.text(`${c.emoji ?? "📂"} ${c.name}`, cb("shp", c.hasChildren ? "sub" : "cat", c.id, 1)).row();
  }
  if (parentId) kb.text("◀️ Back", cb("shp", "root"));
  backToMenuRow(kb);
  return { text: "📂 <b>Categories</b>", kb };
}

export async function productListView(
  user: BotUser,
  categoryId: string,
  page: number,
): Promise<View> {
  const result = await listProducts({ categoryId, currency: user.currency as Currency, page, userId: user.id });
  const kb = new InlineKeyboard();
  for (const p of result.items) {
    const price = p.fromPriceMinor === null ? "—" : `from ${fmt(p.fromPriceMinor, user.currency)}`;
    const stock = p.inStock ? "✅" : "❌";
    const icon = p.iconEmoji ? `${p.iconEmoji} ` : "";
    const sale = p.onSale ? "🔥 " : "";
    kb.add(sbtn(`${stock} ${sale}${icon}${p.name} — ${price}`, cb("shp", "prod", p.id), p.inStock ? "success" : "danger")).row();
  }
  paginationRow(kb, "shp", "cat", page, result.pages, categoryId);
  kb.row().text("◀️ Categories", cb("shp", "root"));
  backToMenuRow(kb);
  return { text: result.total > 0 ? "🛍 <b>Products</b>" : "No products here yet.", kb };
}

export async function searchResultsView(user: BotUser, query: string, page: number): Promise<View> {
  const result = await listProducts({ search: query, currency: user.currency as Currency, page, userId: user.id });
  const kb = new InlineKeyboard();
  for (const p of result.items) {
    const price = p.fromPriceMinor === null ? "—" : `from ${fmt(p.fromPriceMinor, user.currency)}`;
    const icon = p.iconEmoji ? `${p.iconEmoji} ` : "";
    const sale = p.onSale ? "🔥 " : "";
    kb.add(sbtn(`${sale}${icon}${p.name} — ${price}`, cb("shp", "prod", p.id), p.inStock ? "success" : "danger")).row();
  }
  paginationRow(kb, "src", "pg", page, result.pages);
  backToMenuRow(kb);
  return {
    text:
      result.total > 0
        ? `🔍 Results for “${escapeHtml(query)}” (${result.total})`
        : `🔍 Nothing found for “${escapeHtml(query)}”. Try a different name.`,
    kb,
  };
}

function timeLeft(until: Date): string {
  let ms = until.getTime() - Date.now();
  if (ms <= 0) return "ending now";
  const d = Math.floor(ms / 86_400_000); ms -= d * 86_400_000;
  const h = Math.floor(ms / 3_600_000); ms -= h * 3_600_000;
  const m = Math.floor(ms / 60_000);
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

export async function productView(user: BotUser, productId: string): Promise<View> {
  const p = await getProductView(productId, user.currency as Currency, user.id);
  const UNLIMITED = 1_000_000;
  const priced = p.variants.filter((v) => v.priceMinor !== null);
  const cheapest = priced.reduce<{ now: number; was: number | null } | null>((acc, v) => {
    if (v.priceMinor === null) return acc;
    if (!acc || v.priceMinor < acc.now) return { now: v.priceMinor, was: v.originalPriceMinor };
    return acc;
  }, null);
  const priceStr = cheapest
    ? cheapest.was !== null
      ? `${fmt(cheapest.was, user.currency)} ➜ <b>${fmt(cheapest.now, user.currency)}</b>`
      : `<b>${fmt(cheapest.now, user.currency)}</b>`
    : "—";
  const totalStock = priced.reduce((sum, v) => sum + (v.stock >= UNLIMITED ? 0 : v.stock), 0);
  const stockStr = priced.some((v) => v.stock >= UNLIMITED) ? "✅ Available" : `<b>${num(totalStock)}</b> in Stock`;
  const lines = [
    header(p.onSale ? "🔥 FLASH SALE" : "🔥 IN STOCK"),
    "",
    `📦 ${bold("Product")}`,
    `${p.iconEmoji ? p.iconEmoji + " " : ""}${p.nameHtml ?? escapeHtml(p.name)}`,
    "",
    `💎 ${bold("Price")}`,
    priceStr,
    "",
    `📈 ${bold("Available")}`,
    stockStr,
    "",
    ...(user.isVip ? [`${e("vip")} <b>VIP price applied</b>`] : []),
    p.fulfillmentMode === "AUTOMATIC" ? "⚡ Instant Delivery" : "🕐 Manual Delivery (~12 h)",
    p.isPlatform ? `🏬 Sold by ${escapeHtml(loadConfig().STORE_NAME)}` : "🏪 Verified Reseller",
    p.descriptionHtml ?? (p.description ? escapeHtml(p.description) : ""),
    HR,
  ].filter((l) => l !== "");

  const icon = p.iconEmoji ? `${p.iconEmoji} ` : "";
  const kb = new InlineKeyboard();
  for (const v of p.variants) {
    if (v.stock > 0 && v.priceMinor !== null) {
      const priceLabel =
        v.originalPriceMinor !== null
          ? `${fmt(v.originalPriceMinor, user.currency)} ➜ ${fmt(v.priceMinor, user.currency)}`
          : fmt(v.priceMinor, user.currency);
      // Direct buy: tapping asks the quantity, then goes straight to payment.
      const bl = v.name.trim().toLowerCase() === "standard" ? "" : ` ${v.name}`;
      kb.add(sbtn(`⚡ ${icon}Buy${bl} — ${priceLabel}`, cb("crt", "buynow", v.id), "success")).row();
    } else {
      const bl = v.name.trim().toLowerCase() === "standard" ? "this" : v.name;
      kb.add(sbtn(`❌ ${bl} — out of stock`, cb("mnu", "noop"), "danger")).row();
    }
  }
  navRow(kb, cb("shp", "home", 1));
  return { text: lines.join("\n"), kb, photo: p.imageUrl || undefined };
}

export function cartText(view: CartView): string {
  if (view.lines.length === 0) return "🛒 Your cart is empty.";
  const rows = view.lines.map((l, i) => {
    const price = l.lineTotalMinor === null ? "—" : fmt(l.lineTotalMinor, view.currency);
    const warn = l.available ? "" : " ⚠️ unavailable";
    const vn = l.variantName.trim().toLowerCase() === "standard" ? "" : ` · ${escapeHtml(l.variantName)}`;
    return `${i + 1}. ${escapeHtml(l.productName)}${vn} ×${l.quantity} — ${price}${warn}`;
  });
  return ["🛒 <b>Cart</b>", "", ...rows, "", `Subtotal: <b>${fmt(view.subtotalMinor, view.currency)}</b>`].join("\n");
}

export async function cartViewKb(user: BotUser): Promise<View> {
  const view = await getCartView(user.id, user.currency as Currency);
  const kb = new InlineKeyboard();
  for (const l of view.lines) {
    kb.text("➖", cb("crt", "dec", l.itemId))
      .text(`${l.quantity} × ${l.productName.slice(0, 18)}`, cb("mnu", "noop"))
      .text("➕", cb("crt", "inc", l.itemId))
      .text("🗑", cb("crt", "del", l.itemId))
      .row();
  }
  if (view.lines.length > 0) {
    kb.text("🧹 Clear", cb("crt", "clear")).text("✅ Checkout", cb("crt", "checkout")).row();
  } else {
    kb.text("🛍 Go shopping", cb("shp", "home", 1)).row();
  }
  navRow(kb, cb("shp", "home", 1));
  return { text: cartText(view), kb };
}

export async function checkoutSummaryView(user: BotUser): Promise<View> {
  const [view, wallet, coupon, bnpl] = await Promise.all([
    getCartView(user.id, user.currency as Currency),
    getWallet(user.id),
    getCartCoupon(user.id, user.currency as Currency),
    getBnplStatus(user.id),
  ]);
  const discount = coupon?.discountMinor ?? 0;
  const payable = Math.max(0, view.subtotalMinor - discount);
  const gateways = listEnabledProviders(user.currency);
  const enough = wallet.balanceMinor >= BigInt(payable);
  const lines = [
    header(`🛒 ${bold("Checkout")}`),
    "",
    cartText(view),
    ...(coupon ? [`🎟 Coupon <b>${escapeHtml(coupon.code)}</b>: −${fmt(discount, view.currency)}`, `💳 <b>Total to pay: ${fmt(payable, view.currency)}</b>`] : []),
    "",
    `Wallet balance: <b>${fmt(wallet.balanceMinor, wallet.currency)}</b>`,
    gateways.length === 0 && !enough ? "⚠️ Balance too low — top up your wallet first." : "",
  ].filter((l) => l !== "");
  const kb = new InlineKeyboard();
  if (coupon) kb.add(sbtn(`🎟 ${coupon.code} applied — ✖️ Remove`, cb("crt", "couponrm"), "primary")).row();
  else kb.add(sbtn("🎟 Apply coupon", cb("crt", "coupon"), "primary")).row();
  if (view.allAvailable && enough) {
    kb.add(sbtn(`💰 Pay ${fmt(payable, view.currency)} from Wallet`, cb("ord", "paywallet"), "success")).row();
  } else if (view.allAvailable && wallet.balanceMinor > 0n) {
    const need = payable - Number(wallet.balanceMinor);
    kb.add(sbtn(`💰 Wallet ${fmt(wallet.balanceMinor, wallet.currency)} · ➕ Add ${fmt(need, view.currency)} to pay`, cb("wal", "topup"), "primary")).row();
  }
  if (view.allAvailable && bnpl.limitMinor > 0 && bnpl.availableMinor >= payable && payable > 0) {
    kb.add(sbtn(`🕒 Pay Later — ${fmt(payable, view.currency)} (BNPL)`, cb("ord", "paybnpl"), "primary")).row();
  }
  if (view.allAvailable) {
    for (const p of gateways) {
      kb.text(PROVIDER_LABELS[p.id], cb("ord", "paygw", p.id)).row();
    }
    if (loadConfig().BINANCE_PAY_UID) {
      kb.add(sbtn("🪙 Pay via Binance (USD)", cb("ord", "paybinance"), "success")).row();
    }
    if (loadConfig().UPI_ID) {
      kb.add(sbtn("🇮🇳 Pay via UPI (INR)", cb("ord", "payupi"), "success")).row();
    }
  }
  navRow(kb, cb("crt", "view"));
  return { text: lines.join("\n"), kb };
}

export async function ordersView(user: BotUser, page: number): Promise<View> {
  const result = await listOrders(user.id, page);
  const statusEmoji: Record<string, string> = {
    COMPLETED: "✅",
    PAID: "💳",
    PENDING_FULFILLMENT: "🕐",
    PENDING_PAYMENT: "⌛",
    CANCELLED: "🚫",
    EXPIRED: "⌛",
    REFUNDED: "↩️",
  };
  const kb = new InlineKeyboard();
  for (const o of result.items) {
    kb.text(
      `${statusEmoji[o.status] ?? "•"} ${o.orderNumber} · ${fmt(o.totalPaidMinor, o.currency)}`,
      cb("ord", "view", o.id),
    ).row();
  }
  paginationRow(kb, "ord", "list", result.page, result.pages);
  backToMenuRow(kb);
  return { text: result.items.length > 0 ? `${header(`📦 ${bold("Your Orders")}`)}\nTap an order to view your delivered items.` : `${header(`📦 ${bold("Your Orders")}`)}\nNo orders yet.`, kb };
}

export async function vaultView(user: BotUser, page: number): Promise<View> {
  const result = await listVault(user.id, page);
  const kb = new InlineKeyboard();
  for (const item of result.items) {
    const vn = item.variantName.trim().toLowerCase() === "standard" ? "" : ` · ${item.variantName}`;
    kb.text(`🔑 ${item.productName}${vn}`, cb("lic", "view", item.orderItemId)).row();
  }
  paginationRow(kb, "lic", "list", result.page, result.pages);
  backToMenuRow(kb);
  return {
    text: result.items.length > 0 ? "🔑 <b>My Licenses</b>\nTap an item to re-view its credentials." : "🔑 Nothing delivered yet.",
    kb,
  };
}

export async function walletView(user: BotUser): Promise<View> {
  const [wallet, bnpl] = await Promise.all([getWallet(user.id), getBnplStatus(user.id)]);
  const kb = new InlineKeyboard()
    .text("➕ Top up", cb("wal", "topup")).text("📜 History", cb("wal", "hist", 1)).row();
  if (bnpl.outstandingMinor > 0) kb.add(sbtn(`🕒 Repay BNPL — ${fmt(bnpl.outstandingMinor, bnpl.currency)}`, cb("wal", "bnplrepay"), "success")).row();
  backToMenuRow(kb);
  const lines = [
    header(`💰 ${bold("Wallet")}`),
    `Balance: <b>${fmt(wallet.balanceMinor, wallet.currency)}</b> (${wallet.currency})`,
  ];
  if (bnpl.limitMinor > 0) {
    lines.push(
      "",
      `🕒 <b>Pay Later (BNPL)</b>`,
      `Limit: <b>${fmt(bnpl.limitMinor, bnpl.currency)}</b> · Owed: <b>${fmt(bnpl.outstandingMinor, bnpl.currency)}</b> · Available: <b>${fmt(bnpl.availableMinor, bnpl.currency)}</b>`,
    );
  }
  lines.push("", "Top up instantly with Binance (USDT) — tap ➕ Top up. You can also pay orders directly at checkout.");
  return { text: lines.join("\n"), kb };
}

export async function walletHistoryView(user: BotUser, page: number): Promise<View> {
  const ledger = await getLedger(user.id, page);
  const wallet = await getWallet(user.id);
  const sign = (n: bigint) => (n >= 0n ? "+" : "−");
  const lines = ledger.entries.map((e) => {
    const amt = e.amountMinor < 0n ? -e.amountMinor : e.amountMinor;
    return `${sign(e.amountMinor)}${fmt(amt, wallet.currency)} · ${e.type}${e.note ? ` · ${escapeHtml(e.note)}` : ""}`;
  });
  const kb = new InlineKeyboard();
  paginationRow(kb, "wal", "hist", ledger.page, ledger.pages);
  kb.row().text("◀️ Wallet", cb("wal", "view"));
  backToMenuRow(kb);
  return { text: ["📜 <b>Wallet History</b>", "", ...(lines.length > 0 ? lines : ["No transactions yet."])].join("\n"), kb };
}

export async function referralView(user: BotUser, botUsername: string): Promise<View> {
  const stats = await getReferralStats(user.id);
  const link = `https://t.me/${botUsername}?start=ref_${user.referralCode}`;
  const kb = new InlineKeyboard();
  backToMenuRow(kb);
  return {
    text: [
      header(`👥 ${bold("Referral Program")}`),
      "",
      `Your link:\n<code>${link}</code>`,
      "",
      `Invited: <b>${stats.invited}</b> · Purchased: <b>${stats.purchased}</b> · Earned: <b>${fmt(stats.earnedMinor, user.currency)}</b>`,
      "",
      "Rewards are credited to your wallet after your friend's first purchase clears the 48 h hold.",
    ].join("\n"),
    kb,
  };
}

export async function supportHomeView(user: BotUser): Promise<View> {
  const tickets = await listTickets(user.id, 1);
  const kb = new InlineKeyboard().text("🆕 New Ticket", cb("sup", "new")).row();
  for (const t of tickets.items.slice(0, 5)) {
    kb.text(`#${t.ticketNumber} · ${t.status} · ${t.subject.slice(0, 20)}`, cb("mnu", "noop")).row();
  }
  backToMenuRow(kb);
  return {
    text: [
      "🎫 <b>Help & Support</b>",
      "",
      "• Tap 🛍 Shop, open a product, tap ⚡ Buy, choose quantity, and pay.",
      "• Your delivered items live in 📦 My Orders — tap an order to view them.",
      "• Pay with UPI, Binance (USDT) or your wallet.",
      "",
      "Need a human? Tap 🆕 New Ticket below.",
    ].join("\n"),
    kb,
  };
}

export function profileView(user: BotUser): View {
  const kb = new InlineKeyboard();
  backToMenuRow(kb);
  return {
    text: [
      "👤 <b>Profile</b>",
      "",
      `Name: ${escapeHtml([user.firstName, user.lastName].filter(Boolean).join(" ") || "—")}`,
      `Username: ${user.telegramHandle ? "@" + escapeHtml(user.telegramHandle) : "—"}`,
      `Currency: ${user.currency}`,
      `Roles: ${user.roleNames.join(", ") || "CUSTOMER"}`,
      `Member since: ${user.createdAt.toISOString().slice(0, 10)}`,
    ].join("\n"),
    kb,
  };
}

export function settingsView(user: BotUser): View {
  const kb = new InlineKeyboard()
    .text(`Currency: ${user.currency} → switch`, cb("set", "curr"))
    .row()
    .text("Language: English (more coming)", cb("mnu", "noop"));
  backToMenuRow(kb);
  return { text: "⚙ <b>Settings</b>\n\nCurrency affects catalog prices for new wallet-ups.", kb };
}

export function helpView(): View {
  const kb = new InlineKeyboard()
    .add(sbtn("🛍 Shop", cb("shp", "home", 1), "success")).row()
    .text("💰 Wallet", cb("wal", "view")).text("📦 My Orders", cb("ord", "list", 1)).row()
    .text("🎫 Support", cb("sup", "home")).row();
  backToMenuRow(kb);
  return {
    text: [
      header(`❓ ${bold("Help & Commands")}`),
      "",
      `🧭 ${bold("Commands & options")}`,
      "/start — 🏠 open the main menu",
      "/shop — 🛍 browse & buy products",
      "/cart — 🛒 view your cart",
      "/orders — 📦 your orders & delivered keys",
      "/wallet — 💰 deposit & pay instantly",
      "/support — 🎫 help & live support",
      "/help — ❓ this guide",
      "",
      `More on the menu: 👥 Referral (invite &amp; earn), 💱 Currency, 🌐 Language, 🧑‍💻 Developer API.`,
      "",
      `🛒 ${bold("How to buy")}`,
      "1. Open 🛍 Shop and tap a product.",
      "2. Tap ⚡ Buy and choose the quantity.",
      "3. Pay from your 💰 Wallet, or with Binance (USDT) / UPI.",
      "4. Instant products arrive here in seconds and are saved in 🔑 My Licenses.",
      "",
      `💰 ${bold("Wallet")}`,
      "Deposit any amount with Binance (USDT) and pay instantly at checkout. Open 💰 Wallet → ➕ Top up.",
      "",
      `🆘 ${bold("Need a human?")}`,
      "Tap 🎫 Support to open a ticket — we reply right here in chat.",
    ].join("\n"),
    kb,
  };
}

export async function apiKeysView(user: BotUser): Promise<View> {
  const keys = await listApiKeysByOwner(user.id);
  const active = keys.filter((k) => !k.revokedAt);
  const kb = new InlineKeyboard();
  kb.add(sbtn("🔑 Generate API key", cb("api", "new"), "success")).row();
  if (active.length > 0) kb.text(`📋 My API keys (${active.length})`, cb("api", "list")).row();
  kb.text("📖 API Documentation", cb("api", "docs")).row();
  backToMenuRow(kb);
  return {
    text: [
      header(`🧑‍💻 ${bold("Developer API")}`),
      "",
      "Build on our store: browse the catalog, check your balance, and place orders from your wallet — all via a REST API.",
      "",
      active.length > 0
        ? `You have <b>${num(active.length)}</b> active key(s). Tap 📋 My API keys to manage them.`
        : "Tap 🔑 Generate API key to create your first key.",
    ].join("\n"),
    kb,
  };
}

export async function apiKeysListView(user: BotUser): Promise<View> {
  const keys = await listApiKeysByOwner(user.id);
  const active = keys.filter((k) => !k.revokedAt);
  const kb = new InlineKeyboard();
  kb.add(sbtn("🔑 Generate another key", cb("api", "new"), "success")).row();
  const lines = [header(`📋 ${bold("My API keys")}`), ""];
  if (active.length === 0) lines.push("You have no active keys yet.");
  for (const k of active.slice(0, 15)) {
    lines.push(`• <b>${escapeHtml(k.name)}</b> — <code>${k.prefix}…</code> · ${num(k.callCount)} calls`);
    kb.add(sbtn(`🗑 Revoke ${k.name.slice(0, 16)}`, cb("api", "revoke", k.id), "danger")).row();
  }
  navRow(kb, cb("api", "home"));
  return { text: lines.join("\n"), kb };
}

export function apiDocsView(): View {
  const base = `${(loadConfig().PUBLIC_API_URL ?? "").replace(/\/$/, "")}/api/v1/developer`;
  const hasUrl = (loadConfig().PUBLIC_API_URL ?? "").length > 0;
  const kb = new InlineKeyboard();
  if (hasUrl) kb.url("📖 Open full documentation", base).row();
  navRow(kb, cb("api", "home"));
  return {
    text: [
      header(`📖 ${bold("API Documentation")}`),
      "",
      hasUrl ? `Base URL:\n<code>${base}</code>` : "Base URL is shown once configured by the store.",
      "",
      `${bold("Auth")} — send your key as a header:`,
      "<code>Authorization: Bearer YOUR_KEY</code>",
      "<code>X-API-Key: YOUR_KEY</code>",
      "",
      `${bold("Endpoints")}`,
      "• GET /products — buyable catalog",
      "• GET /products/{id} — one product",
      "• GET /balance — wallet balance + ledger",
      "• POST /orders — place an order (paid from wallet)",
      "• GET /orders/{orderNumber} — order status",
      "• GET /health — liveness (no auth)",
      "",
      hasUrl ? `Full guide & examples: ${base}` : "",
    ].filter((l) => l !== "").join("\n"),
    kb,
  };
}

export function languageView(user: BotUser): View {
  const kb = new InlineKeyboard();
  for (const l of LOCALES) kb.text(l.label, cb("lang", "set", l.code)).row();
  backToMenuRow(kb);
  return { text: t(user.locale, "lang_title"), kb };
}

export function currencyView(user: BotUser): View {
  const kb = new InlineKeyboard()
    .text("🌐 USD ($) — recommended", cb("cur", "set", "USD"))
    .row()
    .text("🇮🇳 INR (₹)", cb("cur", "set", "INR"))
    .row();
  backToMenuRow(kb);
  return { text: t(user.locale, "cur_title"), kb };
}

export async function orderDetailView(user: BotUser, orderId: string): Promise<View> {
  const items = await listOrderItems(user.id, orderId);
  const kb = new InlineKeyboard();
  for (const it of items) {
    const vn = it.variantName.trim().toLowerCase() === "standard" ? "" : ` · ${it.variantName}`;
    kb.text(`🔑 ${it.productName}${vn}`, cb("lic", "view", it.orderItemId)).row();
  }
  kb.text("◀️ Orders", cb("ord", "list", 1));
  backToMenuRow(kb);
  return {
    text: items.length > 0 ? "📦 <b>Order items</b>\nTap to view your delivered details:" : "No delivered items in this order yet.",
    kb,
  };
}

export function quantityPickerView(variantId: string, stock: number, productId?: string): View {
  const presets = [1, 2, 5, 10, 20, 50].filter((q) => q <= stock);
  if (stock < 1_000_000 && stock > 0 && !presets.includes(stock)) presets.push(stock); // exact max
  presets.sort((a, b) => a - b);
  if (presets.length === 0) presets.push(1);
  const kb = new InlineKeyboard();
  presets.forEach((q, i) => {
    kb.text(`${q}`, cb("crt", "qty", variantId, q));
    if ((i + 1) % 3 === 0) kb.row();
  });
  kb.row();
  kb.text("✏️ Custom amount", cb("crt", "qtycustom", variantId)).row();
  navRow(kb, productId ? cb("shp", "prod", productId) : cb("shp", "home", 1));
  const cap = stock >= 1_000_000 ? "" : ` (max ${stock} available)`;
  return { text: `🔢 <b>How many do you want?</b>${cap}`, kb };
}
