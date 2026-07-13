import {
  getCartView,
  getLedger,
  getProductView,
  getReferralStats,
  getWallet,
  listCategories,
  listOrders,
  listProducts,
  listTickets,
  listVault,
  type CartView,
} from "@gis/core";
import { prisma, type Currency } from "@gis/database";
import { PROVIDER_LABELS, listEnabledProviders } from "@gis/payments";
import { cb } from "@gis/shared";
import { InlineKeyboard } from "grammy";
import type { BotUser } from "./ctx.js";
import { backToMenuRow, escapeHtml, fmt, mainMenuKeyboard, mainMenuText, paginationRow } from "./ui.js";

export interface View {
  text: string;
  kb: InlineKeyboard;
}

export async function menuView(user: BotUser): Promise<View> {
  const [wallet, orderCount] = await Promise.all([
    getWallet(user.id),
    prisma.order.count({ where: { userId: user.id } }),
  ]);
  return { text: mainMenuText(user, wallet.balanceMinor, orderCount), kb: mainMenuKeyboard(user) };
}

export async function shopHomeView(user: BotUser, page: number): Promise<View> {
  const result = await listProducts({ featuredOnly: true, currency: user.currency as Currency, page });
  const kb = new InlineKeyboard();
  for (const p of result.items) {
    const price = p.fromPriceMinor === null ? "—" : `from ${fmt(p.fromPriceMinor, user.currency)}`;
    const stock = p.inStock ? "" : " · ❌ out of stock";
    kb.text(`${p.name} — ${price}${stock}`, cb("shp", "prod", p.id)).row();
  }
  paginationRow(kb, "shp", "home", result.page, result.pages);
  kb.row().text("📂 All Categories", cb("shp", "root"));
  backToMenuRow(kb);
  return {
    text: result.items.length > 0 ? "🛍 <b>Featured &amp; Bestsellers</b>" : "🛍 The shop is being restocked — check back soon!",
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
    const stock = p.inStock ? "✅" : "❌";
    kb.text(`${stock} ${p.name} — ${price}`, cb("shp", "prod", p.id)).row();
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
    kb.text(`${p.name} — ${price}`, cb("shp", "prod", p.id)).row();
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

export async function productView(user: BotUser, productId: string): Promise<View> {
  const p = await getProductView(productId, user.currency as Currency);
  const lines = [
    `<b>${escapeHtml(p.name)}</b>`,
    "",
    p.description ? escapeHtml(p.description) : "",
    "",
    p.fulfillmentMode === "AUTOMATIC" ? "⚡ Instant delivery" : "🕐 Manual delivery (~12 h)",
    p.isPlatform ? "🏬 Sold by Get It Sasta" : "🏪 Sold by a verified reseller",
  ].filter((l) => l !== "");

  const kb = new InlineKeyboard();
  for (const v of p.variants) {
    const price = v.priceMinor === null ? "—" : fmt(v.priceMinor, user.currency);
    const label = v.stock > 0 ? `➕ ${v.name} — ${price}` : `❌ ${v.name} — out of stock`;
    if (v.stock > 0 && v.priceMinor !== null) kb.text(label, cb("crt", "add", v.id)).row();
    else kb.text(label, cb("mnu", "noop")).row();
  }
  kb.text("🛒 View Cart", cb("crt", "view"));
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

export async function checkoutSummaryView(user: BotUser): Promise<View> {
  const [view, wallet] = await Promise.all([
    getCartView(user.id, user.currency as Currency),
    getWallet(user.id),
  ]);
  const gateways = listEnabledProviders(user.currency);
  const enough = wallet.balanceMinor >= BigInt(view.subtotalMinor);
  const lines = [
    "🧾 <b>Checkout</b>",
    "",
    cartText(view),
    "",
    `Wallet balance: <b>${fmt(wallet.balanceMinor, wallet.currency)}</b>`,
    gateways.length === 0 && !enough ? "⚠️ Balance too low — top up your wallet first." : "",
  ].filter((l) => l !== "");
  const kb = new InlineKeyboard();
  if (view.allAvailable && enough) {
    kb.text(`💰 Pay ${fmt(view.subtotalMinor, view.currency)} from Wallet`, cb("ord", "paywallet")).row();
  }
  if (view.allAvailable) {
    for (const p of gateways) {
      kb.text(PROVIDER_LABELS[p.id], cb("ord", "paygw", p.id)).row();
    }
  }
  kb.text("◀️ Back to Cart", cb("crt", "view"));
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
    kb.text(`🔑 ${item.productName} · ${item.variantName}`, cb("lic", "view", item.orderItemId)).row();
  }
  paginationRow(kb, "lic", "list", result.page, result.pages);
  backToMenuRow(kb);
  return {
    text: result.items.length > 0 ? "🔑 <b>My Licenses</b>\nTap an item to re-view its credentials." : "🔑 Nothing delivered yet.",
    kb,
  };
}

export async function walletView(user: BotUser): Promise<View> {
  const wallet = await getWallet(user.id);
  const kb = new InlineKeyboard().text("📜 History", cb("wal", "hist", 1)).row();
  backToMenuRow(kb);
  return {
    text: [
      `💳 <b>Wallet</b> — <b>${fmt(wallet.balanceMinor, wallet.currency)}</b> (${wallet.currency})`,
      "",
      "Wallet deposits via UPI/crypto arrive with the deposit phase — pay orders directly with UPI/crypto at checkout meanwhile.",
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
      "• Delivered keys live forever in 🔑 My Licenses.",
      "• Problems? Open a 🎫 Support ticket — a human replies here in chat.",
    ].join("\n"),
    kb,
  };
}
