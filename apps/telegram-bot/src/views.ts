import {
  getCartView,
  getLedger,
  getProductView,
  getVariantForPurchase,
  getReferralStats,
  getWallet,
  getBnplLimit,
  previewCoupon,
  listCategories,
  listOrders,
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
import { backToMenuRow, escapeHtml, fmt, mainMenuKeyboard, mainMenuText, paginationRow } from "./ui.js";
import { LOCALES, t } from "./i18n.js";

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
  return { text: mainMenuText(user, wallet.balanceMinor, orderCount), kb: mainMenuKeyboard(user) };
}

export async function shopHomeView(user: BotUser, page: number): Promise<View> {
  const result = await listProducts({ currency: user.currency as Currency, page });
  const kb = new InlineKeyboard();
  for (const p of result.items) {
    const price = p.fromPriceMinor === null ? "—" : `from ${fmt(p.fromPriceMinor, user.currency)}`;
    const stock = p.inStock ? (p.totalStock === null ? "" : ` · ${p.totalStock} left`) : " · ❌ out of stock";
    const icon = p.iconEmoji ? `${p.iconEmoji} ` : "";
    const sale = p.onSale ? "🔥 " : "";
    kb.text(`${sale}${icon}${p.name} — ${price}${stock}`, cb("shp", "prod", p.id)).row();
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
  const result = await listProducts({ categoryId, currency: user.currency as Currency, page });
  const kb = new InlineKeyboard();
  for (const p of result.items) {
    const price = p.fromPriceMinor === null ? "—" : `from ${fmt(p.fromPriceMinor, user.currency)}`;
    const stock = p.inStock ? (p.totalStock === null ? "✅" : `✅ ${p.totalStock}`) : "❌";
    const icon = p.iconEmoji ? `${p.iconEmoji} ` : "";
    const sale = p.onSale ? "🔥 " : "";
    kb.text(`${stock} ${sale}${icon}${p.name} — ${price}`, cb("shp", "prod", p.id)).row();
  }
  paginationRow(kb, "shp", "cat", page, result.pages, categoryId);
  kb.row().text("◀️ Categories", cb("shp", "root"));
  backToMenuRow(kb);
  return { text: result.total > 0 ? "🛍 <b>Products</b>" : "No products here yet.", kb };
}

export async function searchResultsView(user: BotUser, query: string, page: number): Promise<View> {
  const result = await listProducts({ search: query, currency: user.currency as Currency, page });
  const kb = new InlineKeyboard();
  for (const p of result.items) {
    const price = p.fromPriceMinor === null ? "—" : `from ${fmt(p.fromPriceMinor, user.currency)}`;
    const icon = p.iconEmoji ? `${p.iconEmoji} ` : "";
    const sale = p.onSale ? "🔥 " : "";
    kb.text(`${sale}${icon}${p.name} — ${price}`, cb("shp", "prod", p.id)).row();
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
  const p = await getProductView(productId, user.currency as Currency);
  const title = `${p.iconEmoji ? `${p.iconEmoji} ` : ""}${escapeHtml(p.name)}`;
  const saleBadge =
    p.onSale && p.salePercentBp
      ? `🔥 <b>FLASH SALE — ${Math.round(p.salePercentBp / 100)}% OFF</b>${p.saleEndsAt ? ` · ⏳ ${timeLeft(p.saleEndsAt)}` : ""}`
      : "";
  const hasFullDesc = Boolean(p.description && p.description.trim());
  const hasHighlight = Boolean(p.highlight && p.highlight.trim());
  const intro = hasHighlight ? escapeHtml(p.highlight as string) : (hasFullDesc ? escapeHtml(p.description as string) : "");
  const lines = [
    `<b>${title}</b>`,
    saleBadge,
    "",
    intro,
    "",
    p.fulfillmentMode === "AUTOMATIC" ? "⚡ Instant delivery" : "🕐 Manual delivery (~12 h)",
    p.isPlatform ? "🏬 Sold by Get It Sasta" : "🏪 Sold by a verified reseller",
  ].filter((l) => l !== "");

  const icon = p.iconEmoji ? `${p.iconEmoji} ` : "";
  const singleVariant = p.variants.length === 1;
  const kb = new InlineKeyboard();
  // When there's a highlight teaser AND a longer description, offer to expand it.
  if (hasHighlight && hasFullDesc) {
    kb.text("📖 Full description", cb("shp", "desc", p.id)).row();
  }
  for (const v of p.variants) {
    if (v.stock > 0 && v.priceMinor !== null) {
      const priceLabel =
        v.originalPriceMinor !== null
          ? `${fmt(v.originalPriceMinor, user.currency)} ➜ ${fmt(v.priceMinor, user.currency)}`
          : fmt(v.priceMinor, user.currency);
      // One tap → choose quantity → buy (no cart). Hide a lone/"Standard" variant name.
      const left = v.stock >= Number.MAX_SAFE_INTEGER ? "" : ` · ${v.stock} left`;
      const named = !singleVariant && v.name.toLowerCase() !== "standard";
      const buyLabel = named ? `Buy ${v.name}` : "Buy";
      kb.text(`⚡ ${icon}${buyLabel} — ${priceLabel}${left}`, cb("crt", "qty", v.id, 1)).row();
    } else {
      kb.text(`❌ ${v.name} — out of stock`, cb("mnu", "noop")).row();
    }
  }
  backToMenuRow(kb);
  return { text: lines.join("\n"), kb, photo: p.imageUrl || undefined };
}

export async function quantitySelectView(user: BotUser, variantId: string, qty: number): Promise<View> {
  const v = await getVariantForPurchase(variantId, user.currency as Currency);
  const unlimited = v.stock >= Number.MAX_SAFE_INTEGER;
  const maxQ = unlimited ? 99 : Math.max(1, v.stock);
  const q = Math.min(Math.max(Math.trunc(qty) || 1, 1), maxQ);
  const icon = v.iconEmoji ? `${v.iconEmoji} ` : "";
  const unit = v.unitPriceMinor;
  const total = unit === null ? null : unit * q;
  const totalLabel =
    total === null
      ? "—"
      : v.originalPriceMinor !== null
        ? `${fmt(v.originalPriceMinor * q, user.currency)} ➜ ${fmt(total, user.currency)}`
        : fmt(total, user.currency);
  const lines = [
    `🛍 <b>${icon}${escapeHtml(v.productName)}</b>`,
    v.variantName.toLowerCase() !== "standard" ? `Variant: <b>${escapeHtml(v.variantName)}</b>` : "",
    unlimited ? "In stock" : v.stock > 0 ? `In stock: <b>${v.stock}</b>` : "❌ Out of stock",
    "",
    `Quantity: <b>${q}</b>`,
    `Total: <b>${totalLabel}</b>`,
  ].filter((l) => l !== "");
  const kb = new InlineKeyboard();
  kb.text("➖", cb("crt", "qty", variantId, Math.max(1, q - 1)))
    .text(`${q}`, cb("mnu", "noop"))
    .text("➕", cb("crt", "qty", variantId, Math.min(maxQ, q + 1)))
    .row();
  if (unit !== null && v.stock > 0) {
    kb.text(`⚡ Buy ×${q} — ${fmt(total as number, user.currency)}`, cb("crt", "buyqty", variantId, q)).row();
  }
  kb.text("◀️ Back to product", cb("shp", "prod", v.productId)).row();
  backToMenuRow(kb);
  return { text: lines.join("\n"), kb };
}

export async function productDescriptionView(user: BotUser, productId: string): Promise<View> {
  const p = await getProductView(productId, user.currency as Currency);
  const title = `${p.iconEmoji ? `${p.iconEmoji} ` : ""}${escapeHtml(p.name)}`;
  const lines = [
    `📖 <b>${title}</b>`,
    "",
    p.description ? escapeHtml(p.description) : "No description available.",
  ];
  const kb = new InlineKeyboard().text("◀️ Back to product", cb("shp", "prod", p.id)).row();
  backToMenuRow(kb);
  return { text: lines.join("\n"), kb };
}

export function cartText(view: CartView): string {
  if (view.lines.length === 0) return "🛒 Your cart is empty.";
  const rows = view.lines.map((l, i) => {
    const price = l.lineTotalMinor === null ? "—" : fmt(l.lineTotalMinor, view.currency);
    const warn = l.available ? "" : " ⚠️ unavailable";
    return `${i + 1}. ${escapeHtml(l.productName)} · ${escapeHtml(l.variantName)} ×${l.quantity} — ${price}${warn}`;
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
  backToMenuRow(kb);
  return { text: cartText(view), kb };
}

export async function checkoutSummaryView(user: BotUser, couponCode?: string): Promise<View> {
  const [view, wallet] = await Promise.all([
    getCartView(user.id, user.currency as Currency),
    getWallet(user.id),
  ]);
  const gateways = listEnabledProviders(user.currency);

  // Preview any applied coupon against the live cart (defensive: if it's no
  // longer valid we just show why and don't apply it).
  let discountMinor = 0;
  let appliedCode: string | null = null;
  let couponNote = "";
  if (couponCode && view.lines.length > 0) {
    try {
      const pv = await previewCoupon(user.id, couponCode);
      discountMinor = pv.discountMinor;
      appliedCode = pv.code;
    } catch (e) {
      couponNote = `⚠️ Coupon not applied: ${e instanceof Error ? e.message : "invalid"}`;
    }
  }
  const payableMinor = Math.max(0, view.subtotalMinor - discountMinor);
  const enough = wallet.balanceMinor >= BigInt(payableMinor);

  // BNPL: available when the customer has a credit line that covers the shortfall.
  const bnplLimit = view.lines.length > 0 ? await getBnplLimit(user.id) : 0;
  const canBnpl = bnplLimit > 0 && !enough && BigInt(payableMinor) <= wallet.balanceMinor + BigInt(bnplLimit);
  const oweMinor = payableMinor - Math.max(0, Number(wallet.balanceMinor));

  const lines = [
    "🧾 <b>Checkout</b>",
    "",
    cartText(view),
    "",
    appliedCode ? `🏷 Coupon <b>${escapeHtml(appliedCode)}</b>: −${fmt(discountMinor, view.currency)}` : "",
    appliedCode ? `Payable: <b>${fmt(payableMinor, view.currency)}</b>` : "",
    couponNote,
    `Wallet balance: <b>${fmt(wallet.balanceMinor, wallet.currency)}</b>`,
    canBnpl ? `🕒 You can pay later — you'd owe <b>${fmt(oweMinor, view.currency)}</b> (limit ${fmt(bnplLimit, view.currency)}).` : "",
    gateways.length === 0 && !enough && !canBnpl ? "⚠️ Balance too low — top up your wallet first." : "",
  ].filter((l) => l !== "");

  const kb = new InlineKeyboard();
  if (view.lines.length > 0) {
    if (appliedCode) kb.text("❌ Remove coupon", cb("ord", "couponclear")).row();
    else kb.text("🏷 Apply coupon", cb("ord", "coupon")).row();
  }
  if (view.allAvailable && enough) {
    kb.text(`💰 Pay ${fmt(payableMinor, view.currency)} from Wallet`, cb("ord", "paywallet")).row();
  }
  if (view.allAvailable && canBnpl) {
    kb.text(`🕒 Buy now, pay later (owe ${fmt(oweMinor, view.currency)})`, cb("ord", "paylater")).row();
  }
  if (view.allAvailable) {
    for (const p of gateways) {
      kb.text(PROVIDER_LABELS[p.id], cb("ord", "paygw", p.id)).row();
    }
    if (loadConfig().UPI_ID) {
      kb.text("🇮🇳 Pay via UPI (INR)", cb("ord", "payupi")).row();
    }
    if (loadConfig().BINANCE_PAY_UID) {
      kb.text("🪙 Pay via Binance (USD)", cb("ord", "paybinance")).row();
    }
  }
  kb.text("◀️ Back to shop", cb("shp", "home", 1));
  backToMenuRow(kb);
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
      cb("mnu", "noop"),
    ).row();
  }
  paginationRow(kb, "ord", "list", result.page, result.pages);
  backToMenuRow(kb);
  return { text: result.items.length > 0 ? "📦 <b>Your Orders</b>" : "📦 No orders yet.", kb };
}

export async function vaultView(user: BotUser, page: number): Promise<View> {
  const result = await listVault(user.id, page);
  const kb = new InlineKeyboard();
  for (const item of result.items) {
    kb.text(`📦 ${item.productName} · ${item.variantName}`, cb("lic", "view", item.orderItemId)).row();
  }
  paginationRow(kb, "lic", "list", result.page, result.pages);
  backToMenuRow(kb);
  return {
    text: result.items.length > 0 ? "🧾 <b>My Orders</b>\nAll your delivered products. Tap one to re-view its details." : "🧾 No delivered products yet.",
    kb,
  };
}

export async function walletView(user: BotUser): Promise<View> {
  const wallet = await getWallet(user.id);
  const kb = new InlineKeyboard()
    .text("➕ Top up", cb("wal", "topup")).text("📜 History", cb("wal", "hist", 1)).row();
  backToMenuRow(kb);
  return {
    text: [
      `💳 <b>Wallet</b> — <b>${fmt(wallet.balanceMinor, wallet.currency)}</b> (${wallet.currency})`,
      "",
      "Top up instantly with Binance (USDT) — tap ➕ Top up. You can also pay orders directly at checkout.",
    ].join("\n"),
    kb,
  };
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
      "👥 <b>Referral Program</b>",
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
  return { text: "🎫 <b>Support</b>", kb };
}

/** Combined Help & Support: how-it-works plus open/see tickets in one place. */
export async function helpSupportView(user: BotUser): Promise<View> {
  const tickets = await listTickets(user.id, 1);
  const kb = new InlineKeyboard().text("🆕 New Support Ticket", cb("sup", "new")).row();
  for (const t of tickets.items.slice(0, 5)) {
    kb.text(`#${t.ticketNumber} · ${t.status} · ${t.subject.slice(0, 20)}`, cb("mnu", "noop")).row();
  }
  backToMenuRow(kb);
  return {
    text: [
      "🆘 <b>Help &amp; Support</b>",
      "",
      "• Tap 🛍 <b>Browse Products</b>, pick an item, choose a quantity, and pay.",
      "• Pay by UPI, crypto, or wallet — instant items arrive in seconds.",
      "• Everything you buy is saved in 🧾 <b>My Orders</b> (use 🔁 Request replacement if a key fails).",
      "• Still stuck? Open a ticket below — a human replies right here in chat.",
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
  const kb = new InlineKeyboard();
  backToMenuRow(kb);
  return {
    text: [
      "❓ <b>Help</b>",
      "",
      "• Browse 🛍 Shop or 📂 Categories, tap a product, add to 🛒 Cart.",
      "• Pay by UPI, crypto, or wallet — instant items are delivered in seconds.",
      "• Delivered keys live forever in 🧾 My Orders.",
      "• Problems? Open a 🎫 Support ticket — a human replies here in chat.",
    ].join("\n"),
    kb,
  };
}

export async function apiKeysView(user: BotUser): Promise<View> {
  const keys = await listApiKeysByOwner(user.id);
  const kb = new InlineKeyboard().text("➕ Create API key", cb("api", "new")).row();
  const lines = [
    "🧑‍💻 <b>Developer API</b>",
    "",
    "Create a personal, read-only key to access the public catalog API.",
    "Docs & base URL are shown after you create a key.",
    "",
  ];
  const active = keys.filter((k) => !k.revokedAt);
  if (active.length === 0) lines.push("You have no active keys yet.");
  for (const k of active.slice(0, 10)) {
    lines.push(`• <b>${escapeHtml(k.name)}</b> — <code>${k.prefix}…</code> · ${k.callCount} calls`);
    kb.text(`🗑 Revoke ${k.name.slice(0, 16)}`, cb("api", "revoke", k.id)).row();
  }
  backToMenuRow(kb);
  return { text: lines.join("\n"), kb };
}

export function languageView(user: BotUser): View {
  const kb = new InlineKeyboard();
  for (const l of LOCALES) kb.text(l.label, cb("lang", "set", l.code)).row();
  backToMenuRow(kb);
  return { text: t(user.locale, "lang_title"), kb };
}

export function currencyView(user: BotUser): View {
  const kb = new InlineKeyboard()
    .text("🇮🇳 INR (₹)", cb("cur", "set", "INR"))
    .text("🌐 USD ($)", cb("cur", "set", "USD"))
    .row();
  backToMenuRow(kb);
  return { text: t(user.locale, "cur_title"), kb };
}
