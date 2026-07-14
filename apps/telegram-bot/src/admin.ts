import { loadConfig } from "@gis/config";
import {
  addLicenseKeys,
  adminCancelOrder,
  announceProduct,
  clearFlashSale,
  confirmManualPayment,
  getAdminOrder,
  getAdminStats,
  getRedis,
  listPendingPaymentOrders,
  listProductsBrief,
  listRecentOrders,
  listVariantsBrief,
  sendBroadcast,
  setFlashSale,
  setProductStatus,
  verifyBinanceByTxnId,
} from "@gis/core";
import { cb } from "@gis/shared";
import { InlineKeyboard } from "grammy";
import type { Ctx } from "./ctx.js";
import { escapeHtml, fmt } from "./ui.js";

const SESSION_TTL_SEC = 2 * 60 * 60; // 2 hours
const ATTEMPT_WINDOW_SEC = 15 * 60;
const MAX_ATTEMPTS = 5;

const sessionKey = (tgId: number | bigint): string => `botadmin:${tgId}`;

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
    await redis.set(sessionKey(tgId), "1", "EX", SESSION_TTL_SEC);
    await redis.del(attemptsKey);
    await ctx.reply("✅ Admin access granted (2 h session).");
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
    .text("📊 Dashboard", cb("adm", "stats")).text("🧾 Pending", cb("adm", "orders")).row()
    .text("🗂 Recent orders", cb("adm", "recent")).text("📦 Products", cb("adm", "prods")).row()
    .text("📢 Broadcast", cb("adm", "bc")).text("🚪 Logout", cb("adm", "logout")).row();
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
    kb.text("🔎 Verify by Txn ID", cb("adm", "txn", o.id)).row();
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
  kb.row().text("🔑 Add stock keys", cb("adm", "keys", p.id)).row();
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

/** Central callback dispatcher for the admin panel (ns === "adm"). */
export async function handleAdminCallback(ctx: Ctx, action: string, args: string[]): Promise<void> {
  if (action === "logout") {
    const tgId = ctx.from?.id;
    if (tgId !== undefined) await getRedis().del(sessionKey(tgId));
    await ctx.answerCallbackQuery({ text: "Logged out" }).catch(() => undefined);
    await show(ctx, "🚪 Logged out of the admin panel.", new InlineKeyboard(), true);
    return;
  }
  if (!(await guard(ctx))) return;
  await ctx.answerCallbackQuery().catch(() => undefined);
  const id = args[0] ?? "";

  switch (action) {
    case "home": return sendPanel(ctx, true);
    case "stats": return statsView(ctx);
    case "orders": return ordersView(ctx, true);
    case "recent": return ordersView(ctx, false);
    case "ord": return orderView(ctx, id);
    case "prods": return productsView(ctx);
    case "prod": return productView(ctx, id);

    case "confirm": {
      try {
        const r = await confirmManualPayment(id);
        await ctx.reply(`✅ Payment confirmed — delivered ${r.delivered} item(s).`);
      } catch {
        await ctx.reply("⚠️ Could not confirm (already processed or no stock).");
      }
      return orderView(ctx, id);
    }
    case "cancel": {
      await adminCancelOrder(id);
      await ctx.reply("✖️ Order cancelled.");
      return ordersView(ctx, true);
    }
    case "txn": {
      ctx.session.awaiting = "admin_txnid";
      ctx.session.admOrderId = id;
      await ctx.reply("🔎 Send the Binance <b>transaction ID</b> to verify this order:", { parse_mode: "HTML" });
      return;
    }
    case "pactive": { await setProductStatus(id, "ACTIVE"); await ctx.reply("🟢 Activated. It will be announced to users."); return productView(ctx, id); }
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
    case "keys": return variantsForKeys(ctx, id);
    case "kv": {
      ctx.session.awaiting = "admin_addkeys";
      ctx.session.admVariantId = id;
      await ctx.reply("🔑 Paste the license keys, <b>one per line</b>. They'll be encrypted and added as stock.", { parse_mode: "HTML" });
      return;
    }
    case "bc": {
      ctx.session.awaiting = "admin_broadcast";
      await ctx.reply("📢 Send the message to broadcast to <b>all</b> users:", { parse_mode: "HTML" });
      return;
    }
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
    await ctx.reply(`🔥 Flash sale set: ${pct}% off${endsAt ? ` for ${hours} h` : " (until you end it)"}.`);
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

  if (awaiting === "admin_broadcast") {
    const res = await sendBroadcast({ title: "", body: text.slice(0, 3500), segment: "all", createdById: "bot-admin" });
    await ctx.reply(`📢 Broadcast queued to ${res.targets} users.`);
    await sendPanel(ctx, false);
    return true;
  }

  return false;
}
