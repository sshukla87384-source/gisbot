import {
  getCartView,
  getLedger,
  getProductView,
  getReferralStats,
  getWallet,
  getButtonConfig,
  getCartCoupon,
  convertMinor,
  getBnplStatus,
  getReferralConfig,
  listCategories,
  listOrders,
  listOrderItems,
  listProducts,
  listApiKeysByOwner,
  listTickets,
  getMyTicket,
  type ReplaceableItem,
  listVault,
  listReplaceableItems,
  productRating,
  publishedTestimonials,
  isWatching,
  listWatches,
  todaysDeals,
  searchMyKeys,
  tierOf,
  getTiers,
  getSpinConfig,
  activeChallenge,
  storeRating,
  productRatings,
  greetName,
  toUsdt,
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
  // getButtonConfig was a separate sequential round trip on the most-rendered
  // screen in the bot.
  const [wallet, orderCount, btnCfg] = await Promise.all([
    getWallet(user.id),
    prisma.order.count({ where: { userId: user.id } }),
    getButtonConfig(),
  ]);
  return { text: mainMenuText(user, wallet.balanceMinor, orderCount), kb: mainMenuKeyboard(user, btnCfg) };
}


/** "Name (29)" · "❌ Name (0)" · "Name (∞)" — matches the stock-list style. */
function stockTag(p: { inStock: boolean; stock: number | null }): string {
  if (p.stock === null) return " (∞)";
  return ` (${p.stock})`;
}
function outMark(p: { inStock: boolean }): string {
  return p.inStock ? "" : "❌ ";
}

export async function shopHomeView(user: BotUser, page: number): Promise<View> {
  const result = await listProducts({ currency: user.currency as Currency, page, pageSize: 20, userId: user.id, locale: user.locale });
  const kb = new InlineKeyboard();
  for (const p of result.items) {
    const price = p.fromPriceMinor === null ? "—" : fmt(p.fromPriceMinor, user.currency);
    const icon = p.iconEmoji ? `${p.iconEmoji} ` : "";
    const sale = p.onSale ? "🔥 " : "";
    const label = `${sale}${icon}${outMark(p)}${p.name} — ${price}${stockTag(p)}`;
    kb.add(sbtn(label, cb("shp", "prod", p.id), p.inStock ? ((p.buttonStyle as "primary" | "success" | "danger" | null) ?? "success") : "danger", p.iconCustomEmojiId ?? undefined)).row();
  }
  paginationRow(kb, "shp", "home", result.page, result.pages);
  kb.row().add(sbtn("🔍 Search products", cb("shp", "find"), "primary")).row();
  kb.text("📂 All Categories", cb("shp", "root"));
  backToMenuRow(kb);
  return {
    text: result.items.length > 0
      ? "🛍 <b>All Products</b>\n<i>How to buy: tap a product → choose quantity → pay from your 💰 wallet. Delivery is instant for automatic items.</i>"
      : "🛍 The shop is being restocked — check back soon!",
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
  const result = await listProducts({ categoryId, currency: user.currency as Currency, page, userId: user.id, locale: user.locale });
  const kb = new InlineKeyboard();
  for (const p of result.items) {
    const price = p.fromPriceMinor === null ? "—" : fmt(p.fromPriceMinor, user.currency);
    const icon = p.iconEmoji ? `${p.iconEmoji} ` : "";
    const sale = p.onSale ? "🔥 " : "";
    kb.add(sbtn(`${sale}${icon}${outMark(p)}${p.name} — ${price}${stockTag(p)}`, cb("shp", "prod", p.id), p.inStock ? ((p.buttonStyle as "primary" | "success" | "danger" | null) ?? "success") : "danger", p.iconCustomEmojiId ?? undefined)).row();
  }
  paginationRow(kb, "shp", "cat", page, result.pages, categoryId);
  kb.row().add(sbtn("🔍 Search products", cb("shp", "find"), "primary")).row();
  kb.text("◀️ Categories", cb("shp", "root"));
  backToMenuRow(kb);
  return { text: result.total > 0 ? "🛍 <b>Products</b>" : "No products here yet.", kb };
}

export async function searchResultsView(user: BotUser, query: string, page: number): Promise<View> {
  const result = await listProducts({ search: query, currency: user.currency as Currency, page, userId: user.id, locale: user.locale });
  const kb = new InlineKeyboard();
  for (const p of result.items) {
    const price = p.fromPriceMinor === null ? "—" : fmt(p.fromPriceMinor, user.currency);
    const icon = p.iconEmoji ? `${p.iconEmoji} ` : "";
    const sale = p.onSale ? "🔥 " : "";
    kb.add(sbtn(`${sale}${icon}${outMark(p)}${p.name} — ${price}${stockTag(p)}`, cb("shp", "prod", p.id), p.inStock ? ((p.buttonStyle as "primary" | "success" | "danger" | null) ?? "success") : "danger", p.iconCustomEmojiId ?? undefined)).row();
  }
  paginationRow(kb, "src", "pg", page, result.pages);
  kb.row().add(sbtn("🔍 Search again", cb("shp", "find"), "primary")).row();
  kb.text("🛍 All products", cb("shp", "home", 1));
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
  const [p, rating, store, quotes, watchingStock, watchingPrice] = await Promise.all([
    getProductView(productId, user.currency as Currency, user.id, "DIRECT", user.locale),
    productRating(productId),
    storeRating(),
    publishedTestimonials({ productId, limit: 2 }),
    isWatching(user.id, productId, "RESTOCK"),
    isWatching(user.id, productId, "PRICE_DROP"),
  ]);
  // When the text was machine-translated, show the translated plain text rather
  // than the stored premium-emoji HTML (which is still the original language).
  const translated = (user.locale ?? "en") !== "en";
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
  const anyStock = priced.some((v) => v.stock >= UNLIMITED || v.stock > 0);
  const stockStr = priced.some((v) => v.stock >= UNLIMITED)
    ? "✅ Available"
    : anyStock
      ? `<b>${num(totalStock)}</b> in Stock`
      : "❌ <b>Sold out</b>";
  // A hook line, chosen from the product's own state — the same urgency copy the
  // promo templates use, so the card and the announcement speak with one voice.
  const hook = !anyStock
    ? "🔔 <i>Restocking soon — price may change with the new batch.</i>"
    : p.onSale
      ? "🔥 <i>Flash sale — this price will not last.</i>"
      : totalStock > 0 && totalStock <= 5
        ? "⚡ <i>Selling fast — only a few left. No reservations, no holds.</i>"
        : "⚠️ <i>Price can change without notice.</i>";
  const lines = [
    header(!anyStock ? "🔔 RESTOCKING SOON" : p.onSale ? "🔥 FLASH SALE" : "🔥 IN STOCK"),
    "",
    hook,
    "",
    `📦 ${bold("Product")}`,
    `${p.iconEmoji ? p.iconEmoji + " " : ""}${translated ? escapeHtml(p.name) : (p.nameHtml ?? escapeHtml(p.name))}`,
    "",
    `💎 ${bold("Price")}`,
    priceStr,
    "",
    `📈 ${bold("Available")}`,
    stockStr,
    // Out of stock is a waiting message, not a dead end.
    ...(!anyStock
      ? ["",
         "┏━━━━━━━━━━━━━━━━━━",
         "┃ 🔔 <b>RESTOCKING SOON</b>",
         "┃",
         "┃ This one sold out fast! 🔥",
         "┃ Fresh stock is on the way —",
         "┃ usually within a few hours.",
         "┃",
         "┃ 💡 <i>Price may change slightly",
         "┃ with the new batch.</i>",
         "┗━━━━━━━━━━━━━━━━━━",
         "",
         watchingStock
           ? "🔔 <b>You're on the list</b> — we'll message you the moment it lands."
           : "🔔 Tap <b>Notify me</b> below and you'll hear first.",
         "",
         "👉 Or tap 🛍 <b>All products</b> — plenty in stock right now!"]
      : []),
    "",
    // A personal price the admin set for THIS customer.
    ...(p.hasCustomPrice
      ? [`💎 <b>Special price just for you, ${escapeHtml(greetName(user))}!</b>`, "<i>This is your personal rate — not the public price.</i>"]
      : user.isVip
        ? [`${e("vip")} <b>VIP price applied</b>`]
        : []),
    // Real rating from visible reviews. Hidden under 3 so one early review
    // cannot define a product — the store rating is shown instead.
    rating.count >= 3
      ? `${rating.stars} <b>${rating.avg.toFixed(1)}</b>/5 · <i>${num(rating.count)} review${rating.count === 1 ? "" : "s"}</i>`
      : store.count >= 3
        ? `${store.stars} <b>${store.avg.toFixed(1)}</b>/5 store rating · <i>${num(store.count)} reviews</i>`
        : "",
    (p.fulfillmentMode === "AUTOMATIC" || p.supplierBacked) ? "⚡ Instant Delivery" : "🕐 Manual Delivery (~12 h)",
    // Warranty shown exactly as the admin set it, with the day count.
    p.warranty
      ? (p.warrantyDays
          ? `🛡 <b>${p.warrantyDays}-day replacement warranty</b> — faulty item? we replace it free`
          : "🛡 <b>Replacement warranty included</b> — faulty item? we replace it free")
      : "🏷 <b>As-is deal</b> — no replacement warranty, priced accordingly",
    p.isPlatform ? `🏬 Sold by ${escapeHtml(loadConfig().STORE_NAME)}` : "🏪 Verified Reseller",
    translated ? (p.description ? escapeHtml(p.description) : "") : (p.descriptionHtml ?? (p.description ? escapeHtml(p.description) : "")),
    HR,
    // Curated testimonials — clearly labelled, and never part of the star average.
    ...(quotes.length > 0
      ? ["", `💬 <b>What customers say</b>`,
          ...quotes.flatMap((q) => [
            `${"⭐".repeat(q.rating)} <i>“${escapeHtml(q.body).slice(0, 220)}”</i>`,
            `— <b>${escapeHtml(q.customerName)}</b>${q.company ? `, ${escapeHtml(q.company)}` : ""} ${q.verified ? "· ✅ verified purchase" : "· <i>shared with permission</i>"}`,
          ])]
      : []),
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
      const buyLabel = p.buyButtonText ? `${p.buyButtonText} — ${priceLabel}` : `⚡ ${icon}Buy${bl} — ${priceLabel}`;
      const buyStyle = (p.buttonStyle as "primary" | "success" | "danger" | null) ?? "success";
      kb.add(sbtn(buyLabel, cb("crt", "buynow", v.id), buyStyle, p.iconCustomEmojiId ?? undefined)).row();
    } else {
      const bl = v.name.trim().toLowerCase() === "standard" ? "this" : v.name;
      kb.add(sbtn(`❌ ${bl} — out of stock`, cb("mnu", "noop"), "danger")).row();
    }
  }
  // Notify-me options: restock when sold out, price drop always.
  if (!anyStock) {
    kb.add(sbtn(watchingStock ? "🔔 On the list — stop notifying" : "🔔 Notify me when back in stock", cb("wch", watchingStock ? "offr" : "onr", productId), watchingStock ? "primary" : "success")).row();
  }
  kb.add(sbtn(watchingPrice ? "📉 Watching price — stop" : "📉 Tell me if the price drops", cb("wch", watchingPrice ? "offp" : "onp", productId), "primary")).row();
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

  // The wallet is charged in ITS OWN currency, which may differ from the
  // currency the customer browses in. Everything below compares wallet-currency
  // amounts; mixing the two made the button show a wrong/zero amount.
  const walletCur = wallet.currency as Currency;
  let walletPayable = payable;
  if (walletCur !== (user.currency as Currency)) {
    try {
      const [wView, wCoupon] = await Promise.all([
        getCartView(user.id, walletCur),
        getCartCoupon(user.id, walletCur),
      ]);
      walletPayable = Math.max(0, wView.subtotalMinor - (wCoupon?.discountMinor ?? 0));
    } catch {
      // No price list in the wallet currency — fall back to the configured rate.
      walletPayable = convertMinor(payable, user.currency as Currency, walletCur);
    }
  }
  const enough = wallet.balanceMinor >= BigInt(walletPayable);
  const crossCur = walletCur !== (user.currency as Currency);
  const walletChargeLabel = `${fmt(walletPayable, walletCur)}${walletCur === "USD" ? " USDT" : ""}`;
  const lines = [
    header(`🛒 ${bold("Checkout")}`),
    "",
    cartText(view),
    ...(coupon ? [`🎟 Coupon <b>${escapeHtml(coupon.code)}</b>: −${fmt(discount, view.currency)}`, `💳 <b>Total to pay: ${fmt(payable, view.currency)}</b>`] : []),
    "",
    view.hasCustomPrice ? `💎 <b>Special price just for you, ${escapeHtml(greetName(user))}!</b>` : "",
    `Wallet balance: <b>${fmt(wallet.balanceMinor, wallet.currency)}</b>${walletCur === "USD" ? " USDT" : ""}`,
    crossCur ? `🔁 Wallet charge for this order: <b>${walletChargeLabel}</b>  <i>(${fmt(payable, view.currency)})</i>` : "",
    (user.currency as string) === "INR" && loadConfig().UPI_ID
      ? "\n💡 <b>Paying in USDT is cheaper</b> — INR prices include a small handling fee.\n⚡ Binance (USDT) also delivers instantly, while UPI is verified by hand."
      : "",
    gateways.length === 0 && !enough ? "⚠️ Balance too low — top up your wallet first." : "",
  ].filter((l) => l !== "");
  const kb = new InlineKeyboard();
  if (coupon) kb.add(sbtn(`🎟 ${coupon.code} applied — ✖️ Remove`, cb("crt", "couponrm"), "primary")).row();
  else kb.add(sbtn("🎟 Apply coupon", cb("crt", "coupon"), "primary")).row();
  if (view.allAvailable && enough) {
    const label = crossCur
      ? `💰 Pay ${walletChargeLabel} from Wallet  (${fmt(payable, view.currency)})`
      : `💰 Pay ${fmt(payable, view.currency)} from Wallet`;
    kb.add(sbtn(label, cb("ord", "paywallet"), "success")).row();
  } else if (view.allAvailable && wallet.balanceMinor > 0n) {
    // Not enough for the whole order — spend what they have and pay the rest.
    const need = Math.max(0, walletPayable - Number(wallet.balanceMinor));
    kb.add(sbtn(`🪙 Use wallet ${fmt(wallet.balanceMinor, walletCur)} + pay ${fmt(need, walletCur)} via Binance`, cb("ord", "paybinance", "w"), "success")).row();
    if (loadConfig().UPI_ID && (user.currency as string) === "INR") {
      kb.add(sbtn(`🇮🇳 Use wallet + pay rest via UPI 🕐`, cb("ord", "payupi", "w"), "primary")).row();
    }
    kb.add(sbtn(`➕ Or top up ${fmt(need, walletCur)} first`, cb("wal", "topup"), "primary")).row();
  }
  if (view.allAvailable && bnpl.limitMinor > 0 && bnpl.availableMinor >= walletPayable && walletPayable > 0) {
    kb.add(sbtn(`🕒 Pay Later — ${fmt(walletPayable, bnpl.currency as Currency)} (BNPL)`, cb("ord", "paybnpl"), "primary")).row();
  }
  if (view.allAvailable) {
    for (const p of gateways) {
      kb.text(PROVIDER_LABELS[p.id], cb("ord", "paygw", p.id)).row();
    }
    if (loadConfig().BINANCE_PAY_UID) {
      kb.add(sbtn("🪙 Pay via Binance (USDT) ⚡ instant", cb("ord", "paybinance"), "success")).row();
    }
    // UPI is INR-only and needs manual approval — hide it from USD/USDT customers.
    if (loadConfig().UPI_ID && (user.currency as string) === "INR") {
      kb.add(sbtn("🇮🇳 Pay via UPI (INR) 🕐 manual approval", cb("ord", "payupi"), "primary")).row();
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
  return { text: result.items.length > 0
    ? `${header(`📦 ${bold("Your Orders")}`)}\n<i>Tap any order to view or re-copy your delivered keys/accounts. ✅ = delivered, 🕐 = being delivered.</i>`
    : `${header(`📦 ${bold("Your Orders")}`)}\n<i>No orders yet — head to 🛍 Shop to make your first purchase.</i>`, kb };
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
    wallet.currency === "USD"
      ? `🇮🇳 Worth about <b>₹${(convertMinor(Number(wallet.balanceMinor), "USD" as Currency, "INR" as Currency) / 100).toFixed(2)}</b> at the store rate`
      : `🪙 Worth about <b>${toUsdt(Number(wallet.balanceMinor), wallet.currency as Currency)} USDT</b> at the store rate`,
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
  const [stats, cfg] = await Promise.all([getReferralStats(user.id), getReferralConfig()]);
  const link = `https://t.me/${botUsername}?start=ref_${user.referralCode}`;
  const store = loadConfig().STORE_NAME;
  const shareText = `🎁 Join ${store} — instant digital products at the best prices! Use my link:`;
  const kb = new InlineKeyboard()
    .url("📤 Share my link", `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(shareText)}`)
    .row();
  backToMenuRow(kb);
  return {
    text: [
      header(`🎁 ${bold("Refer & Earn")}`),
      "",
      "Invite friends and earn <b>real wallet rewards</b> on everything they buy! 💸",
      HR,
      `🎯 <b>How it works</b>`,
      "1️⃣ Share your personal link below.",
      "2️⃣ Your friend taps it and starts the bot.",
      "3️⃣ Every time they buy, you earn a % of their order — paid straight to your wallet.",
      "",
      `💰 <b>Reward scheme</b>`,
      `• Friend's <b>first purchase</b>: you earn <b>${cfg.firstPct}%</b>`,
      `• <b>Every purchase after that</b>: you earn <b>${cfg.repeatPct}%</b>`,
      `• Rewards are held for <b>${cfg.holdHours}h</b> (anti-fraud), then auto-credited to your 💰 Wallet.`,
      `• No limit — the more friends buy, the more you earn. Spend rewards on any product.`,
      HR,
      `📊 <b>Your progress</b>`,
      `👥 Invited: <b>${num(stats.invited)}</b>  ·  🛍 Purchased: <b>${num(stats.purchased)}</b>  ·  💰 Earned: <b>${fmt(stats.earnedMinor, user.currency)}</b>`,
      "",
      `🔗 <b>Your link</b> (tap to copy)`,
      `<code>${link}</code>`,
    ].join("\n"),
    kb,
  };
}

export async function supportHomeView(user: BotUser): Promise<View> {
  const tickets = await listTickets(user.id, 1);
  const kb = new InlineKeyboard().add(sbtn("💬 Chat with Support", cb("sup", "chat"), "success")).row().text("🆕 New Ticket", cb("sup", "new")).row();
  for (const t of tickets.items.slice(0, 5)) {
    const dot = t.status === "WAITING_CUSTOMER" ? "💬" : t.status === "RESOLVED" ? "✅" : t.status === "CLOSED" ? "🔒" : "⌛";
    kb.text(`${dot} ${t.ticketNumber} · ${t.subject.slice(0, 22)}`, cb("tkt", "open", t.id)).row();
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
      "💬 Tap <b>Chat with Support</b> to message our team live — we reply right here.",
      "Or open a 🆕 Ticket for a tracked request — tap any ticket below to read the replies.",
      "",
      "💬 = support replied   ⌛ = with our team   ✅ = resolved   🔒 = closed",
    ].join("\n"),
    kb,
  };
}

export async function profileView(user: BotUser): Promise<View> {
  const [wallet, orders, bnpl, ref] = await Promise.all([
    getWallet(user.id),
    listOrders(user.id, 1),
    getBnplStatus(user.id).catch(() => null),
    getReferralStats(user.id).catch(() => null),
  ]);
  const spent = orders.items.reduce((n, o) => n + o.totalPaidMinor, 0);
  const done = orders.items.filter((o) => o.status === "COMPLETED").length;
  const kb = new InlineKeyboard()
    .add(sbtn("➕ Add balance", cb("wal", "topup"), "success")).row()
    .add(sbtn("📦 Recent orders", cb("prf", "orders"), "primary"), sbtn("🔄 Replacement", cb("rep", "home"), "primary")).row()
    .add(sbtn("🔔 My Watchlist", cb("wch", "list"), "primary"), sbtn("🔑 Find my keys", cb("lic", "find"), "primary")).row()
    .add(sbtn("🏆 My Tier", cb("prf", "tier"), "success"), sbtn("🎡 Spin & Win", cb("spn", "home"), "success")).row()
    .add(sbtn("🎯 Missions", cb("msn", "home"), "primary")).row()
    .add(sbtn("🎁 Refer & earn", cb("ref", "view"), "success")).row();
  backToMenuRow(kb);
  return {
    text: [
      header(`👤 ${bold("My Account")}`),
      "",
      `👋 <b>${escapeHtml([user.firstName, user.lastName].filter(Boolean).join(" ") || "there")}</b>`,
      `🔗 Username: ${user.telegramHandle ? "@" + escapeHtml(user.telegramHandle) : "<i>not set</i>"}`,
      `🆔 Your ID: <code>${user.telegramId ?? "—"}</code>`,
      user.isVip ? `${e("vip")} <b>VIP member</b>` : "",
      "",
      HR,
      `💳 Wallet: <b>${fmt(wallet.balanceMinor, wallet.currency)}</b>${
        wallet.currency === "USD"
          ? `  <i>(≈ ₹${(convertMinor(Number(wallet.balanceMinor), "USD" as Currency, "INR" as Currency) / 100).toFixed(2)})</i>`
          : `  <i>(≈ ${toUsdt(Number(wallet.balanceMinor), wallet.currency as Currency)} USDT)</i>`
      }`,
      bnpl && bnpl.limitMinor > 0
        ? `🕒 Pay Later: <b>${fmt(bnpl.availableMinor, bnpl.currency)}</b> available${bnpl.outstandingMinor > 0 ? ` · owed <b>${fmt(bnpl.outstandingMinor, bnpl.currency)}</b>` : ""}`
        : "",
      `📦 Orders: <b>${num(orders.items.length)}${orders.pages > 1 ? "+" : ""}</b>${done > 0 ? ` · ✅ ${num(done)} delivered` : ""}`,
      spent > 0 ? `💰 Total spent: <b>${fmt(spent, wallet.currency)}</b>` : "",
      ref && ref.invited > 0 ? `🎁 Invited: <b>${num(ref.invited)}</b> · bought <b>${num(ref.purchased)}</b> · earned <b>${fmt(ref.earnedMinor, wallet.currency)}</b>` : "",
      HR,
      "",
      `💱 Currency: <b>${user.currency}</b>   ·   🌐 Language: <b>${user.locale.toUpperCase()}</b>`,
      `📅 Member since ${user.createdAt.toISOString().slice(0, 10)}`,
    ].filter((l) => l !== "").join("\n"),
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
    .add(sbtn("💬 Chat with Support", cb("sup", "chat"), "primary")).row()
    .text("🎫 Support / Tickets", cb("sup", "home")).row();
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
      "/referral — 🎁 refer &amp; earn",
      "/api — 🧑‍💻 developer API",
      "/replace — 🔄 request a replacement (faulty item)",
      "/language — 🌐 change language",
      "/help — ❓ this guide",
      "",
      `More on the menu: 🎁 Refer &amp; Earn (invite friends, earn %), 💱 Currency, 🌐 Language, 🧑‍💻 Developer API.`,
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
  if (active.length > 0) kb.text("📦 API Orders", cb("api", "orders")).text("💰 API Balance", cb("api", "balance")).row();
  kb.text("📖 API Documentation", cb("api", "docs")).row();
  if (active.length > 0) kb.add(sbtn("🛠 Fix permissions (403 errors)", cb("api", "fixscopes"), "primary")).row();
  backToMenuRow(kb);
  return {
    text: [
      header(`🧑‍💻 ${bold("Developer API")}`),
      "",
      "Build on our store: browse the catalog, check your balance, and place orders from your wallet — all via a REST API.",
      "<i>New here? Tap 📖 API Documentation for the base URL, auth header and example requests.</i>",
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

export async function apiOrdersView(user: BotUser): Promise<View> {
  const result = await listOrders(user.id, 1);
  const statusEmoji: Record<string, string> = { COMPLETED: "✅", PAID: "💳", PENDING_FULFILLMENT: "🕐", PENDING_PAYMENT: "⌛", CANCELLED: "🚫", EXPIRED: "⌛", REFUNDED: "↩️", PARTIALLY_REFUNDED: "↩️" };
  const kb = new InlineKeyboard();
  const lines = [header(`📦 ${bold("API Orders")}`), "", "Recent orders on your account (including those placed via the API):", ""];
  if (result.items.length === 0) lines.push("No orders yet.");
  for (const o of result.items.slice(0, 15)) lines.push(`${statusEmoji[o.status] ?? "•"} <code>${o.orderNumber}</code> · ${fmt(o.totalPaidMinor, o.currency)} · ${o.status}`);
  navRow(kb, cb("api", "home"));
  return { text: lines.join("\n"), kb };
}

export async function apiBalanceView(user: BotUser): Promise<View> {
  const wallet = await getWallet(user.id);
  const kb = new InlineKeyboard().text("➕ Top up", cb("wal", "topup")).row();
  navRow(kb, cb("api", "home"));
  return {
    text: [
      header(`💰 ${bold("API Balance")}`),
      "",
      `Available: <b>${toUsdt(Number(wallet.balanceMinor), wallet.currency as Currency)} USDT</b>`,
      `<i>(wallet holds ${fmt(wallet.balanceMinor, wallet.currency)} ${wallet.currency})</i>`,
      "",
      "The API always reports this balance in <b>USDT</b> — <code>GET /balance</code> returns <code>balance</code> / <code>balanceUsdt</code> with <code>currency: \"USDT\"</code>.",
      "",
      "This is what the API spends when you place an order (<code>POST /orders</code>). Top up via ➕ Top up.",
    ].join("\n"),
    kb,
  };
}

/** Last 5 orders — open one for its keys, or start a replacement. */
export async function recentOrdersView(user: BotUser): Promise<View> {
  const res = await listOrders(user.id, 1);
  const items = res.items.slice(0, 5);
  const icon = (st: string): string =>
    st === "COMPLETED" ? "✅" : st === "PENDING_PAYMENT" ? "⌛" : st === "CANCELLED" || st === "EXPIRED" ? "🚫" : "🕐";
  const kb = new InlineKeyboard();
  for (const o of items) {
    kb.text(`${icon(o.status)} ${o.orderNumber} · ${fmt(o.totalPaidMinor, o.currency)}`, cb("ord", "view", o.id)).row();
  }
  if (items[0]) kb.add(sbtn(`⚡ Buy again — ${items[0].orderNumber}`, cb("ord", "again", items[0].id), "success")).row();
  if (res.pages > 1) kb.add(sbtn("🗂 All orders", cb("ord", "list", 1), "primary")).row();
  kb.add(sbtn("🔄 Request a replacement", cb("rep", "home"), "success")).row();
  navRow(kb, cb("prf", "view"));
  return {
    text: items.length > 0
      ? [
          header(`📦 ${bold("Recent orders")}`),
          "",
          "Your last 5 orders. Tap one to see or re-copy its keys.",
          "",
          "✅ delivered · 🕐 in progress · ⌛ awaiting payment · 🚫 cancelled",
          "",
          "<i>Something not working? Tap 🔄 Request a replacement.</i>",
        ].join("\n")
      : `${header(`📦 ${bold("Recent orders")}`)}\n\nNo orders yet — head to 🛍 Shop to make your first purchase.`,
    kb,
  };
}

export function apiDocsView(): View {
  const base = `${(loadConfig().PUBLIC_API_URL ?? "").replace(/\/$/, "")}/api/v1/developer`;
  const hasUrl = (loadConfig().PUBLIC_API_URL ?? "").length > 0;
  const kb = new InlineKeyboard();
  if (hasUrl) kb.url("📖 Open full documentation", base).row();
  if (hasUrl) kb.url("🤖 Machine-readable docs (.txt)", `${base}/docs.txt`).row();
  navRow(kb, cb("api", "home"));
  return {
    text: [
      header(`📖 ${bold("API Documentation")}`),
      "",
      hasUrl ? `Base URL:\n<code>${base}</code>` : "Base URL is shown once configured by the store.",
      "",
      ...(hasUrl
        ? [
            "🤖 <b>Importing into another shop or tool?</b>",
            "Give it one of these instead of a docs page — they are made to be read automatically:",
            `<code>${base}/docs.txt</code>`,
            `<code>${base}/manifest</code>`,
            "",
          ]
        : []),
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
  return { text: `${t(user.locale, "cur_title")}\n<i>Your wallet balance and all prices are shown in the currency you pick. Current: <b>${user.currency}</b>. You can switch anytime.</i>`, kb };
}

export async function orderDetailView(user: BotUser, orderId: string): Promise<View> {
  // Independent reads, so fetch them together.
  const [items, meta] = await Promise.all([
    listOrderItems(user.id, orderId),
    // Explain a replacement-only order rather than leaving a mystery 0.00 entry.
    prisma.order.findFirst({
      where: { id: orderId, userId: user.id },
      select: { replacementOfOrderId: true },
    }).catch(() => null),
  ]);
  const origNumber = meta?.replacementOfOrderId
    ? (await prisma.order.findUnique({ where: { id: meta.replacementOfOrderId }, select: { orderNumber: true } }).catch(() => null))?.orderNumber ?? null
    : null;
  const kb = new InlineKeyboard();
  if (items.length === 0) {
    kb.text("◀️ Orders", cb("ord", "list", 1));
    backToMenuRow(kb);
    return { text: "No delivered items in this order yet.", kb };
  }
  // Group identical products so a 15× order isn't 15 buttons.
  const groups = new Map<string, { name: string; count: number; firstId: string }>();
  for (const it of items) {
    const vn = it.variantName.trim().toLowerCase() === "standard" ? "" : ` · ${it.variantName}`;
    const label = `${it.productName}${vn}`;
    const g = groups.get(label);
    if (g) g.count++;
    else groups.set(label, { name: label, count: 1, firstId: it.orderItemId });
  }
  const lines = origNumber
    ? [
        "🔄 <b>Replacement issued</b>",
        `This order holds the replacement for <b>${escapeHtml(origNumber)}</b>.`,
        "🛡 <i>Your warranty still runs from the original purchase date — a replacement does not extend it.</i>",
        "",
        "📦 <b>Replacement item</b>",
        "",
      ]
    : ["📦 <b>Order items</b>", ""];
  for (const g of groups.values()) lines.push(`🔑 ${escapeHtml(g.name)}${g.count > 1 ? ` ×${g.count}` : ""}`);
  if (items.length > 10) {
    kb.add(sbtn(`📄 Get all ${items.length} keys`, cb("ord", "reveal", orderId), "success")).row();
  } else {
    for (const g of groups.values()) kb.text(`🔑 View ${g.name.slice(0, 26)}${g.count > 1 ? ` (×${g.count})` : ""}`, cb("lic", "view", g.firstId)).row();
    if (items.length > 1) kb.add(sbtn("📄 Get all keys", cb("ord", "reveal", orderId), "success")).row();
  }
  kb.add(sbtn("⚡ Buy this again", cb("ord", "again", orderId), "success")).row();
  kb.add(sbtn("⭐ Rate this order", cb("rev", "new", orderId), "primary")).row();
  kb.text("🔄 Request a replacement", cb("rep", "home")).row();
  kb.text("◀️ Orders", cb("ord", "list", 1));
  backToMenuRow(kb);
  return { text: lines.join("\n"), kb };
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

/** 🔄 Replacement — pick a delivered item to claim on. */
export async function replaceListView(user: BotUser): Promise<View> {
  const items = await listReplaceableItems(user.id, 20);
  const kb = new InlineKeyboard();
  for (const i of items) {
    const tag = i.route === "claim" ? "🔄" : i.route === "blocked" ? "⌛" : (i.warranty ? "⏳" : "🚫");
    kb.text(`${tag} ${i.label.slice(0, 28)} · ${i.orderNumber}`, cb("rep", "pick", i.orderItemId)).row();
  }
  backToMenuRow(kb);
  return {
    text: items.length
      ? [
          header(`🔄 ${bold("Request a Replacement")}`),
          "",
          "Tap the item you are having trouble with.",
          "",
          "🔄 = covered by warranty   ⏳ = warranty expired   🚫 = sold as-is   ⌛ = under review",
          "",
          "<i>Covered items get a replacement claim our team reviews. For ⏳ and 🚫 items you can raise a support ticket instead, and a real person will help.</i>",
        ].join("\n")
      : `${header(`🔄 ${bold("Request a Replacement")}`)}\n\nYou have no delivered items yet.`,
    kb,
  };
}

export function replaceAskReasonView(label: string, viaTicket = false): View {
  const kb = new InlineKeyboard().text("✖️ Cancel", cb("rep", "home"));
  return {
    text: [
      header(viaTicket ? `🎫 ${bold("Raise a support ticket")}` : `🔄 ${bold("Replacement claim")}`),
      "",
      `📦 <b>${escapeHtml(label)}</b>`,
      "",
      "Step 1 of 2 — describe the problem in one message (e.g. <i>password not working</i>, <i>key already used</i>).",
      ...(viaTicket ? ["", "<i>Support reads every ticket and replies here.</i>"] : []),
    ].join("\n"),
    kb,
  };
}

/**
 * Tapped an item with no warranty (or an expired one). There is deliberately NO
 * replacement button here — only the honest option: raise a ticket and let
 * support decide. Promising a replacement we may not give would be worse.
 */
export function replaceTicketOfferView(item: ReplaceableItem): View {
  const kb = new InlineKeyboard()
    .add(sbtn("🎫 Raise a support ticket", cb("rep", "tkt", item.orderItemId), "success")).row()
    .text("◀️ Back", cb("rep", "home"));
  const asIs = !item.warranty;
  return {
    text: [
      header(`🚫 ${bold("No replacement on this item")}`),
      "",
      `📦 <b>${escapeHtml(item.label)}</b>`,
      `🧾 ${escapeHtml(item.orderNumber)}`,
      "",
      asIs
        ? "This product was sold <b>as-is</b>, with no warranty, so an automatic replacement isn't available for it."
        : `The warranty on this item has <b>expired</b>${item.reason?.includes("Already") ? "" : ""}, so an automatic replacement isn't available.`,
      ...(item.reason?.startsWith("Already replaced") ? ["", "It has already been replaced once under warranty."] : []),
      "",
      "🎫 <b>You can still raise a support ticket.</b>",
      "Tell us what went wrong and our support team will reply right here. They can help, and they can choose to issue a replacement as a goodwill gesture — that decision is made by a person, not automatically.",
    ].join("\n"),
    kb,
  };
}

/** A claim is already in the queue — nothing to do but wait. */
export function replaceBlockedView(item: ReplaceableItem): View {
  const kb = new InlineKeyboard().text("◀️ Back", cb("rep", "home"));
  return {
    text: [
      header(`⌛ ${bold("Already under review")}`),
      "",
      `📦 <b>${escapeHtml(item.label)}</b>`,
      `🧾 ${escapeHtml(item.orderNumber)}`,
      "",
      "Our team is looking at your request right now. You will get a message here as soon as there is news — no need to submit it again. 🙏",
    ].join("\n"),
    kb,
  };
}

/** The customer's own ticket thread, so support replies live somewhere findable. */
export async function ticketThreadView(user: BotUser, ticketId: string): Promise<View> {
  const t = await getMyTicket(user.id, ticketId);
  const kb = new InlineKeyboard();
  if (!t) {
    kb.text("◀️ Support", cb("sup", "home"));
    return { text: "🎫 Ticket not found.", kb };
  }
  const open = t.status !== "CLOSED" && t.status !== "RESOLVED";
  if (open) kb.add(sbtn("↩️ Reply", cb("tkt", "re", t.id), "success")).row();
  kb.text("◀️ Support", cb("sup", "home")).row();
  backToMenuRow(kb);
  const label: Record<string, string> = { CUSTOMER: "🧑 You", ADMIN: "🎧 Support", SYSTEM: "⚙️" };
  return {
    text: [
      header(`🎫 ${bold(`Ticket ${t.ticketNumber}`)}`),
      `📌 Status: <b>${t.status.replace(/_/g, " ")}</b>`,
      ...(t.itemLabel ? [`📦 ${escapeHtml(t.itemLabel)}${t.orderNumber ? ` · ${escapeHtml(t.orderNumber)}` : ""}`] : []),
      "",
      ...t.messages.slice(-12).map((m) =>
        `${label[m.authorType] ?? ""} <i>${m.createdAt.toISOString().slice(5, 16).replace("T", " ")}</i>\n${escapeHtml(m.body).slice(0, 500)}${m.proofFileId ? "\n📷 <i>screenshot attached</i>" : ""}\n`,
      ),
      open ? "<i>Tap ↩️ Reply to add to this ticket.</i>" : "<i>This ticket is closed. Open a new one any time.</i>",
    ].join("\n"),
    kb,
  };
}

/** 🏆 My Tier — real lifetime spend, next tier, and any gifts. */
export async function tierView(user: BotUser): Promise<View> {
  const [st, tiers] = await Promise.all([tierOf(user.id), getTiers()]);
  const bar = (pct: number): string => "█".repeat(Math.round(pct / 10)).padEnd(10, "░");
  const kb = new InlineKeyboard();
  kb.add(sbtn("🎡 Spin for a challenge", cb("spn", "home"), "success")).row();
  navRow(kb, cb("prf", "view"));
  return {
    text: [
      header(`🏆 ${bold("My Tier")}`),
      "",
      `Your tier: <b>${st.tier.name}</b> — ${escapeHtml(st.tier.perk)}`,
      `💰 Lifetime spend: <b>${fmt(st.spendMinor, st.currency)}</b>`,
      "",
      st.next
        ? `${bar(st.progressPct)} ${st.progressPct}%\n📈 Spend <b>${fmt(st.toNextMinor, st.currency)}</b> more to reach <b>${st.next.name}</b>`
        : "👑 <b>You are at the top tier.</b> Thank you!",
      "",
      HR,
      "<b>All tiers</b>",
      ...tiers.map((t) => `${t.name === st.tier.name ? "▶️" : "  "} <b>${t.name}</b> — from ${fmt(t.minSpendMinor, st.currency)} · ${escapeHtml(t.perk)}`),
    ].join("\n"),
    kb,
  };
}

/** 🎡 Spin & Win — one spin per purchase, explained. */
export async function spinView(user: BotUser): Promise<View> {
  const [cfg, mission] = await Promise.all([getSpinConfig(), activeChallenge(user.id)]);
  const kb = new InlineKeyboard();
  if (mission) kb.add(sbtn("🎯 Open my Mission", cb("msn", "home"), "primary")).row();
  else kb.add(sbtn("🎯 Try a Mission instead", cb("msn", "home"), "primary")).row();
  navRow(kb, cb("prf", "view"));
  if (!cfg.enabled) {
    return { text: `${header(`🎡 ${bold("Spin & Win")}`)}\n\nNot running right now — check back soon!`, kb };
  }
  return {
    text: [
      header(`🎡 ${bold("Spin & Win")}`),
      "",
      "🎁 <b>Every purchase earns a spin.</b>",
      "",
      `• Orders of <b>${fmt(cfg.minSpendMinor, user.currency as Currency)}</b> or more can win`
        + ` up to <b>${fmt(cfg.maxRewardMinor, user.currency as Currency)}</b> in wallet credit`,
      "• Smaller orders get a “better luck next time”",
      `• Up to <b>${cfg.maxSpinsPerDay}</b> spins a day`,
      "",
      mission
        ? "⚠️ <b>You're on a Mission right now</b>, so spins are paused. Finish or let it expire to spin again."
        : "👉 Your spin button appears right after you pay. 🛍",
    ].join("\n"),
    kb,
  };
}

/** 🎯 Missions — the spend challenge (bigger reward, one at a time). */
export async function missionView(user: BotUser): Promise<View> {
  const [cfg, active] = await Promise.all([getSpinConfig(), activeChallenge(user.id)]);
  const kb = new InlineKeyboard();
  if (!cfg.enabled) {
    navRow(kb, cb("prf", "view"));
    return { text: `${header(`🎯 ${bold("Missions")}`)}\n\nNot running right now — check back soon!`, kb };
  }
  if (!active) {
    kb.add(sbtn("🎯 Start a Mission", cb("msn", "go"), "success")).row();
    kb.add(sbtn("🎡 Or spin per purchase", cb("spn", "home"), "primary")).row();
    navRow(kb, cb("prf", "view"));
    return {
      text: [
        header(`🎯 ${bold("Missions")}`),
        "",
        "Take on a <b>spending target</b> and earn a bigger reward when you reach it. 💪",
        "",
        `🎁 Rewards go up to <b>${(cfg.rewardBp / 100).toFixed(1)}%</b> of the target.`,
        `⏳ You get <b>${cfg.expiryDays} days</b> to finish.`,
        "",
        "⚠️ <b>While a Mission is running, per-purchase spins are paused</b> — one reward path at a time.",
        "",
        "<i>Only spending after you start counts.</i>",
      ].join("\n"),
      kb,
    };
  }
  const bar = "█".repeat(Math.round(active.pct / 10)).padEnd(10, "░");
  if (active.claimable) kb.add(sbtn(`🎉 Claim ${fmt(active.rewardMinor, active.currency)}`, cb("msn", "claim", active.id), "success")).row();
  else kb.add(sbtn("🛍 Shop now", cb("shp", "home", 1), "primary")).row();
  navRow(kb, cb("prf", "view"));
  return {
    text: [
      header(`🎯 ${bold("Your Mission")}`),
      "",
      `🎯 Spend <b>${fmt(active.targetMinor, active.currency)}</b>`,
      `🎁 Earn <b>${fmt(active.rewardMinor, active.currency)}</b> wallet credit`,
      "",
      `${bar} <b>${active.pct}%</b>`,
      `✅ Done: <b>${fmt(active.progressMinor, active.currency)}</b>`,
      active.claimable ? "\n🎉 <b>Complete — claim your reward!</b>" : `⏳ <b>${fmt(active.remainingMinor, active.currency)}</b> to go`,
      `📅 Expires ${active.expiresAt.toISOString().slice(0, 10)}`,
      "",
      "<i>Spins are paused while a Mission is active.</i>",
    ].join("\n"),
    kb,
  };
}


/** 🔔 My watchlist — what they asked to be told about. */
export async function watchlistView(user: BotUser): Promise<View> {
  const rows = await listWatches(user.id);
  const kb = new InlineKeyboard();
  for (const w of rows) {
    kb.text(`${w.type === "RESTOCK" ? "🔔" : "📉"} ${w.name.slice(0, 22)}`, cb("shp", "prod", w.productId)).row();
  }
  if (rows.length > 0) kb.add(sbtn("🧹 Clear all", cb("wch", "clear"), "danger")).row();
  navRow(kb, cb("prf", "view"));
  return {
    text: rows.length
      ? [
          header(`🔔 ${bold("My Watchlist")}`),
          "",
          "We'll message you the moment any of these happen:",
          "",
          ...rows.map((w) =>
            w.type === "RESTOCK"
              ? `🔔 <b>${escapeHtml(w.name)}</b> — when back in stock`
              : `📉 <b>${escapeHtml(w.name)}</b> — if it drops below ${w.basePriceMinor !== null ? fmt(w.basePriceMinor, (w.currency ?? user.currency) as Currency) : "the price you saw"}`,
          ),
          "",
          "<i>Tap any item to open it. You're told once, then it comes off the list.</i>",
        ].join("\n")
      : `${header(`🔔 ${bold("My Watchlist")}`)}\n\nNothing yet.\n\nOn any product, tap <b>📉 Tell me if the price drops</b> — or <b>🔔 Notify me</b> when something is sold out — and it appears here.`,
    kb,
  };
}

/** 🎯 Today's deals — sale, restocked and new in one place. */
export async function dealsView(user: BotUser): Promise<View> {
  const items = await todaysDeals(user.currency as Currency, 12);
  const kb = new InlineKeyboard();
  for (const d of items) {
    const tag = d.tag === "SALE" ? "🔥" : d.tag === "NEW" ? "🆕" : "🔔";
    const price = d.fromPriceMinor === null ? "—" : fmt(d.fromPriceMinor, user.currency);
    kb.add(sbtn(`${tag} ${d.iconEmoji ? `${d.iconEmoji} ` : ""}${d.name.slice(0, 22)} — ${price}`, cb("shp", "prod", d.id), d.tag === "SALE" ? "danger" : "success")).row();
  }
  kb.add(sbtn("🛍 All products", cb("shp", "home", 1), "primary")).row();
  navRow(kb, cb("mnu", "home"));
  return {
    text: items.length
      ? [
          header(`🎯 ${bold("Today's Deals")}`),
          "",
          "🔥 on sale   ·   🔔 just restocked   ·   🆕 new arrival",
          "",
          ...items.map((d) => {
            const now = d.fromPriceMinor === null ? "—" : fmt(d.fromPriceMinor, user.currency);
            return d.wasMinor !== null
              ? `🔥 <b>${escapeHtml(d.name)}</b> — <s>${fmt(d.wasMinor, user.currency)}</s> <b>${now}</b>`
              : `${d.tag === "NEW" ? "🆕" : "🔔"} <b>${escapeHtml(d.name)}</b> — ${now}`;
          }),
          "",
          "<i>Deals move fast — grab them while they're here.</i>",
        ].join("\n")
      : `${header(`🎯 ${bold("Today's Deals")}`)}\n\nNo special deals right now — but the shop is full of good prices. 🛍`,
    kb,
  };
}

/** 🔑 Search my keys. */
export async function myKeysSearchView(user: BotUser, query: string): Promise<View> {
  const rows = await searchMyKeys(user.id, query, 12);
  const kb = new InlineKeyboard();
  for (const r of rows) kb.text(`🔑 ${r.productName.slice(0, 24)} · ${r.orderNumber}`, cb("lic", "view", r.orderItemId)).row();
  kb.add(sbtn("🔍 Search again", cb("lic", "find"), "primary")).row();
  navRow(kb, cb("prf", "view"));
  return {
    text: rows.length
      ? [header(`🔑 ${bold("Your keys")}`), "", `Found <b>${rows.length}</b> matching “${escapeHtml(query)}”.`, "", "Tap one to see or re-copy it."].join("\n")
      : `${header(`🔑 ${bold("Your keys")}`)}\n\nNothing matched “${escapeHtml(query)}”.\n\nTry part of the product name, e.g. <code>netflix</code>.`,
    kb,
  };
}
