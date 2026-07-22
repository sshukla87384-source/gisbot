import { loadConfig } from "@gis/config";
import {
  addLicenseKeys,
  adminCancelOrder,
  enqueueTelegramMessage,
  BOT_ADMIN_MEMBERS_KEY,
  adminDeleteProduct,
  adjustUserWallet,
  resolveUserByTelegramId,
  setUserPrice,
  removeUserPrice,
  listProductUserPrices,
  setProductPinRank,
  setProductPublicPrice,
  setProductFulfillmentMode,
  listPendingManualItems,
  manualFulfillItem,
  type PriceChannel,
  createApiKey,
  listApiKeys,
  setApiKeyScopes,
  getButtonConfig,
  setButton,
  BUTTON_LABEL_KEYS,
  type ButtonLabelKey,
  revokeApiKey,
  announceProduct,
  announceFlashSale,
  clearFlashSale,
  confirmManualPayment,
  createCategoryQuick,
  createProductFull,
  getAdminOrder,
  getAdminStats,
  rejectManualOrder,
  getRedis,
  listPendingPaymentOrders,
  listProductsBrief,
  listRecentOrders,
  listCategoriesBrief,
  listPostTargets,
  listVariantsBrief,
  postProductToGroups,
  removePostTarget,
  sendBroadcast,
  setFlashSale,
  setProductImage,
  setProductName,
  setProductDescription,
  setProductStatus,
  testBinanceApi,
  verifyBinanceByTxnId,
  WIZARD_TYPES,
} from "@gis/core";
import { cb } from "@gis/shared";
import { InlineKeyboard } from "grammy";
import type { Ctx } from "./ctx.js";
import { escapeHtml, fmt } from "./ui.js";
import { sbtn } from "./keyboard.js";

const ATTEMPT_WINDOW_SEC = 15 * 60;
const MAX_ATTEMPTS = 5;

const sessionKey = (tgId: number | bigint | string): string => `botadmin:${tgId}`;

export async function isBotAdmin(tgId: number | bigint | undefined): Promise<boolean> {
  if (tgId === undefined) return false;
  const v = await getRedis().get(sessionKey(tgId));
  return v === "1";
}

function idAllowed(tgId: number): boolean {
  const raw = loadConfig().BOT_ADMIN_IDS;
  if (!raw) return true; // no allowlist configured → passcode alone gates
  return raw.split(",").map((s) => s.trim()).filter(Boolean).includes(String(tgId));
}

/** /admin — start login or show the panel. */
export async function adminCommand(ctx: Ctx): Promise<void> {
  const tgId = ctx.from?.id;
  if (tgId === undefined) return;
  const cfg = loadConfig();
  if (!cfg.BOT_ADMIN_PASSCODE) {
    await ctx.reply("🔒 Admin panel is not enabled. Set BOT_ADMIN_PASSCODE on the server to use it.");
    return;
  }
  if (!idAllowed(tgId)) {
    await ctx.reply("⛔ Your Telegram account is not on the admin allowlist.");
    return;
  }
  if (await isBotAdmin(tgId)) {
    await sendPanel(ctx, false);
    return;
  }
  ctx.session.awaiting = "admin_passcode";
  await ctx.reply("🔑 Enter the admin passcode:");
}

/** Handle the passcode message. Returns true when consumed. */
export async function handleAdminPasscode(ctx: Ctx): Promise<void> {
  const tgId = ctx.from?.id;
  const text = ctx.message?.text ?? "";
  if (tgId === undefined) return;
  const cfg = loadConfig();
  const redis = getRedis();

  // Rate-limit attempts.
  const attemptsKey = `botadmin:try:${tgId}`;
  const attempts = await redis.incr(attemptsKey);
  if (attempts === 1) await redis.expire(attemptsKey, ATTEMPT_WINDOW_SEC);
  if (attempts > MAX_ATTEMPTS) {
    await ctx.reply("⛔ Too many attempts. Try again later.");
    return;
  }

  // Delete the message that contained the passcode (best-effort).
  await ctx.deleteMessage().catch(() => undefined);

  if (cfg.BOT_ADMIN_PASSCODE && text === cfg.BOT_ADMIN_PASSCODE && idAllowed(tgId)) {
    // Notify any admins already logged in that a new sign-in happened.
    const existing = await redis.smembers(BOT_ADMIN_MEMBERS_KEY);
    const who = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name ?? String(tgId));
    for (const m of existing) {
      if (m && m !== String(tgId)) {
        await enqueueTelegramMessage(m, `⚠️ <b>New admin login</b>\n${escapeHtml(who)} (id <code>${tgId}</code>) just signed in to the admin panel.`);
      }
    }
    await redis.set(sessionKey(tgId), "1"); // persistent — stays until logout
    await redis.sadd(BOT_ADMIN_MEMBERS_KEY, String(tgId));
    await redis.del(attemptsKey);
    await ctx.reply("✅ Admin access granted. You’ll stay logged in until you tap 🚪 Logout.\nYou’ll also get order alerts here.");
    await sendPanel(ctx, false);
  } else {
    await ctx.reply("❌ Wrong passcode.");
  }
}

async function guard(ctx: Ctx): Promise<boolean> {
  if (await isBotAdmin(ctx.from?.id)) return true;
  await ctx.answerCallbackQuery({ text: "Session expired — send /admin", show_alert: true }).catch(() => undefined);
  return false;
}

function panelKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("➕ Add product", cb("adm", "addp")).row()
    .text("📊 Dashboard", cb("adm", "stats")).text("🧾 Pending", cb("adm", "orders")).row()
    .text("🗂 Recent orders", cb("adm", "recent")).text("📦 Products", cb("adm", "prods")).row()
    .text("📢 Broadcast", cb("adm", "bc")).text("📣 Groups", cb("adm", "groups")).row()
    .text("💰 Adjust wallet", cb("adm", "walletadj")).row()
    .text("🔤 Rename buttons", cb("adm", "btns")).row()
    .text("🔑 API keys", cb("adm", "apikeys")).text("🧪 Test Binance", cb("adm", "bintest")).row()
    .add(sbtn("🚪 Logout", cb("adm", "logout"), "danger"), sbtn("🚪 Logout all", cb("adm", "logoutall"), "danger")).row();
}

async function show(ctx: Ctx, text: string, kb: InlineKeyboard, edit: boolean): Promise<void> {
  const opts = { parse_mode: "HTML" as const, reply_markup: kb };
  if (edit && ctx.callbackQuery?.message) {
    try { await ctx.editMessageText(text, opts); return; } catch { /* fall through */ }
  }
  await ctx.reply(text, opts);
}

async function sendPanel(ctx: Ctx, edit: boolean): Promise<void> {
  await show(ctx, "🛠 <b>Admin Panel</b>\nManage the store right here.", panelKeyboard(), edit);
}

async function statsView(ctx: Ctx): Promise<void> {
  const s = await getAdminStats();
  const text = [
    "📊 <b>Dashboard</b>",
    "",
    `👥 Users: <b>${s.users}</b>`,
    `📦 Active products: <b>${s.activeProducts}</b>`,
    `🧾 Orders today: <b>${s.ordersToday}</b>`,
    `💰 Paid today: <b>${s.paidToday}</b>`,
    `⏳ Pending payments: <b>${s.pendingPayments}</b>`,
    `📉 Low-stock variants: <b>${s.lowStockVariants}</b>`,
  ].join("\n");
  await show(ctx, text, new InlineKeyboard().text("↻ Refresh", cb("adm", "stats")).text("◀️ Back", cb("adm", "home")), true);
}

function orderRowsKb(orders: Awaited<ReturnType<typeof listPendingPaymentOrders>>): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const o of orders) {
    kb.text(`${o.orderNumber} · ${fmt(o.totalMinor, o.currency)} · ${o.status}`, cb("adm", "ord", o.id)).row();
  }
  kb.text("◀️ Back", cb("adm", "home"));
  return kb;
}

async function ordersView(ctx: Ctx, pending: boolean): Promise<void> {
  const orders = pending ? await listPendingPaymentOrders(10) : await listRecentOrders(10);
  const title = pending ? "⏳ <b>Pending payments</b>" : "🗂 <b>Recent orders</b>";
  const body = orders.length === 0 ? `${title}\n\nNothing here.` : title;
  await show(ctx, body, orderRowsKb(orders), true);
}

async function orderView(ctx: Ctx, orderId: string): Promise<void> {
  const o = await getAdminOrder(orderId);
  if (!o) { await show(ctx, "Order not found.", new InlineKeyboard().text("◀️ Back", cb("adm", "orders")), true); return; }
  const lines = [
    `🧾 <b>${o.orderNumber}</b> — ${o.status}`,
    `Buyer: ${escapeHtml(o.userLabel)}`,
    `Total: <b>${fmt(o.totalMinor, o.currency)}</b>${o.binanceAmount ? ` (= ${o.binanceAmount} USDT)` : ""}`,
    "",
    ...o.items.map((i) => `• ${escapeHtml(i.name)} · ${escapeHtml(i.variant)} ×${i.qty}`),
  ];
  const kb = new InlineKeyboard();
  if (o.status === "PENDING_PAYMENT") {
    kb.text("✅ Confirm payment", cb("adm", "confirm", o.id)).row();
    kb.text("🔎 Verify by Order ID", cb("adm", "txn", o.id)).row();
    kb.text("✖️ Cancel order", cb("adm", "cancel", o.id)).row();
  }
  kb.text("◀️ Back", cb("adm", "orders"));
  await show(ctx, lines.join("\n"), kb, true);
}

async function productsView(ctx: Ctx): Promise<void> {
  const prods = await listProductsBrief(20);
  const kb = new InlineKeyboard();
  for (const p of prods) {
    const tag = p.status === "ACTIVE" ? "🟢" : "⚪️";
    const sale = p.onSalePct ? " 🔥" : "";
    kb.text(`${tag} ${p.iconEmoji ? `${p.iconEmoji} ` : ""}${p.name}${sale}`, cb("adm", "prod", p.id)).row();
  }
  kb.text("◀️ Back", cb("adm", "home"));
  await show(ctx, prods.length ? "📦 <b>Products</b>" : "No products yet.", kb, true);
}

async function productView(ctx: Ctx, productId: string): Promise<void> {
  const prods = await listProductsBrief(200);
  const p = prods.find((x) => x.id === productId);
  if (!p) { await productsView(ctx); return; }
  const kb = new InlineKeyboard();
  if (p.status === "ACTIVE") kb.text("⏸ Pause", cb("adm", "ppause", p.id));
  else kb.text("🟢 Activate", cb("adm", "pactive", p.id));
  kb.text("📣 Announce", cb("adm", "announce", p.id)).row();
  if (p.onSalePct) kb.text("🔥 End sale", cb("adm", "saleoff", p.id));
  else kb.text("🔥 Start flash sale", cb("adm", "sale", p.id));
  kb.row().text("✏️ Name", cb("adm", "pname", p.id)).text("✏️ Description", cb("adm", "pdesc", p.id)).row();
  kb.text("🖼 Set image", cb("adm", "pimg", p.id)).text("🔑 Add stock keys", cb("adm", "keys", p.id)).row();
  kb.text(`⚙️ Delivery: ${p.fulfillmentMode === "MANUAL" ? "MANUAL → make AUTOMATIC" : "AUTOMATIC → make MANUAL"}`, cb("adm", "pmode", p.id)).row();
  kb.text("📣 Post to groups", cb("adm", "gpost", p.id)).row();
  kb.text("💵 Edit price", cb("adm", "pprice", p.id)).text("💲 Custom pricing", cb("adm", "cprice", p.id)).row();
  kb.text(`📌 Pin / position${p.pinRank ? ` (#${p.pinRank})` : ""}`, cb("adm", "cpin", p.id)).row();
  kb.text("🗑 Delete product", cb("adm", "pdel", p.id)).row();
  kb.text("◀️ Back", cb("adm", "prods"));
  const text = `📦 <b>${p.iconEmoji ? `${p.iconEmoji} ` : ""}${escapeHtml(p.name)}</b>\nStatus: ${p.status}${p.onSalePct ? ` · 🔥 ${Math.round(p.onSalePct / 100)}% off` : ""}`;
  await show(ctx, text, kb, true);
}

async function variantsForKeys(ctx: Ctx, productId: string): Promise<void> {
  const vs = await listVariantsBrief(productId);
  const kb = new InlineKeyboard();
  for (const v of vs) kb.text(`${v.name} (${v.sku})`, cb("adm", "kv", v.id)).row();
  kb.text("◀️ Back", cb("adm", "prod", productId));
  await show(ctx, vs.length ? "🔑 Pick a variant to add keys to:" : "No variants on this product.", kb, true);
}

const cancelKb = (): InlineKeyboard => new InlineKeyboard().text("✖️ Cancel", cb("adm", "home"));

async function askStep(ctx: Ctx, text: string): Promise<void> {
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: cancelKb() });
}

function rupeesToMinor(raw: string): number | null {
  const n = Number.parseFloat(raw.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

async function categoryPickKb(): Promise<InlineKeyboard> {
  const cats = await listCategoriesBrief();
  const kb = new InlineKeyboard();
  for (const c of cats) kb.text(`${c.emoji ? `${c.emoji} ` : ""}${c.name}`, cb("adm", "pcat", c.id)).row();
  kb.text("➕ New category", cb("adm", "pnewcat")).row();
  kb.text("⏭ Skip (no category)", cb("adm", "pskip")).row();
  kb.text("✖️ Cancel", cb("adm", "home"));
  return kb;
}

async function wizardTypeStep(ctx: Ctx): Promise<void> {
  const kb = new InlineKeyboard()
    .text("🔑 License Key", cb("adm", "ptype", "key")).row()
    .text("👤 Account", cb("adm", "ptype", "acct")).row()
    .text("📦 Manual service", cb("adm", "ptype", "other")).row()
    .text("✖️ Cancel", cb("adm", "home"));
  await ctx.reply("<b>New product · Step 3/6</b>\nWhat type is it?", { parse_mode: "HTML", reply_markup: kb });
}

async function apiKeysView(ctx: Ctx): Promise<void> {
  const keys = await listApiKeys();
  const kb = new InlineKeyboard().text("➕ New API key", cb("adm", "apinew")).row();
  const lines = ["🔑 <b>Developer API keys</b>", ""];
  for (const k of keys.slice(0, 15)) {
    const state = k.revokedAt ? "🚫 revoked" : "🟢 active";
    lines.push(`• <b>${k.name}</b> — <code>${k.prefix}…</code> · ${state} · ${k.callCount} calls\n  scopes: ${k.scopes.join(", ")}`);
    if (!k.revokedAt) {
      const hasPurchase = k.scopes.includes("orders:write") && k.scopes.includes("wallet:read");
      if (!hasPurchase) kb.text(`⬆️ Enable purchasing — ${k.name.slice(0, 14)}`, cb("adm", "apiup", k.id)).row();
      kb.text(`🗑 Revoke ${k.name.slice(0, 16)}`, cb("adm", "apirevoke", k.id)).row();
    }
  }
  if (keys.length === 0) lines.push("No keys yet. Create one to give partners read-only API access.");
  kb.text("◀️ Back", cb("adm", "home"));
  await show(ctx, lines.join("\n"), kb, true);
}

async function groupsView(ctx: Ctx): Promise<void> {
  const targets = await listPostTargets();
  const kb = new InlineKeyboard();
  const lines = [
    "📣 <b>Groups &amp; Channels</b>",
    "",
    "To add one: add this bot to your group/channel (as admin for channels), then send <code>/registergroup</code> there.",
    "Then open any product → <b>📣 Post to groups</b>.",
    "",
  ];
  if (targets.length === 0) lines.push("No groups registered yet.");
  for (const t of targets.slice(0, 15)) {
    lines.push(`• ${escapeHtml(t.title ?? t.chatId)}${t.active ? "" : " (inactive)"}`);
    kb.text(`🗑 Remove ${(t.title ?? t.chatId).slice(0, 18)}`, cb("adm", "grpdel", t.id)).row();
  }
  kb.text("◀️ Back", cb("adm", "home"));
  await show(ctx, lines.join("\n"), kb, true);
}

/** Central callback dispatcher for the admin panel (ns === "adm"). */

const chLabel = (c: PriceChannel): string => c === "DIRECT" ? "🛒 Direct only" : c === "API" ? "🔌 API only" : "🛒🔌 Both";

async function manualDeliverView(ctx: Ctx, orderId: string): Promise<void> {
  const { orderNumber, items } = await listPendingManualItems(orderId);
  const kb = new InlineKeyboard();
  for (const it of items) {
    const vn = it.variantName.trim().toLowerCase() === "standard" ? "" : ` · ${it.variantName}`;
    kb.text(`📤 Deliver — ${it.productName}${vn}`, cb("adm", "dlv", it.id)).row();
  }
  kb.text("◀️ Back", cb("adm", "orders"));
  const text = items.length
    ? `📦 <b>Manual delivery</b> — Order <b>${escapeHtml(orderNumber)}</b>\n\nTap an item to send its key/details to the customer.`
    : `✅ Order <b>${escapeHtml(orderNumber)}</b> — nothing left to deliver.`;
  await show(ctx, text, kb, true);
}

async function customPriceView(ctx: Ctx, productId: string): Promise<void> {
  const prods = await listProductsBrief(200);
  const p = prods.find((x) => x.id === productId);
  const rows = await listProductUserPrices(productId);
  const kb = new InlineKeyboard();
  kb.text("➕ Add custom price", cb("adm", "cpadd", productId)).row();
  for (const r of rows) {
    kb.text(`✖️ ${r.label} · ${(r.amountMinor / 100).toFixed(2)} · ${chLabel(r.channel)}`, cb("adm", "cprm", `${r.userId}~${r.channel}~${productId}`)).row();
  }
  kb.text("◀️ Back", cb("adm", "prod", productId));
  const lines = [
    `💲 <b>Custom pricing</b> — ${p ? escapeHtml(p.name) : "product"}`,
    "",
    rows.length ? "Set special prices for specific customers (direct, API, or both). Tap a row to remove it." : "No custom prices yet. Tap ➕ to add one.",
  ];
  await show(ctx, lines.join("\n"), kb, true);
}

async function customPriceChannelPrompt(ctx: Ctx): Promise<void> {
  const kb = new InlineKeyboard()
    .text("🛒 Direct only", cb("adm", "cpset", "DIRECT")).row()
    .text("🔌 API only", cb("adm", "cpset", "API")).row()
    .text("🛒🔌 Both", cb("adm", "cpset", "BOTH")).row()
    .text("✖️ Cancel", cb("adm", "home"));
  await show(ctx, `Where should <b>${escapeHtml(ctx.session.priceUserLabel ?? "this customer")}</b>'s price of <b>${((ctx.session.priceAmountMinor ?? 0) / 100).toFixed(2)}</b> apply?`, kb, false);
}

function hasCustomEmoji(ctx: Ctx): boolean {
  return ((ctx.message?.entities ?? []) as Array<{ type: string }>).some((e) => e.type === "custom_emoji");
}

/** Build HTML from an admin message, preserving premium custom emoji as <tg-emoji> tags. */
function composeBroadcastHtml(ctx: Ctx): string {
  const msg = ctx.message;
  const text = (msg?.text ?? "").slice(0, 3200);
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const ents = ((msg?.entities ?? []) as Array<{ type: string; offset: number; length: number; custom_emoji_id?: string }>)
    .filter((e) => e.type === "custom_emoji" && e.offset + e.length <= text.length)
    .sort((a, b) => a.offset - b.offset);
  if (ents.length === 0) return esc(text);
  let out = ""; let i = 0;
  for (const e of ents) {
    out += esc(text.slice(i, e.offset));
    const emo = text.slice(e.offset, e.offset + e.length);
    out += e.custom_emoji_id ? `<tg-emoji emoji-id="${e.custom_emoji_id}">${esc(emo)}</tg-emoji>` : esc(emo);
    i = e.offset + e.length;
  }
  out += esc(text.slice(i));
  return out;
}

async function broadcastProductPicker(ctx: Ctx): Promise<void> {
  const prods = await listProductsBrief(50);
  const kb = new InlineKeyboard();
  for (const p of prods) kb.text(`${p.iconEmoji ? `${p.iconEmoji} ` : ""}${p.name}`, cb("adm", "bcpick", p.id)).row();
  kb.text("📨 Send without product", cb("adm", "bcsend")).row();
  kb.text("✖️ Cancel", cb("adm", "home"));
  await show(ctx, "📦 Pick a product to attach a ⚡ Buy button:", kb, true);
}

async function finishBroadcast(ctx: Ctx): Promise<void> {
  const body = ctx.session.bcBody ?? "";
  if (!body.trim()) { await ctx.reply("Nothing to send — start again from 📢 Broadcast."); return sendPanel(ctx, false); }
  const res = await sendBroadcast({
    title: "",
    body,
    bodyIsHtml: true,
    segment: "all",
    buttonText: ctx.session.bcBtnText,
    buttonUrl: ctx.session.bcBtnUrl,
    createdById: "bot-admin",
  });
  ctx.session.bcBody = ctx.session.bcBtnText = ctx.session.bcBtnUrl = undefined;
  await ctx.reply(`📢 Broadcast queued to ${res.targets} users.${res.targets ? "" : " (no eligible users yet)"}`);
  return sendPanel(ctx, false);
}

const BTN_LABEL_DEFAULTS: Record<string, string> = {
  shop: "🛍 Shop Now", orders: "📦 My Orders", wallet: "💰 Wallet", support: "🎫 Help & Support",
  referral: "👥 Referral", currency: "💱 Currency", language: "🌐 Language", developer: "🧑‍💻 Developer API",
};

async function renameButtonsView(ctx: Ctx): Promise<void> {
  const cfg = await getButtonConfig();
  const kb = new InlineKeyboard();
  for (const k of BUTTON_LABEL_KEYS) {
    const cur = cfg[k]?.label ?? BTN_LABEL_DEFAULTS[k];
    const ic = cfg[k]?.icon ? " 🎨" : "";
    kb.text(`✏️ ${cur}${ic}`, cb("adm", "btnedit", k)).row();
  }
  kb.text("◀️ Back", cb("adm", "home"));
  await show(ctx, "🔤 <b>Rename menu buttons</b>\nTap a button, then send the new label. Include a <b>premium emoji</b> and it becomes the button's icon 🎨. Send <code>reset</code> to restore the default.", kb, true);
}

export async function handleAdminCallback(ctx: Ctx, action: string, args: string[]): Promise<void> {
  if (action === "logout") {
    const tgId = ctx.from?.id;
    if (tgId !== undefined) {
      await getRedis().del(sessionKey(tgId));
      await getRedis().srem(BOT_ADMIN_MEMBERS_KEY, String(tgId));
    }
    await ctx.answerCallbackQuery({ text: "Logged out" }).catch(() => undefined);
    await show(ctx, "🚪 Logged out of the admin panel.", new InlineKeyboard(), true);
    return;
  }
  if (!(await guard(ctx))) return;
  await ctx.answerCallbackQuery().catch(() => undefined);
  const id = args[0] ?? "";

  switch (action) {
    case "home": return sendPanel(ctx, true);
    case "logoutall": {
      const redis = getRedis();
      const members = await redis.smembers(BOT_ADMIN_MEMBERS_KEY);
      for (const m of members) await redis.del(sessionKey(m));
      await redis.del(BOT_ADMIN_MEMBERS_KEY);
      await show(ctx, "🚪 Logged out of the admin panel on <b>all</b> devices.", new InlineKeyboard(), true);
      return;
    }
    case "stats": return statsView(ctx);
    case "orders": return ordersView(ctx, true);
    case "recent": return ordersView(ctx, false);
    case "ord": return orderView(ctx, id);
    case "prods": return productsView(ctx);
    case "prod": return productView(ctx, id);
    case "pprice":
      ctx.session.admProductId = id;
      ctx.session.pubUsdMinor = undefined;
      ctx.session.awaiting = "admin_pubprice_usd";
      await askStep(ctx, "💵 New <b>USD</b> price for everyone (applies to all variants), e.g. <code>9.99</code>. Send <code>0</code> to skip USD.");
      return;
    case "cprice": return customPriceView(ctx, id);
    case "pmode": {
      const prods = await listProductsBrief(200);
      const cur = prods.find((x) => x.id === id)?.fulfillmentMode ?? "AUTOMATIC";
      const next = cur === "MANUAL" ? "AUTOMATIC" : "MANUAL";
      await setProductFulfillmentMode(id, next);
      await ctx.reply(`⚙️ Delivery mode set to <b>${next}</b>.`, { parse_mode: "HTML" });
      return productView(ctx, id);
    }
    case "deliver": return manualDeliverView(ctx, id);
    case "dlv":
      ctx.session.admManualItemId = id;
      ctx.session.awaiting = "admin_manual_key";
      await askStep(ctx, "🔑 Send the key / login details to deliver to the customer now:");
      return;
    case "cpin":
      ctx.session.admProductId = id;
      ctx.session.awaiting = "admin_pin";
      await askStep(ctx, "📌 Send a priority number — <b>higher shows higher up</b> in the shop (e.g. <code>100</code> pins to the top). Send <code>0</code> to unpin.");
      return;
    case "cpadd":
      ctx.session.priceProductId = id;
      ctx.session.priceUserId = undefined;
      ctx.session.priceAmountMinor = undefined;
      ctx.session.awaiting = "admin_price_user";
      await askStep(ctx, "👤 Which customer? Send their @username or Telegram numeric ID (they must have used the bot).");
      return;
    case "cpset": {
      const channel = (id === "DIRECT" || id === "API" || id === "BOTH" ? id : "BOTH") as PriceChannel;
      const pid = ctx.session.priceProductId ?? "";
      const uid = ctx.session.priceUserId ?? "";
      const amt = ctx.session.priceAmountMinor ?? 0;
      if (!pid || !uid || amt <= 0) { await sendPanel(ctx, true); return; }
      await setUserPrice(uid, pid, amt, channel);
      const label = ctx.session.priceUserLabel ?? "customer";
      ctx.session.priceProductId = ctx.session.priceUserId = ctx.session.priceUserLabel = undefined;
      ctx.session.priceAmountMinor = undefined;
      await ctx.reply(`✅ Set ${escapeHtml(label)}'s price to <b>${(amt / 100).toFixed(2)}</b> (${chLabel(channel)}).`, { parse_mode: "HTML" });
      await customPriceView(ctx, pid);
      return;
    }
    case "cprm": {
      const [uid, channel, pid] = id.split("~");
      if (uid && channel && pid) { await removeUserPrice(uid, pid, channel as PriceChannel); await customPriceView(ctx, pid); }
      return;
    }

    case "confirm": {
      try {
        const r = await confirmManualPayment(id);
        await ctx.reply(`✅ Payment confirmed — delivered ${r.delivered} item(s).`);
      } catch {
        await ctx.reply("⚠️ Could not confirm (already processed or no stock).");
      }
      return orderView(ctx, id);
    }
    case "approve": {
      try {
        const r = await confirmManualPayment(id);
        await ctx.editMessageText(`✅ <b>Approved & delivered</b> ${r.delivered} item(s).`, { parse_mode: "HTML" }).catch(() => undefined);
      } catch {
        await ctx.reply("⚠️ Could not approve (already processed or no stock).");
      }
      return;
    }
    case "reject": {
      const r = await rejectManualOrder(id);
      await ctx.editMessageText(r.ok ? `❌ <b>Rejected</b> — ${r.orderNumber}. Buyer notified.` : "Order not found or already handled.", { parse_mode: "HTML" }).catch(() => undefined);
      return;
    }
    case "cancel": {
      await adminCancelOrder(id);
      await ctx.reply("✖️ Order cancelled.");
      return ordersView(ctx, true);
    }
    case "txn": {
      ctx.session.awaiting = "admin_txnid";
      ctx.session.admOrderId = id;
      await ctx.reply("🔎 Send the Binance <b>Order ID</b> to verify this order:", { parse_mode: "HTML" });
      return;
    }
    case "pactive": {
      await setProductStatus(id, "ACTIVE");
      const ann = await announceProduct(id, { createdById: "bot-admin", force: true });
      await ctx.reply(`🟢 Activated.${ann.announced ? ` 📣 Notified ${ann.targets ?? 0} users with a ⚡ Buy Now button.` : ""}`);
      return productView(ctx, id);
    }
    case "ppause": { await setProductStatus(id, "PAUSED"); await ctx.reply("⏸ Paused."); return productView(ctx, id); }
    case "announce": {
      const r = await announceProduct(id, { createdById: "bot-admin", force: true });
      await ctx.reply(r.announced ? `📣 Announced to ${r.targets ?? 0} users.` : "⚠️ Product must be ACTIVE to announce.");
      return productView(ctx, id);
    }
    case "sale": {
      ctx.session.awaiting = "admin_flashsale";
      ctx.session.admProductId = id;
      await ctx.reply("🔥 Send: <b>&lt;percent&gt; &lt;hours&gt;</b>  (e.g. <code>20 48</code> = 20% off for 48 h). Send <code>0</code> for hours to run until you stop it.", { parse_mode: "HTML" });
      return;
    }
    case "saleoff": { await clearFlashSale(id); await ctx.reply("🔥 Sale ended."); return productView(ctx, id); }
    case "pdel": {
      const kb = new InlineKeyboard()
        .add(sbtn("🗑 Yes, delete", cb("adm", "pdely", id), "danger")).row()
        .text("◀️ No, keep it", cb("adm", "prod", id));
      await show(ctx, "⚠️ Delete this product? It will be removed from the shop.", kb, true);
      return;
    }
    case "pdely": {
      await adminDeleteProduct(id);
      await ctx.reply("🗑 Product deleted.");
      return productsView(ctx);
    }
    case "pimg": {
      ctx.session.admProductId = id;
      ctx.session.awaiting = "admin_p_image";
      await askStep(ctx, "🖼 <b>Set product image</b>\nSend a <b>photo</b> now, or paste an <b>image URL</b>:");
      return;
    }
    case "pname": {
      ctx.session.admProductId = id;
      ctx.session.awaiting = "admin_p_editname";
      await askStep(ctx, "✏️ Send the new <b>product name</b>:");
      return;
    }
    case "pdesc": {
      ctx.session.admProductId = id;
      ctx.session.awaiting = "admin_p_editdesc";
      await askStep(ctx, "✏️ Send the new <b>description</b> (one feature per line looks best):");
      return;
    }
    case "keys": return variantsForKeys(ctx, id);
    case "kv": {
      ctx.session.awaiting = "admin_addkeys";
      ctx.session.admVariantId = id;
      await ctx.reply("🔑 Paste the license keys, <b>one per line</b>. They'll be encrypted and added as stock.", { parse_mode: "HTML" });
      return;
    }
    case "addp": {
      ctx.session.admDraft = {};
      ctx.session.awaiting = "admin_p_name";
      await askStep(ctx, "🆕 <b>New product · Step 1/6</b>\nSend the product <b>name</b>:");
      return;
    }
    case "ptype": {
      const key = args[0] ?? "key";
      ctx.session.admDraft = { ...(ctx.session.admDraft ?? {}), type: key };
      await ctx.reply("<b>New product · Step 4/6</b>\nChoose a <b>category</b>:", {
        parse_mode: "HTML",
        reply_markup: await categoryPickKb(),
      });
      return;
    }
    case "pcat": {
      ctx.session.admDraft = { ...(ctx.session.admDraft ?? {}), categoryId: id };
      ctx.session.awaiting = "admin_p_priceinr";
      await askStep(ctx, "<b>New product · Step 5/6</b>\nSend the <b>price in INR</b> (₹), e.g. <code>499</code>:");
      return;
    }
    case "pskip": {
      ctx.session.admDraft = { ...(ctx.session.admDraft ?? {}), categoryId: undefined };
      ctx.session.awaiting = "admin_p_priceinr";
      await askStep(ctx, "<b>New product · Step 5/6</b>\n(No category — that's fine.)\nSend the <b>price in INR</b> (₹), e.g. <code>499</code>:");
      return;
    }
    case "pnewcat": {
      ctx.session.awaiting = "admin_newcat";
      await askStep(ctx, "Send the <b>new category name</b> (e.g. <code>Streaming</code>):");
      return;
    }
    case "actann": {
      await setProductStatus(id, "ACTIVE");
      const r = await announceProduct(id, { createdById: "bot-admin", force: true });
      await ctx.reply(`🟢 Live!${r.announced ? ` 📣 Announced to ${r.targets ?? 0} users.` : ""}`);
      return productView(ctx, id);
    }
    case "walletadj": {
      ctx.session.awaiting = "admin_wallet_adj";
      await askStep(ctx, "💰 <b>Adjust a wallet</b>\nSend: <code>&lt;telegram id or @username&gt; &lt;amount&gt;</code>\nUse a negative amount to deduct.\nExample: <code>123456789 500</code> or <code>@john -200</code>");
      return;
    }
    case "groups": return groupsView(ctx);
    case "grpdel": { await removePostTarget(id); await ctx.reply("🗑 Removed."); return groupsView(ctx); }
    case "gpost": {
      const n = await postProductToGroups(id);
      await ctx.reply(n > 0 ? `📣 Posted to ${n} group(s)/channel(s).` : "No groups registered yet. Open 📣 Groups to add one.");
      return productView(ctx, id);
    }
    case "bintest": {
      await ctx.reply("🧪 Testing Binance API…");
      const r = await testBinanceApi();
      await ctx.reply(r.ok ? `✅ ${r.detail}` : `❌ Binance API failed:\n<code>${escapeHtml(r.detail)}</code>\n\nCommon fixes: enable READ on the key, remove IP restriction (or allow the VPS IP), and make sure the server clock is correct.`, { parse_mode: "HTML" });
      return;
    }
    case "apikeys": return apiKeysView(ctx);
    case "apiup":
      await setApiKeyScopes(id, ["catalog:read", "orders:read", "orders:write", "wallet:read"]);
      await ctx.reply("⬆️ Purchasing + wallet access enabled on that key. It works immediately — no need to regenerate.");
      return apiKeysView(ctx);
    case "apinew": {
      ctx.session.awaiting = "admin_api_name";
      await askStep(ctx, "🔑 <b>New API key</b>\nSend a <b>name</b> for it (e.g. <code>Acme Integration</code>):");
      return;
    }
    case "apiscope": {
      const name = ctx.session.admApiName ?? "API key";
      ctx.session.admApiName = undefined;
      const preset = args[0] ?? "cat";
      const scopes =
        preset === "all" ? ["catalog:read", "orders:read", "analytics:read"]
        : preset === "catord" ? ["catalog:read", "orders:read"]
        : ["catalog:read"];
      const created = await createApiKey({ name, scopes });
      await ctx.reply(
        [
          "✅ <b>API key created</b> — copy it now, it won't be shown again:",
          "",
          `<code>${created.apiKey}</code>`,
          "",
          `Scopes: ${scopes.join(", ")}`,
          "Send it as the <code>X-API-Key</code> header.",
        ].join("\n"),
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🔑 API keys", cb("adm", "apikeys")).text("🏠 Panel", cb("adm", "home")) },
      );
      return;
    }
    case "apirevoke": {
      await revokeApiKey(id);
      await ctx.reply("🔑 Key revoked.");
      return apiKeysView(ctx);
    }
    case "bc": {
      ctx.session.awaiting = "admin_broadcast";
      ctx.session.bcBody = ctx.session.bcBtnText = ctx.session.bcBtnUrl = undefined;
      await ctx.reply("📢 Send the message to broadcast to <b>all</b> users.\nYou can include <b>premium custom emoji</b> — they're sent exactly as you type them. 🎨", { parse_mode: "HTML" });
      return;
    }
    case "bcprod": return broadcastProductPicker(ctx);
    case "bcpick": {
      const prods = await listProductsBrief(200);
      const p = prods.find((x) => x.id === id);
      const uname = loadConfig().BOT_USERNAME;
      if (p && uname) { ctx.session.bcBtnText = "⚡ Buy Now"; ctx.session.bcBtnUrl = `https://t.me/${uname}?start=p_${p.slug}`; }
      return finishBroadcast(ctx);
    }
    case "bcmenu": {
      const uname = loadConfig().BOT_USERNAME;
      if (uname) { ctx.session.bcBtnText = "🏠 Open Store"; ctx.session.bcBtnUrl = `https://t.me/${uname}?start=menu`; }
      return finishBroadcast(ctx);
    }
    case "bcsend": return finishBroadcast(ctx);
    case "btns": return renameButtonsView(ctx);
    case "btnedit":
      ctx.session.btnKey = id;
      ctx.session.awaiting = "admin_btn_label";
      await askStep(ctx, `🔤 Send the new label for this button (current: <b>${escapeHtml((await getButtonConfig())[id as ButtonLabelKey]?.label ?? BTN_LABEL_DEFAULTS[id] ?? id)}</b>). Include a premium emoji to set it as the icon 🎨, or send <code>reset</code> for default.`);
      return;
    default:
      return sendPanel(ctx, true);
  }
}

/** Handle admin free-text states. Returns true if the message was consumed. */
export async function handleAdminText(ctx: Ctx, awaiting: NonNullable<Ctx["session"]["awaiting"]>): Promise<boolean> {
  const text = (ctx.message?.text ?? "").trim();

  if (awaiting === "admin_passcode") { await handleAdminPasscode(ctx); return true; }
  if (!(await isBotAdmin(ctx.from?.id))) { await ctx.reply("Session expired — send /admin"); return true; }

  if (awaiting === "admin_txnid") {
    const orderId = ctx.session.admOrderId ?? "";
    ctx.session.admOrderId = undefined;
    const r = await verifyBinanceByTxnId(orderId, text);
    if (r.ok) await ctx.reply(`✅ Verified & delivered — ${r.orderNumber}.`);
    else {
      const msg: Record<string, string> = {
        NOT_FOUND: "❌ That transaction ID wasn't found in your Binance Pay history.",
        AMOUNT_MISMATCH: "❌ The amount for that transaction doesn't match this order.",
        ALREADY_USED: "❌ That transaction was already used for another order.",
        NO_API: "⚠️ Binance API key not set — can't auto-verify. Confirm manually if you've checked it.",
        ORDER_NOT_PENDING: "❌ This order is no longer awaiting payment.",
      };
      await ctx.reply(msg[r.reason] ?? "❌ Could not verify.");
    }
    await sendPanel(ctx, false);
    return true;
  }

  if (awaiting === "admin_flashsale") {
    const productId = ctx.session.admProductId ?? "";
    ctx.session.admProductId = undefined;
    const [pctRaw, hoursRaw] = text.split(/\s+/);
    const pct = Number.parseFloat(pctRaw ?? "");
    const hours = Number.parseFloat(hoursRaw ?? "0");
    if (!Number.isFinite(pct) || pct <= 0) { await ctx.reply("❌ Bad format. Send like: 20 48"); return true; }
    const endsAt = Number.isFinite(hours) && hours > 0 ? new Date(Date.now() + hours * 3_600_000) : null;
    await setFlashSale(productId, pct, endsAt);
    const ann = await announceFlashSale(productId, { createdById: "bot-admin" });
    await ctx.reply(`🔥 Flash sale set: ${pct}% off${endsAt ? ` for ${hours} h` : " (until you end it)"}.${ann.announced ? ` 📣 Notified ${ann.targets ?? 0} users instantly.` : ""}`);
    await sendPanel(ctx, false);
    return true;
  }

  if (awaiting === "admin_addkeys") {
    const variantId = ctx.session.admVariantId ?? "";
    ctx.session.admVariantId = undefined;
    const keys = text.split("\n").map((k) => k.trim()).filter(Boolean);
    if (keys.length === 0) { await ctx.reply("❌ No keys detected."); return true; }
    const r = await addLicenseKeys(variantId, keys);
    await ctx.reply(`🔑 Added ${r.added} key(s)${r.skipped ? `, skipped ${r.skipped} duplicate(s)` : ""}.`);
    await sendPanel(ctx, false);
    return true;
  }

  if (awaiting === "admin_p_name") {
    const name = text.slice(0, 200);
    if (!name) { await askStep(ctx, "Please send a product name."); ctx.session.awaiting = "admin_p_name"; return true; }
    ctx.session.admDraft = { ...(ctx.session.admDraft ?? {}), name };
    ctx.session.awaiting = "admin_p_desc";
    await askStep(ctx, `<b>New product · Step 2/6</b>\nSend a <b>description</b> for “${name}” (or send <code>-</code> to skip):`);
    return true;
  }

  if (awaiting === "admin_p_desc") {
    const desc = text === "-" ? "" : text.slice(0, 4000);
    ctx.session.admDraft = { ...(ctx.session.admDraft ?? {}), description: desc };
    await wizardTypeStep(ctx); // step 3 is button-driven
    return true;
  }

  if (awaiting === "admin_newcat") {
    const cat = await createCategoryQuick(text.slice(0, 120));
    ctx.session.admDraft = { ...(ctx.session.admDraft ?? {}), categoryId: cat.id };
    ctx.session.awaiting = "admin_p_priceinr";
    await askStep(ctx, `✅ Category “${cat.name}” created.\n<b>Step 5/6</b>\nSend the <b>price in INR</b> (₹), e.g. <code>499</code>:`);
    return true;
  }

  if (awaiting === "admin_p_priceinr") {
    const minor = rupeesToMinor(text);
    if (minor === null || minor <= 0) { await askStep(ctx, "Please send a valid price, e.g. 499"); ctx.session.awaiting = "admin_p_priceinr"; return true; }
    ctx.session.admDraft = { ...(ctx.session.admDraft ?? {}), priceInrMinor: minor };
    ctx.session.awaiting = "admin_p_priceusd";
    await askStep(ctx, "<b>New product · Step 6/6</b>\nSend the <b>price in USD</b> ($), e.g. <code>5.99</code> — or send <code>-</code> to skip:");
    return true;
  }

  if (awaiting === "admin_p_priceusd") {
    const d = ctx.session.admDraft ?? {};
    const usdMinor = text === "-" ? undefined : (rupeesToMinor(text) ?? undefined);
    if (!d.name || !d.type || !d.priceInrMinor) {
      ctx.session.admDraft = undefined;
      await ctx.reply("⚠️ Something went wrong with the draft. Please start again from ➕ Add product.");
      await sendPanel(ctx, false);
      return true;
    }
    const { productId } = await createProductFull({
      name: d.name,
      description: d.description,
      typeKey: d.type,
      categoryId: d.categoryId,
      priceInrMinor: d.priceInrMinor,
      priceUsdMinor: usdMinor,
    });
    ctx.session.admDraft = undefined;
    const kb = new InlineKeyboard()
      .text("🟢 Activate & announce", cb("adm", "actann", productId)).row()
      .text("🔑 Add stock keys", cb("adm", "keys", productId)).row()
      .text("✅ Done / view", cb("adm", "prod", productId));
    await ctx.reply(
      `✅ <b>Product created</b> (as draft).\nAdd stock, then activate to put it live & announce it to users.`,
      { parse_mode: "HTML", reply_markup: kb },
    );
    return true;
  }

  if (awaiting === "admin_api_name") {
    ctx.session.admApiName = text.slice(0, 120) || "API key";
    const kb = new InlineKeyboard()
      .text("📚 Catalog (read)", cb("adm", "apiscope", "cat")).row()
      .text("📚 Catalog + 📦 Orders", cb("adm", "apiscope", "catord")).row()
      .text("📚📦📊 Full read", cb("adm", "apiscope", "all")).row()
      .text("✖️ Cancel", cb("adm", "home"));
    await ctx.reply("Choose what this key can access:", { parse_mode: "HTML", reply_markup: kb });
    return true;
  }

  if (awaiting === "admin_p_editname") {
    const pid = ctx.session.admProductId ?? ""; ctx.session.admProductId = undefined;
    if (!text) { await ctx.reply("Please send a name."); return true; }
    await setProductName(pid, text, hasCustomEmoji(ctx) ? composeBroadcastHtml(ctx) : null);
    await ctx.reply("✅ Name updated." + (hasCustomEmoji(ctx) ? " (premium emoji kept 🎨)" : ""));
    await productView(ctx, pid);
    return true;
  }
  if (awaiting === "admin_p_editdesc") {
    const pid = ctx.session.admProductId ?? ""; ctx.session.admProductId = undefined;
    await setProductDescription(pid, text, hasCustomEmoji(ctx) ? composeBroadcastHtml(ctx) : null);
    await ctx.reply("✅ Description updated." + (hasCustomEmoji(ctx) ? " (premium emoji kept 🎨)" : ""));
    await productView(ctx, pid);
    return true;
  }
  if (awaiting === "admin_p_image") {
    const productId = ctx.session.admProductId ?? "";
    ctx.session.admProductId = undefined;
    if (!/^https?:\/\//i.test(text)) { await ctx.reply("Please paste a valid http(s) image URL, or send a photo."); return true; }
    await setProductImage(productId, text.trim());
    await ctx.reply("🖼 Image updated.");
    await sendPanel(ctx, false);
    return true;
  }

  if (awaiting === "admin_btn_label") {
    const key = (ctx.session.btnKey ?? "") as ButtonLabelKey; ctx.session.btnKey = undefined;
    if (!BUTTON_LABEL_KEYS.includes(key)) { await ctx.reply("Unknown button."); return true; }
    if (text.trim().toLowerCase() === "reset") {
      await setButton(key, "", null);
      await ctx.reply("✅ Button reset to default.");
      await renameButtonsView(ctx);
      return true;
    }
    const ents = ((ctx.message?.entities ?? []) as Array<{ type: string; offset: number; length: number; custom_emoji_id?: string }>).filter((e) => e.type === "custom_emoji");
    const icon = ents[0]?.custom_emoji_id ?? null;
    // Strip premium-emoji characters from the label (the icon shows them instead).
    let label = text;
    for (const e of [...ents].sort((a, b) => b.offset - a.offset)) label = label.slice(0, e.offset) + label.slice(e.offset + e.length);
    label = label.trim();
    if (!label) label = BTN_LABEL_DEFAULTS[key] ?? key;
    await setButton(key, label, icon);
    await ctx.reply(`✅ Button set to <b>${escapeHtml(label)}</b>${icon ? " with your premium emoji icon 🎨" : ""}.`, { parse_mode: "HTML" });
    await renameButtonsView(ctx);
    return true;
  }
  if (awaiting === "admin_manual_key") {
    const itemId = ctx.session.admManualItemId ?? ""; ctx.session.admManualItemId = undefined;
    const r = await manualFulfillItem(itemId, text);
    if (!r.ok) {
      const msg = r.reason === "ALREADY_DELIVERED" ? "That item was already delivered." : r.reason === "EMPTY" ? "Please send the key/details (it was empty)." : "Could not deliver — item not found.";
      await ctx.reply(`❌ ${msg}`);
      return true;
    }
    await ctx.reply(`✅ Delivered to the customer with a thank-you + instructions.${r.completed ? `\n🎉 Order <b>${escapeHtml(r.orderNumber ?? "")}</b> is now complete.` : `\n${r.remaining} item(s) still pending on order <b>${escapeHtml(r.orderNumber ?? "")}</b>.`}`, { parse_mode: "HTML" });
    return true;
  }
  if (awaiting === "admin_pubprice_usd") {
    const val = Number.parseFloat(text.trim().replace(/[^0-9.]/g, ""));
    ctx.session.pubUsdMinor = Number.isFinite(val) && val > 0 ? Math.round(val * 100) : 0;
    ctx.session.awaiting = "admin_pubprice_inr";
    await askStep(ctx, "💵 New <b>INR</b> price, e.g. <code>499</code>. Send <code>0</code> to skip INR.");
    return true;
  }
  if (awaiting === "admin_pubprice_inr") {
    const pid = ctx.session.admProductId ?? ""; ctx.session.admProductId = undefined;
    const val = Number.parseFloat(text.trim().replace(/[^0-9.]/g, ""));
    const inrMinor = Number.isFinite(val) && val > 0 ? Math.round(val * 100) : 0;
    const usdMinor = ctx.session.pubUsdMinor ?? 0; ctx.session.pubUsdMinor = undefined;
    if (usdMinor <= 0 && inrMinor <= 0) { await ctx.reply("No price set (both were 0)."); await productView(ctx, pid); return true; }
    await setProductPublicPrice(pid, { usdMinor, inrMinor });
    const parts = [usdMinor > 0 ? `$${(usdMinor / 100).toFixed(2)}` : null, inrMinor > 0 ? `₹${(inrMinor / 100).toFixed(2)}` : null].filter(Boolean).join(" · ");
    await ctx.reply(`✅ Public price updated: <b>${parts}</b> (all variants).`, { parse_mode: "HTML" });
    await productView(ctx, pid);
    return true;
  }
  if (awaiting === "admin_pin") {
    const pid = ctx.session.admProductId ?? ""; ctx.session.admProductId = undefined;
    const rank = Number.parseInt(text.trim().replace(/[^0-9]/g, ""), 10);
    if (!Number.isFinite(rank)) { await askStep(ctx, "Please send a whole number, e.g. 100 (or 0 to unpin)."); ctx.session.awaiting = "admin_pin"; return true; }
    await setProductPinRank(pid, rank);
    await ctx.reply(rank > 0 ? `📌 Pinned with priority <b>${rank}</b> — it now shows nearer the top.` : "📌 Unpinned — back to default order.", { parse_mode: "HTML" });
    await productView(ctx, pid);
    return true;
  }
  if (awaiting === "admin_price_user") {
    const found = await resolveUserByTelegramId(text.trim());
    if (!found) { await askStep(ctx, "❌ No customer found. Send their @username or Telegram numeric ID (they must have used the bot)."); ctx.session.awaiting = "admin_price_user"; return true; }
    ctx.session.priceUserId = found.id;
    ctx.session.priceUserLabel = found.label;
    ctx.session.awaiting = "admin_price_amount";
    await askStep(ctx, `💲 Price for <b>${escapeHtml(found.label)}</b>? Send the amount in the customer's currency, e.g. <code>9.99</code>.`);
    return true;
  }
  if (awaiting === "admin_price_amount") {
    const val = Number.parseFloat(text.trim().replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(val) || val <= 0) { await askStep(ctx, "Please send a valid price, e.g. 9.99"); ctx.session.awaiting = "admin_price_amount"; return true; }
    ctx.session.priceAmountMinor = Math.round(val * 100);
    ctx.session.awaiting = null;
    await customPriceChannelPrompt(ctx);
    return true;
  }

  if (awaiting === "admin_wallet_adj") {
    const parts = text.split(/\s+/);
    const identifier = parts[0] ?? "";
    const amt = Number.parseFloat(parts[1] ?? "");
    if (!identifier || !Number.isFinite(amt) || amt === 0) {
      await ctx.reply("Format: <id or @user> <amount>. Example: 123456789 500");
      return true;
    }
    const res = await adjustUserWallet(identifier, Math.round(amt * 100));
    if (!res.ok) await ctx.reply("❌ User not found. Use their Telegram numeric ID or @username (they must have used the bot).");
    else await ctx.reply(`✅ ${amt >= 0 ? "Credited" : "Debited"} ${res.label}. New balance: <b>${(Number(res.newBalanceMinor) / 100).toFixed(2)} ${res.currency}</b>.`, { parse_mode: "HTML" });
    await sendPanel(ctx, false);
    return true;
  }

  if (awaiting === "admin_broadcast") {
    const html = composeBroadcastHtml(ctx);
    if (!html.trim()) { await ctx.reply("Please send some text for the broadcast."); ctx.session.awaiting = "admin_broadcast"; return true; }
    ctx.session.bcBody = html;
    ctx.session.bcBtnText = undefined; ctx.session.bcBtnUrl = undefined;
    const kb = new InlineKeyboard()
      .text("📦 Attach a product", cb("adm", "bcprod")).row()
      .text("🏠 Attach Menu button", cb("adm", "bcmenu")).row()
      .text("📨 Send now (text only)", cb("adm", "bcsend")).row()
      .text("✖️ Cancel", cb("adm", "home"));
    await ctx.reply("📢 <b>Ready to send.</b> Attach a product or the menu, or send now:", { parse_mode: "HTML", reply_markup: kb });
    return true;
  }

  return false;
}

/** Store a Telegram photo file_id as the product image (from an admin photo upload). */
export async function setProductImageFromFileId(ctx: Ctx, fileId: string): Promise<void> {
  const productId = ctx.session.admProductId ?? "";
  ctx.session.admProductId = undefined;
  ctx.session.awaiting = null;
  if (!productId) { await ctx.reply("No product selected. Open the product and tap 🖼 Set image again."); return; }
  await setProductImage(productId, fileId);
  await ctx.reply("🖼 Image updated from your photo. ✅");
}

/** DM every logged-in admin an approve/reject card for a manual payment. Returns count notified. */
export async function notifyAdminsForApproval(ctx: Ctx, orderId: string, method: string, reference: string): Promise<number> {
  const ids = await getRedis().smembers(BOT_ADMIN_MEMBERS_KEY);
  if (ids.length === 0) return 0;
  const o = await getAdminOrder(orderId);
  const head = o
    ? `🧾 <b>${method} payment to review</b>\nOrder <b>${o.orderNumber}</b> — ${fmt(o.totalMinor, o.currency)}\nBuyer: ${escapeHtml(o.userLabel)}`
    : `🧾 <b>${method} payment to review</b> (order ${orderId})`;
  const text = `${head}\nRef: <code>${escapeHtml(reference)}</code>`;
  const markup = { inline_keyboard: [[
    sbtn("✅ Approve & deliver", cb("adm", "approve", orderId), "success"),
    sbtn("❌ Reject", cb("adm", "reject", orderId), "danger"),
  ]] };
  let sent = 0;
  for (const id of ids) {
    try { await ctx.api.sendMessage(Number(id), text, { parse_mode: "HTML", reply_markup: markup }); sent++; } catch { /* skip */ }
  }
  return sent;
}
