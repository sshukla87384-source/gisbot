import { loadConfig } from "@gis/config";
import {
  addLicenseKeys,
  addStock,
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
  setProductPasswordChange,
  setProductWarranty,
  setProductReusableSecret,
  setProductReusableStock,
  setProductManualStock,
  getProductReusableSecret,
  setTranslateCreds,
  getTranslateProvider,
  setProductWarrantyDays,
  listReplacementRequests,
  getReplacementRequest,
  approveReplacement,
  approveReplacementsForOrder,
  rejectReplacement,
  adminListTickets,
  adminGetTicket,
  adminReplyTicket,
  setTicketStatus,
  issueReplacementFromTicket,
  openTicketCount,
  getTicketProof,
  profitReport,
  thinMarginProducts,
  setVariantCost,
  getMarginFloorBp,
  setMarginFloorBp,
  reconcile,
  qualityReport,
  getQualityConfig,
  saveQualityConfig,
  getRecoveryConfig,
  saveRecoveryConfig,
  adminTotpRequired,
  adminTotpState,
  beginAdminTotp,
  confirmAdminTotp,
  checkAdminTotp,
  disableAdminTotp,
  sendResellerStatements,
  findTicketByOrderItem,
  listPendingManualItems,
  manualFulfillItem,
  type PriceChannel,
  createApiKey,
  listApiKeys,
  setApiKeyScopes,
  getButtonConfig,
  setButton,
  verifyAdminPasscode,
  setAdminPasscode,
  isAdminPasscodeConfigured,
  getSalesDashboard,
  adminRefundOrder,
  adminReplaceOrderItem,
  getReferralConfig,
  setReferralRate,
  setBnplLimit,
  getBnplStatus,
  getCustomEmojiRegistry,
  setCustomEmojiEntry,
  removeCustomEmojiEntry,
  dmUser,
  setWebAdminPassword,
  getDeliveryInstructions,
  setDeliveryInstructions,
  BUTTON_LABEL_KEYS,
  type ButtonLabelKey,
  revokeApiKey,
  announceProduct,
  announceFlashSale,
  clearFlashSale,
  confirmManualPayment,
  createCategoryQuick,
  listCategoriesAdmin,
  listProductsForCategorising,
  productIdsForCategorising,
  bulkSetCategory,
  setCategoryEmoji,
  renameCategory,
  setCategoryActive,
  deleteCategory,
  createProductFull,
  getAdminOrder,
  getAdminStats,
  rejectManualOrder,
  getRedis,
  listPendingPaymentOrders,
  listProductsBrief,
  listProductsPage,
  getProductBriefById,
  listRecentOrders,
  listCategoriesBrief,
  listPostTargets,
  listVariantsBrief,
  postProductToGroups,
  removePostTarget,
  sendBroadcast,
  scheduleBroadcast,
  setFlashSale,
  setProductImage,
  setProductName,
  setProductDescription,
  setProductActivationGuide,
  setProductButton,
  setProductStatus,
  testBinanceApi,
  setBinanceCreds,
  listSuppliers,
  addSupplier,
  removeSupplier,
  testSupplier,
  syncSupplierProducts,
  fulfillFromSupplier,
  listSupplierProducts,
  supplierProductIdsOnPage,
  supplierProductIdsAll,
  bulkSupplierProducts,
  bulkAllSupplierProducts,
  countSupplierProducts,
  countSupplierProductStates,
  getSupplierNewVisible,
  setSupplierNewVisible,
  listRecentUsers,
  getUserSummary,
  setUserBanned,
  adjustUserWalletById,
  getUserById,
  getFlashHeadline,
  setFlashHeadline,
  verifyBinanceByTxnId,
  WIZARD_TYPES,
  announcePriceChange,
  learnSupplierDocs,
  normalizeSupplierBase,
  getFollowupConfig,
  setFollowupConfig,
  renderFollowup,
  listReviews,
  reviewStats,
  storeRating,
  ratingBreakdown,
  getReview,
  approveReview,
  rejectReview,
  replyToReview,
  setVerifiedPurchase,
  moderationLog,
  REJECT_REASONS,
  topWatched,
  rederiveInrPrices,
  bulkAdjustPrices,
  findOrderByKey,
  stockHealth,
  customerRisk,
  exportOrdersCsv,
  pricingSummary,
  getTiers,
  setTiers,
  listGifts,
  createGift,
  markGiftDelivered,
  getSpinConfig,
  setSpinConfig,
  getPromoFlags,
  setPromoFlag,
  spinStats,
  REWARD_CAP_BP,
  listTestimonials,
  testimonialStats,
  getTestimonial,
  createTestimonial,
  updateTestimonial,
  setTestimonialStatus,
  toggleTestimonialFlag,
  setTestimonialOrder,
  deleteTestimonial,
  testimonialLog,
  exportTestimonials,
  importTestimonials,
  readLogs,
  clearLogs,
  logCounts,
  type LogChannel,
  autoFetchSupplierDocs,
  notifyTopupToAdmins,
  listFundedUsers,
  getUserWalletHistory,
  closeBnpl,
  getInrPerUsdt,
  getInrSurchargeBp,
  setInrSurchargeBp,
  setInrPerUsdt,
  repairBrokenAccounts,
  announceCatalogue,
  PROMO_STYLES,
  STYLE_LABELS,
  promoContext,
  renderPromo,
  announcePromo,
  getAutoPromo,
  setAutoPromo,
  getMaintenance,
  setMaintenance,
} from "@gis/core";
import type { SyncResult } from "@gis/core";
import { cb } from "@gis/shared";
import { InlineKeyboard, InputFile } from "grammy";
import QRCode from "qrcode";
import type { Ctx } from "./ctx.js";
import { escapeHtml, fmt } from "./ui.js";
import { sbtn } from "./keyboard.js";
import { header, bold } from "./premium.js";
import { setDynamicEmojis } from "./emoji.js";

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
  if (!(await isAdminPasscodeConfigured(cfg.BOT_ADMIN_PASSCODE))) {
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

  if (idAllowed(tgId) && (await verifyAdminPasscode(text, cfg.BOT_ADMIN_PASSCODE))) {
    // Second factor, if the operator turned it on. The session is NOT created
    // until the code checks out, so a leaked passcode alone opens nothing.
    if (await adminTotpRequired()) {
      ctx.session.awaiting = "admin_totp_code";
      await redis.del(attemptsKey);
      await ctx.reply("🔐 Passcode accepted. Now send the <b>6-digit code</b> from your authenticator app:", { parse_mode: "HTML" });
      return;
    }
    await grantAdminSession(ctx, tgId);
    return;
  }
  await ctx.reply("❌ Wrong passcode.");
}

/** Create the admin session and announce it. Shared by the 1FA and 2FA paths. */
async function grantAdminSession(ctx: Ctx, tgId: number): Promise<void> {
  const redis = getRedis();
  {
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
    await redis.del(`botadmin:try:${tgId}`);
    await ctx.reply("✅ Admin access granted. You’ll stay logged in until you tap 🚪 Logout.\nYou’ll also get order alerts here.");
    await sendPanel(ctx, false);
  }
}

async function guard(ctx: Ctx): Promise<boolean> {
  if (await isBotAdmin(ctx.from?.id)) return true;
  await ctx.answerCallbackQuery({ text: "Session expired — send /admin", show_alert: true }).catch(() => undefined);
  return false;
}

function panelKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .add(sbtn("🛍 Products", cb("adm", "m_prod"), "primary"), sbtn("👥 Users", cb("adm", "m_users"), "primary")).row()
    .add(sbtn("🧾 Orders", cb("adm", "m_orders"), "primary"), sbtn("📊 Stats", cb("adm", "m_stats"), "primary")).row()
    .add(sbtn("💰 Money", cb("adm", "m_money"), "success"), sbtn("💳 Payments & APIs", cb("adm", "m_pay"), "primary")).row()
    .add(sbtn("📣 Marketing", cb("adm", "m_mkt"), "primary"), sbtn("🎨 Content & Style", cb("adm", "m_content"), "primary")).row()
    .add(sbtn("🧰 Tools", cb("adm", "m_tools"), "primary"), sbtn("🔐 Security", cb("adm", "m_sec"), "primary")).row()
    .add(sbtn("↻ Refresh", cb("adm", "home"), "success")).row();
}

function submenu(title: string, subtitle: string, rows: Array<Array<[string, string, "primary" | "success" | "danger"]>>): { text: string; kb: InlineKeyboard } {
  const kb = new InlineKeyboard();
  for (const r of rows) { for (const [label, data, style] of r) kb.add(sbtn(label, data, style)); kb.row(); }
  kb.text("◀️ Back", cb("adm", "home"));
  return { text: `${title}\n<i>${subtitle}</i>`, kb };
}

async function showSubmenu(ctx: Ctx, route: string): Promise<boolean> {
  const M: Record<string, { title: string; subtitle: string; rows: Array<Array<[string, string, "primary" | "success" | "danger"]>> }> = {
    m_prod: { title: "🛍 <b>Products Management</b>", subtitle: "Add and manage your catalog", rows: [
      [["➕ Add Product", cb("adm", "addp"), "success"]],
      [["📦 All Products", cb("adm", "prods"), "primary"]],
      [["🗂 Categories &amp; grouping", cb("adm", "cats"), "success"]],
      [["🔔 Waiting Lists", cb("adm", "wait"), "success"]],
      [["🧰 Repair account stock", cb("adm", "fixacc"), "primary"]],
    ] },
    m_orders: { title: "🧾 <b>Orders</b>", subtitle: "Review and fulfil orders", rows: [
      [["🧾 Pending", cb("adm", "orders"), "primary"], ["🗂 Recent", cb("adm", "recent"), "primary"]],
      [["🔄 Replacement Requests", cb("adm", "reps"), "success"]],
      [["🎫 Support Tickets", cb("adm", "tks"), "success"]],
    ] },
    m_stats: { title: "📊 <b>Stats</b>", subtitle: "Your store at a glance", rows: [
      [["📊 Dashboard", cb("adm", "stats"), "primary"], ["📈 Sales", cb("adm", "sales"), "primary"]],
    ] },
    m_pay: { title: "💳 <b>Payments & APIs</b>", subtitle: "Payment providers & suppliers", rows: [
      [["🔗 Set Binance API", cb("adm", "binapi"), "primary"], ["🧪 Test Binance", cb("adm", "bintest"), "primary"]],
      [["🏭 Vendor APIs (Suppliers)", cb("adm", "sups"), "primary"]],
      [["🔑 Developer API Keys", cb("adm", "apikeys"), "primary"]],
      [["📊 Reseller statements", cb("adm", "rstmt"), "success"]],
      [["💱 INR ⇄ USD Rate", cb("adm", "fxrate"), "primary"]],
      [["🇮🇳 INR Surcharge", cb("adm", "fxsur"), "primary"]],
    ] },
    m_mkt: { title: "📣 <b>Marketing</b>", subtitle: "Reach & reward customers", rows: [
      [["📢 Broadcast", cb("adm", "bc"), "primary"], ["📣 Groups", cb("adm", "groups"), "primary"]],
      [["🎁 Referral %", cb("adm", "refrates"), "primary"], ["🕒 BNPL Limit", cb("adm", "bnpl"), "primary"]],
      [["🔥 Flash Sale Headline", cb("adm", "flashhead"), "primary"]],
      [["🎉 Special Sale (campaign)", cb("adm", "ssale"), "success"]],
      [["🗂 Share Full Stock List", cb("adm", "cataloglist"), "success"]],
      [["📣 Promo Templates", cb("adm", "promot"), "success"], ["🤖 Auto-Promo", cb("adm", "autop"), "primary"]],
    ] },
    m_content: { title: "🎨 <b>Content & Style</b>", subtitle: "Customise how the bot looks & reads", rows: [
      [["🎨 Custom Emoji", cb("adm", "emoji"), "primary"], ["🔤 Button Labels", cb("adm", "btns"), "primary"]],
      [["📋 Delivery Note", cb("adm", "delnote"), "primary"]],
      [["🌐 Auto-Translate", cb("adm", "trcfg"), "primary"]],
      [["💬 After-sale message", cb("adm", "fup"), "success"]],
      [["⭐ Customer Reviews", cb("adm", "revs"), "primary"]],
      [["💬 Testimonials", cb("adm", "tst"), "primary"]],
    ] },
    m_money: { title: "💰 <b>Money</b>", subtitle: "Profit, costs and where the cash is", rows: [
      [["💰 Profit & Margin", cb("adm", "fin"), "success"], ["📒 Reconciliation", cb("adm", "recon"), "primary"]],
      [["⚠️ Thin margins", cb("adm", "thin"), "danger"], ["🎯 Margin floor", cb("adm", "marginfl"), "primary"]],
      [["📉 Delivery quality", cb("adm", "qual"), "primary"]],
      [["🛒 Checkout recovery", cb("adm", "recov"), "primary"]],
    ] },
    m_tools: { title: "🧰 <b>Tools</b>", subtitle: "Pricing, tracing and health checks", rows: [
      [["🔄 Re-derive INR prices", cb("adm", "tlprice"), "success"], ["📈 Bulk ±%", cb("adm", "tladj"), "primary"]],
      [["🔍 Find order by key", cb("adm", "tlkey"), "primary"]],
      [["📊 Stock health", cb("adm", "tlstock"), "primary"], ["🛡 Customer risk", cb("adm", "tlrisk"), "primary"]],
      [["📄 Export orders (CSV)", cb("adm", "tlcsv"), "primary"]],
    ] },
    m_sec: { title: "🔐 <b>Security</b>", subtitle: "Access & sign-out", rows: [
      [["🔑 Bot Passcode", cb("adm", "chpass"), "primary"], ["🔐 Web Login", cb("adm", "webpass"), "primary"]],
      [["🔒 Two-factor (2FA)", cb("adm", "twofa"), "success"]],
      [["🩺 Logs & Errors", cb("adm", "logs"), "primary"]],
      [["🛠 Maintenance Mode", cb("adm", "maint"), "danger"]],
      [["🚪 Logout", cb("adm", "logout"), "danger"], ["🚪 Logout All", cb("adm", "logoutall"), "danger"]],
    ] },
  };
  const m = M[route];
  if (!m) return false;
  const { text, kb } = submenu(m.title, m.subtitle, m.rows);
  await show(ctx, text, kb, true);
  return true;
}

/**
 * Queue a one-line result banner for the NEXT view instead of sending a chat
 * message. Nine product deletions used to leave nine "Product deleted." bubbles
 * stacked above the list; now the list itself reports what happened.
 */
function flash(ctx: Ctx, text: string): void {
  ctx.session.admFlash = text;
}

async function show(ctx: Ctx, text: string, kb: InlineKeyboard, edit: boolean): Promise<void> {
  // Consume any queued banner and render it inline with the view.
  const banner = ctx.session.admFlash;
  ctx.session.admFlash = undefined;
  if (banner) text = `${banner}\n\n${text}`;
  const opts = { parse_mode: "HTML" as const, reply_markup: kb };
  if (edit && ctx.callbackQuery?.message) {
    try { await ctx.editMessageText(text, opts); return; } catch (err) {
      // "message is not modified" just means the view is already current —
      // re-sending it would spam a duplicate panel.
      if (String((err as { description?: string })?.description ?? err).includes("not modified")) return;
    }
  }
  await ctx.reply(text, opts);
}

async function sendPanel(ctx: Ctx, edit: boolean): Promise<void> {
  const s = await getAdminStats().catch(() => null);
  const lines = [
    header(`🛠 ${bold(`${loadConfig().STORE_NAME} · Admin`)}`),
    "Your control center — everything in one place.",
  ];
  if (s) {
    lines.push(
      "",
      `🧾 Pending: <b>${s.pendingPayments}</b>   ·   📦 Active: <b>${s.activeProducts}</b>`,
      `🧾 Orders today: <b>${s.ordersToday}</b>   ·   ${s.lowStockVariants > 0 ? `⚠️ Low stock: <b>${s.lowStockVariants}</b>` : "✅ Stock healthy"}`,
    );
  }
  await show(ctx, lines.join("\n"), panelKeyboard(), edit);
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
  if (["PAID", "COMPLETED", "PENDING_FULFILLMENT", "AWAITING_STOCK", "PARTIALLY_REFUNDED"].includes(o.status)) {
    if (o.items.some((i) => i.type === "LICENSE_KEY" || i.type === "DIGITAL_ACCOUNT")) {
      kb.text("🔄 Replace an item", cb("adm", "replace", o.id)).row();
    }
    kb.add(sbtn("↩️ Refund to wallet", cb("adm", "refund", o.id), "danger")).row();
  }
  kb.text("◀️ Back", cb("adm", "orders"));
  await show(ctx, lines.join("\n"), kb, true);
}

async function productsView(ctx: Ctx, page = 1): Promise<void> {
  const search = ctx.session.prodSearch;
  const result = await listProductsPage(page, 20, search);
  const kb = new InlineKeyboard();
  kb.add(sbtn(search ? `🔎 “${search}” — clear` : "🔎 Search products", cb("adm", search ? "prodsclr" : "prodsrch"), "primary")).row();
  for (const p of result.items) {
    const tag = p.status === "ACTIVE" ? "🟢" : "🙈";
    const sale = p.onSalePct ? " 🔥" : "";
    kb.text(`${tag} ${p.iconEmoji ? `${p.iconEmoji} ` : ""}${p.name}${sale}`, cb("adm", "prod", p.id)).row();
  }
  if (result.pages > 1) {
    const nav: Array<ReturnType<typeof sbtn>> = [];
    if (result.page > 1) nav.push(sbtn("◀️ Prev", cb("adm", "prods", String(result.page - 1)), "primary"));
    if (result.page < result.pages) nav.push(sbtn("Next ▶️", cb("adm", "prods", String(result.page + 1)), "primary"));
    if (nav.length) kb.add(...nav).row();
  }
  kb.text("◀️ Back", cb("adm", "home"));
  await show(ctx, result.total ? `📦 <b>Products</b>${search ? ` matching “${escapeHtml(search)}”` : ""} — ${result.total} total (page ${result.page}/${result.pages})\n🟢 shown · 🙈 hidden` : (search ? "No products match that search." : "No products yet."), kb, true);
}

async function productView(ctx: Ctx, productId: string): Promise<void> {
  const autoPromo = await getAutoPromo().catch(() => ({ productIds: [] as string[], enabled: false, everyHours: 12, lastRunAt: null }));
  const p = await getProductBriefById(productId);
  if (!p) { await productsView(ctx); return; }
  const kb = new InlineKeyboard();
  if (p.status === "ACTIVE") kb.add(sbtn("👁 Shown — tap to Hide", cb("adm", "ppause", p.id), "primary"));
  else kb.add(sbtn("🙈 Hidden — tap to Show", cb("adm", "pactive", p.id), "success"));
  kb.text("📣 Announce", cb("adm", "announce", p.id)).text("📣 Promo styles", cb("adm", "promotp", p.id)).row();
  kb.add(sbtn(`🤖 Auto-announce: ${autoPromo.productIds.includes(p.id) ? "✅ ON" : "🚫 OFF"}`, cb("adm", "pauto", p.id), autoPromo.productIds.includes(p.id) ? "success" : "primary")).row();
  if (p.onSalePct) kb.text("🔥 End sale", cb("adm", "saleoff", p.id));
  else kb.text("🔥 Start flash sale", cb("adm", "sale", p.id));
  kb.row().text("✏️ Name", cb("adm", "pname", p.id)).text("✏️ Description", cb("adm", "pdesc", p.id)).row();
  kb.text("📄 Delivery instructions", cb("adm", "pguide", p.id)).row();
  kb.text("🖼 Set image", cb("adm", "pimg", p.id)).text("🔑 Add stock keys", cb("adm", "keys", p.id)).row();
  if (p.supplierId) kb.text("🤖 Delivery: Auto via supplier", cb("adm", "prod", p.id)).row();
  else kb.text(`⚙️ Delivery: ${p.fulfillmentMode === "MANUAL" ? "MANUAL → make AUTOMATIC" : "AUTOMATIC → make MANUAL"}`, cb("adm", "pmode", p.id)).row();
  if (p.type === "DIGITAL_ACCOUNT") kb.text(`🔐 Password change: ${p.allowPwChange ? "✅ Allowed → disallow" : "🚫 Not allowed → allow"}`, cb("adm", "ppw", p.id)).row();
  kb.add(sbtn(`🛡 Warranty: ${p.warranty ? `✅ ON${p.warrantyDays ? ` (${p.warrantyDays}d)` : " (no limit)"} → turn OFF` : "🚫 OFF → turn ON"}`, cb("adm", "pwar", p.id), p.warranty ? "success" : "danger")).row();
  if (p.warranty) kb.text(`⏱ Warranty days${p.warrantyDays ? `: ${p.warrantyDays}` : ": unlimited"}`, cb("adm", "pwardays", p.id)).row();
  kb.text("📣 Post to groups", cb("adm", "gpost", p.id)).row();
  kb.text("💵 Edit price", cb("adm", "pprice", p.id)).text("💲 Custom pricing", cb("adm", "cprice", p.id)).row();
  kb.text("💰 My cost (for margin)", cb("adm", "pcost", p.id)).row();
  kb.text(`📌 Pin / position${p.pinRank ? ` (#${p.pinRank})` : ""}`, cb("adm", "cpin", p.id)).row();
  kb.add(sbtn(`♾ Same link for everyone: ${p.reusable ? "✅ ON" : "🚫 OFF"}`, cb("adm", "preuse", p.id), p.reusable ? "success" : "primary")).row();
  if (p.reusable) kb.text(`🔢 Quantity: ${p.reusableStock ?? "∞ unlimited"}`, cb("adm", "preuseqty", p.id)).row();
  else if (p.fulfillmentMode === "MANUAL") kb.text(`🔢 Quantity: ${p.manualStock ?? "∞ unlimited"}`, cb("adm", "pmanqty", p.id)).row();
  kb.text("🎨 Button name & colour", cb("adm", "pbtn", p.id)).row();
  kb.text("🗑 Delete product", cb("adm", "pdel", p.id)).row();
  kb.text("◀️ Back", cb("adm", "prods"));
  const deliv = p.supplierId ? "🤖 Auto (supplier)" : p.fulfillmentMode === "AUTOMATIC" ? "⚡ Auto (instant)" : "🕐 Manual";
  const war = p.warranty ? ` · 🛡 Warranty${p.warrantyDays ? ` ${p.warrantyDays}d` : " (no limit)"}` : " · 🏷 As-is (no warranty)";
  const text = `📦 <b>${p.iconEmoji ? `${p.iconEmoji} ` : ""}${p.nameHtml ?? escapeHtml(p.name)}</b>\n${p.status === "ACTIVE" ? "👁 <b>Visible</b>" : "🙈 <b>Hidden</b>"} · ${p.status} · ${deliv}${p.onSalePct ? ` · 🔥 ${Math.round(p.onSalePct / 100)}% off` : ""}${war}`;
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
    kb.text(`📤 Enter key — ${it.productName}${vn}`, cb("adm", "dlv", it.id)).row();
    kb.text(`🤖 Auto-buy from supplier — ${it.productName}`, cb("adm", "supbuy", it.id)).row();
  }
  kb.text("◀️ Back", cb("adm", "orders"));
  const text = items.length
    ? `📦 <b>Manual delivery</b> — Order <b>${escapeHtml(orderNumber)}</b>\n\nTap an item to send its key/details to the customer.`
    : `✅ Order <b>${escapeHtml(orderNumber)}</b> — nothing left to deliver.`;
  await show(ctx, text, kb, true);
}

async function customPriceView(ctx: Ctx, productId: string): Promise<void> {
  // Keep the product in session: "adm:cprm:<userId>~<channel>~<productId>" was
  // 65-67 bytes and cb() throws over 64, which killed this whole screen.
  ctx.session.admProductId = productId;
  const p = await getProductBriefById(productId);
  const rows = await listProductUserPrices(productId);
  const kb = new InlineKeyboard();
  kb.text("➕ Add custom price", cb("adm", "cpadd", productId)).row();
  for (const r of rows) {
    kb.text(`✖️ ${r.label} · ${(r.amountMinor / 100).toFixed(2)} · ${chLabel(r.channel)}`, cb("adm", "cprm", `${r.userId}~${r.channel.slice(0, 1)}`)).row();
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
  account: "👤 My Account", referral: "👥 Referral", currency: "💱 Currency", language: "🌐 Language", developer: "🧑‍💻 Developer API",
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

async function salesView(ctx: Ctx): Promise<void> {
  const d = await getSalesDashboard();
  const money = (rec: Record<string, number>): string => {
    const parts = Object.entries(rec).map(([c, v]) => fmt(v, c));
    return parts.length ? parts.join(" · ") : "—";
  };
  const top = d.topProducts.length
    ? d.topProducts.map((p, i) => `${i + 1}. ${escapeHtml(p.name)} — ${p.qty}×`).join("\n")
    : "No sales yet.";
  const text = [
    "📈 <b>Sales Dashboard</b>",
    "",
    `💵 <b>Revenue today:</b> ${money(d.revenueTodayMinor)}`,
    `📅 <b>Revenue (7 days):</b> ${money(d.revenue7dMinor)}`,
    `🧾 Orders — today: <b>${d.ordersToday}</b> · 7d: <b>${d.orders7d}</b>`,
    "",
    "🔥 <b>Top products (30 days)</b>",
    top,
    "",
    `👥 Buyers: <b>${d.buyers}</b> · Repeat: <b>${d.repeatBuyers}</b> (<b>${d.repeatRatePct}%</b>)`,
  ].join("\n");
  await show(ctx, text, new InlineKeyboard().text("↻ Refresh", cb("adm", "sales")).text("◀️ Back", cb("adm", "home")), true);
}

async function replaceItemsView(ctx: Ctx, orderId: string): Promise<void> {
  const o = await getAdminOrder(orderId);
  if (!o) { await orderView(ctx, orderId); return; }
  const kb = new InlineKeyboard();
  const auto = o.items.filter((i) => i.type === "LICENSE_KEY" || i.type === "DIGITAL_ACCOUNT");
  for (const i of auto) {
    kb.text(`🔄 ${i.name}${i.variant.trim().toLowerCase() === "standard" ? "" : ` · ${i.variant}`}`, cb("adm", "repl", i.id)).row();
  }
  kb.text("◀️ Back", cb("adm", "ord", orderId));
  await show(ctx, auto.length ? `🔄 <b>Replace an item</b> — order <b>${escapeHtml(o.orderNumber)}</b>\nTap the item to deliver a fresh one from stock.` : "No auto-delivery items to replace on this order.", kb, true);
}

async function refRatesView(ctx: Ctx): Promise<void> {
  const c = await getReferralConfig();
  const kb = new InlineKeyboard()
    .text(`✏️ First purchase: ${c.firstPct}%`, cb("adm", "refset", "first")).row()
    .text(`✏️ Repeat purchase: ${c.repeatPct}%`, cb("adm", "refset", "repeat")).row()
    .text("◀️ Back", cb("adm", "home"));
  await show(ctx, [
    "🎁 <b>Referral rewards</b>",
    "",
    `Referrers earn a % of each referred order (credited to their wallet after a ${c.holdHours}h hold).`,
    `• First purchase: <b>${c.firstPct}%</b>`,
    `• Every purchase after: <b>${c.repeatPct}%</b>`,
    "",
    "Tap a rate to change it.",
  ].join("\n"), kb, true);
}

const EMOJI_NAME_HINTS = "wallet, cart, vip, diamond, fire, gift, rocket, star, bolt, shop, money, chart, home, support";

async function emojiRegistryView(ctx: Ctx): Promise<void> {
  const reg = await getCustomEmojiRegistry();
  const names = Object.keys(reg);
  const kb = new InlineKeyboard().text("➕ Add emoji", cb("adm", "emojiadd")).row();
  for (const n of names.slice(0, 20)) kb.text(`✖️ ${n}`, cb("adm", "emojirm", n)).row();
  kb.text("◀️ Back", cb("adm", "home"));
  const preview = names.length
    ? names.map((n) => `• <b>${escapeHtml(n)}</b>: <tg-emoji emoji-id="${reg[n]!.id}">${reg[n]!.glyph}</tg-emoji>`).join("\n")
    : "No custom emoji added yet.";
  await show(ctx, [
    "🎨 <b>Custom emoji</b>",
    "",
    "Add your Telegram premium emoji here to use them across the bot UI (menu, headers, buttons where supported).",
    `Use these names to theme built-in spots: <i>${EMOJI_NAME_HINTS}</i>`,
    "",
    preview,
    "",
    "Tap ➕ Add emoji, then send one premium emoji.",
  ].join("\n"), kb, true);
}

async function suppliersView(ctx: Ctx): Promise<void> {
  const sups = await listSuppliers();
  const kb = new InlineKeyboard().add(sbtn("➕ Add supplier", cb("adm", "supadd"), "success")).row();
  for (const su of sups) {
    kb.text(`🔄 Sync`, cb("adm", "supsync", su.id)).text("📂 Products (bulk)", cb("adm", "supprods", su.id)).text("🗑", cb("adm", "suprm", su.id)).row();
    kb.text(`🧪 Test connection — ${su.name.slice(0, 18)}`, cb("adm", "suptest", su.id)).row();
    kb.text(`📄 Read API docs — ${su.name.slice(0, 18)}`, cb("adm", "supdocs", su.id)).row();
    kb.add(sbtn(`🔎 Auto-find docs — ${su.name.slice(0, 14)}`, cb("adm", "supauto", su.id), "success")).row();
  }
  kb.text("◀️ Back", cb("adm", "home"));
  const lines = [
    "🏭 <b>Suppliers</b>",
    "",
    "Connect an external supplier API — sync their catalog into your shop with your markup; buyers pay your price and the key is bought from the supplier and delivered automatically.",
    "",
    "🔄 Sync imports <b>everything</b> they offer. New items arrive <b>hidden</b> by default, so a big vendor can't flood your shop — open 📂 <b>Products (bulk)</b> to tick what goes on sale.",
    "",
  ];
  if (sups.length === 0) lines.push("No suppliers yet. Tap ➕ Add supplier.");
  for (const su of sups) lines.push(`• <b>${escapeHtml(su.name)}</b> — +${Math.round(su.markupBp / 100)}% markup ${su.active ? "🟢" : "⚪️"}\n  <code>${escapeHtml(su.baseUrl)}</code>`);
  await show(ctx, lines.join("\n"), kb, true);
}

async function usersMenuView(ctx: Ctx): Promise<void> {
  const kb = new InlineKeyboard()
    .add(sbtn("📋 View Users", cb("adm", "uview"), "primary")).row()
    .add(sbtn("💰 Wallets & BNPL", cb("adm", "ufund"), "success")).row()
    .add(sbtn("🏆 Loyalty Tiers", cb("adm", "loy"), "primary"), sbtn("🎁 Gifts", cb("adm", "gifts"), "primary")).row()
    .add(sbtn("🎡 Spin & Win", cb("adm", "spncfg"), "primary")).row()
    .add(sbtn("🔎 Customer Lookup", cb("adm", "ulook"), "primary")).row()
    .text("◀️ Back", cb("adm", "home"));
  await show(ctx, "👥 <b>Users Management</b>\n<i>View, look up, credit/debit or ban customers</i>", kb, true);
}

async function usersListView(ctx: Ctx): Promise<void> {
  const users = await listRecentUsers(12);
  const kb = new InlineKeyboard();
  for (const u of users) {
    kb.text(`${u.status === "BANNED" ? "🚫 " : ""}${u.label} · 🆔${u.telegramId || "?"} · ${(u.balanceMinor / 100).toFixed(2)} ${u.currency} · ${u.orders}🧾`, cb("adm", "uinfo", u.id)).row();
  }
  kb.text("◀️ Back", cb("adm", "m_users"));
  await show(ctx, users.length ? "📋 <b>Recent users</b>\nTap one to manage." : "No users yet.", kb, true);
}

async function userDetailView(ctx: Ctx, userId: string): Promise<void> {
  const u = await getUserById(userId);
  if (!u) { await ctx.reply("User not found."); return usersMenuView(ctx); }
  const kb = new InlineKeyboard()
    .add(sbtn("➕ Add Balance", cb("adm", "uadd", u.id), "success"), sbtn("➖ Deduct", cb("adm", "udeduct", u.id), "danger")).row()
    .add(sbtn("🧾 Wallet history", cb("adm", "uhist", u.id), "primary")).row()
    .add(sbtn("🕒 BNPL limit", cb("adm", "ubnpl", u.id), "primary"), sbtn("🔒 Close BNPL", cb("adm", "ubnplclose", u.id), "danger")).row()
    .add(u.status === "BANNED" ? sbtn("✅ Unban User", cb("adm", "uunban", u.id), "success") : sbtn("🚫 Ban User", cb("adm", "uban", u.id), "danger")).row()
    .text("◀️ Back", cb("adm", "ufund"));
  await show(ctx, [
    `👤 <b>${escapeHtml(u.label)}</b>`,
    `🆔 ID: <code>${u.telegramId || "—"}</code>`,
    `Status: <b>${u.status}</b>`,
    `Wallet: <b>${(u.balanceMinor / 100).toFixed(2)} ${u.currency}</b>`,
    `Orders: <b>${u.orders}</b>`,
    ...(await (async () => {
      const b = await getBnplStatus(u.id).catch(() => null);
      if (!b || (b.limitMinor === 0 && b.outstandingMinor === 0)) return [] as string[];
      return [
        `🕒 BNPL limit: <b>${(b.limitMinor / 100).toFixed(2)}</b> · owed: <b>${(b.outstandingMinor / 100).toFixed(2)}</b> · available: <b>${(b.availableMinor / 100).toFixed(2)}</b>`,
      ];
    })()),
  ].join("\n"), kb, true);
}

async function logsMenuView(ctx: Ctx): Promise<void> {
  const c = await logCounts();
  const kb = new InlineKeyboard()
    .add(sbtn(`❌ Errors (${c.error})`, cb("adm", "logv", "error"), c.error > 0 ? "danger" : "primary")).row()
    .add(sbtn(`💰 Wallet & payments (${c.wallet})`, cb("adm", "logv", "wallet"), c.wallet > 0 ? "danger" : "primary")).row()
    .add(sbtn(`🏭 Supplier (${c.supplier})`, cb("adm", "logv", "supplier"), "primary")).row()
    .text("◀️ Back", cb("adm", "m_sec"));
  await show(ctx, [
    "🩺 <b>Logs &amp; Errors</b>",
    "",
    "Recent problems recorded by the bot, worker and API — newest first.",
    c.error + c.wallet + c.supplier === 0 ? "\n✅ Nothing logged. All clear." : "",
  ].filter(Boolean).join("\n"), kb, true);
}

async function logsView(ctx: Ctx, channel: string): Promise<void> {
  const ch = (["error", "wallet", "payment", "supplier"].includes(channel) ? channel : "error") as LogChannel;
  const rows = await readLogs(ch, 12);
  const icon = (l: string) => (l === "error" ? "❌" : l === "warn" ? "⚠️" : "ℹ️");
  const lines = [`🩺 <b>${ch === "wallet" ? "Wallet &amp; payments" : ch === "supplier" ? "Supplier" : "Errors"}</b> — last ${rows.length}`, ""];
  if (rows.length === 0) lines.push("✅ Nothing logged here.");
  for (const r of rows) {
    const when = r.at.slice(5, 16).replace("T", " ");
    const meta = r.meta
      ? Object.entries(r.meta).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => `${k}=${v}`).join(" ")
      : "";
    lines.push(`${icon(r.level)} <b>${when}</b> · <code>${escapeHtml(r.where)}</code>`);
    lines.push(`   ${escapeHtml(r.message)}`);
    if (meta) lines.push(`   <i>${escapeHtml(meta.slice(0, 200))}</i>`);
  }
  const kb = new InlineKeyboard()
    .add(sbtn("🔄 Refresh", cb("adm", "logv", ch), "primary"), sbtn("🧹 Clear", cb("adm", "logclr", ch), "danger")).row()
    .text("◀️ Back", cb("adm", "logs"));
  await show(ctx, lines.join("\n").slice(0, 3900), kb, true);
}

async function fundedUsersView(ctx: Ctx): Promise<void> {
  const rows = await listFundedUsers(25);
  const kb = new InlineKeyboard();
  for (const u of rows) {
    const bits = [`${(u.balanceMinor / 100).toFixed(2)} ${u.currency}`];
    if (u.bnplOwedMinor > 0) bits.push(`🕒 owes ${(u.bnplOwedMinor / 100).toFixed(2)}`);
    else if (u.bnplLimitMinor > 0) bits.push(`🕒 limit ${(u.bnplLimitMinor / 100).toFixed(2)}`);
    kb.text(`${u.status === "BANNED" ? "🚫 " : "💰 "}${u.label} · ${bits.join(" · ")}`, cb("adm", "uinfo", u.id)).row();
  }
  kb.text("◀️ Back", cb("adm", "m_users"));
  const totalBal = rows.reduce((n, r) => n + r.balanceMinor, 0) / 100;
  const totalOwed = rows.reduce((n, r) => n + r.bnplOwedMinor, 0) / 100;
  await show(ctx, rows.length
    ? [
        "💰 <b>Wallets &amp; BNPL</b>",
        `Customers holding money or credit: <b>${rows.length}</b>`,
        `💳 Total wallet balances: <b>${totalBal.toFixed(2)}</b>`,
        totalOwed > 0 ? `🕒 Total BNPL owed: <b>${totalOwed.toFixed(2)}</b>` : "",
        "",
        "Tap a customer to see their history, add/deduct balance or close their limit.",
      ].filter(Boolean).join("\n")
    : "💰 <b>Wallets &amp; BNPL</b>\n\nNo customer holds a balance or BNPL credit yet.", kb, true);
}

async function walletHistoryView(ctx: Ctx, userId: string): Promise<void> {
  const [u, h] = await Promise.all([getUserById(userId), getUserWalletHistory(userId, 12)]);
  if (!u) { await ctx.reply("User not found."); return fundedUsersView(ctx); }
  const sign = (n: number) => (n >= 0 ? `+${(n / 100).toFixed(2)}` : `${(n / 100).toFixed(2)}`);
  const lines = [
    `🧾 <b>Wallet history — ${escapeHtml(u.label)}</b>`,
    `🆔 <code>${u.telegramId || "—"}</code>`,
    `💳 Balance: <b>${(u.balanceMinor / 100).toFixed(2)} ${u.currency}</b>`,
    "",
  ];
  if (h.rows.length === 0) lines.push("<i>No wallet activity yet.</i>");
  for (const r of h.rows) {
    const when = r.at.toISOString().slice(0, 16).replace("T", " ");
    lines.push(`${r.amountMinor >= 0 ? "🟢" : "🔴"} <b>${sign(r.amountMinor)}</b> · ${r.type} · ${when}${r.note ? `\n   <i>${escapeHtml(r.note)}</i>` : ""}`);
  }
  const kb = new InlineKeyboard()
    .add(sbtn("➕ Add", cb("adm", "uadd", userId), "success"), sbtn("➖ Deduct", cb("adm", "udeduct", userId), "danger")).row()
    .text("◀️ Back", cb("adm", "uinfo", userId));
  await show(ctx, lines.join("\n"), kb, true);
}

const usd = (m: number): string => `$${(m / 100).toFixed(2)}`;
const pct = (bp: number | null): string => (bp === null ? "—" : `${(bp / 100).toFixed(1)}%`);

async function resellerStmtView(ctx: Ctx): Promise<void> {
  const kb = new InlineKeyboard()
    .add(sbtn("📤 Send now", cb("adm", "rstmtnow"), "success")).row()
    .text("◀️ Back", cb("adm", "m_pay"));
  await show(
    ctx,
    [
      "📊 <b>Reseller statements</b>",
      "",
      "Every API user gets a daily message with:",
      "• orders and units bought",
      "• what they spent",
      "• the same goods at your public price",
      "• 🎁 what their special pricing saved them",
      "• their standing special rates",
      "",
      "It runs once a day automatically. Anyone who bought nothing is skipped — a daily \"you did nothing\" message just gets you muted.",
      "",
      "<i>The margin shown is measured against your public price, and says so. We can't see what a reseller charges their own customers, so calling it their profit would be inventing a number.</i>",
    ].join("\n"),
    kb,
    true,
  );
}

async function twoFaView(ctx: Ctx): Promise<void> {
  const st = await adminTotpState();
  const kb = new InlineKeyboard();
  if (st.enabled) kb.add(sbtn("🔓 Turn 2FA off", cb("adm", "twofaoff"), "danger")).row();
  else kb.add(sbtn(st.pending ? "🔄 Start again" : "🔒 Turn 2FA on", cb("adm", "twofaon"), "success")).row();
  kb.text("◀️ Back", cb("adm", "m_sec"));
  await show(
    ctx,
    [
      "🔒 <b>Two-factor login</b>",
      "",
      st.enabled
        ? "✅ <b>ON</b> — signing in needs your passcode <i>and</i> a 6-digit code from your authenticator app."
        : st.pending
          ? "⏳ <b>Started but not finished.</b> Tap below to scan a fresh QR and send a code."
          : "⚪ <b>OFF</b> — your passcode is the only thing protecting the panel.",
      "",
      "Right now the passcode lives in one Telegram chat. If that chat or the passcode ever leaks, someone else can change prices, read wallets and take your stock. A code from your phone removes that single point of failure and costs you two seconds per login.",
    ].join("\n"),
    kb,
    true,
  );
}

async function profitView(ctx: Ctx, days: number): Promise<void> {
  const r = await profitReport(days);
  const kb = new InlineKeyboard();
  kb.text("7d", cb("adm", "fin", "7")).text("30d", cb("adm", "fin", "30")).text("90d", cb("adm", "fin", "90")).row();
  kb.add(sbtn("⚠️ Thin margins", cb("adm", "thin"), "danger")).row();
  kb.text("◀️ Back", cb("adm", "m_money"));
  const top = r.rows.slice(0, 8).map((p) =>
    `${p.profitMinor >= 0 ? "🟢" : "🔴"} ${escapeHtml(p.name.slice(0, 22))} · ${p.units}× · ${usd(p.profitMinor)} (${pct(p.marginBp)})`,
  );
  await show(
    ctx,
    [
      `💰 <b>Profit & Margin</b> <i>(last ${r.days}d)</i>`,
      "",
      `💵 Revenue: <b>${usd(r.revenueMinor)}</b>`,
      `📦 Cost of goods: <b>${usd(r.costMinor)}</b>`,
      `📈 Profit: <b>${usd(r.profitMinor)}</b>  ·  Margin: <b>${pct(r.marginBp)}</b>`,
      `🧾 Units delivered: <b>${r.units}</b>`,
      ...(r.unpricedUnits > 0
        ? ["", `⚠️ <b>${r.unpricedUnits} unit(s) have no cost set</b>, so they are left out of the numbers above. Set a cost on those products to see the real margin — open the product and tap 💰 Cost.`]
        : []),
      ...(r.lossMakers.length > 0
        ? ["", "🔴 <b>Sold below cost:</b>", ...r.lossMakers.slice(0, 5).map((l) => `• ${escapeHtml(l.name.slice(0, 26))} — took ${usd(l.revenueMinor)}, cost ${usd(l.costMinor)}`)]
        : []),
      ...(top.length > 0 ? ["", "<b>By product</b>", ...top] : ["", "<i>No delivered sales in this window.</i>"]),
    ].join("\n"),
    kb,
    true,
  );
}

async function reconView(ctx: Ctx): Promise<void> {
  const r = await reconcile(24);
  const kb = new InlineKeyboard().text("↻ Refresh", cb("adm", "recon")).text("◀️ Back", cb("adm", "m_money"));
  await show(
    ctx,
    [
      "📒 <b>Reconciliation</b> <i>(last 24h)</i>",
      "",
      "🏦 <b>Money you are holding</b>",
      `Wallet balances: <b>${usd(r.walletLiabilityMinorUsd)}</b> across ${r.walletCount} wallet(s)`,
      "<i>This is customer money you owe them, not profit.</i>",
      "",
      "🔁 <b>Movement</b>",
      `⬇️ Deposits: <b>${usd(r.depositsMinor)}</b>`,
      `🛍 Spent on orders: <b>${usd(r.purchasesMinor)}</b>`,
      `↩️ Refunds: <b>${usd(r.refundsMinor)}</b>`,
      `🎁 Free credit granted: <b>${usd(r.grantsMinor)}</b> <i>(spins, referrals, adjustments)</i>`,
      "",
      "⏳ <b>Open items</b>",
      `Pending top-ups: <b>${r.topupsPendingCount}</b> (${usd(r.topupsPendingMinor)})`,
      `Expired / cancelled orders: <b>${r.expiredOrders}</b> (${usd(r.expiredValueMinor)})`,
      ...(r.unfulfilledPaidOrders > 0
        ? ["", `🚨 <b>${r.unfulfilledPaidOrders} PAID order(s) still undelivered</b> — ${usd(r.unfulfilledPaidValueMinor)}. Deliver these first.`]
        : ["", "✅ Every paid order has been delivered."]),
      ...(r.driftWallets > 0
        ? ["", `🚨 <b>${r.driftWallets} wallet(s) disagree with their ledger</b> (${usd(r.driftMinor)}). The cached balance drifted — tell me and I'll trace it.`]
        : ["✅ Every wallet matches its ledger."]),
    ].join("\n"),
    kb,
    true,
  );
}

async function thinMarginView(ctx: Ctx): Promise<void> {
  const { floorBp, rows, noCost } = await thinMarginProducts();
  const kb = new InlineKeyboard();
  for (const r of rows.slice(0, 10)) kb.text(`${r.underwater ? "🔴" : "🟠"} ${r.name.slice(0, 24)} · ${pct(r.marginBp)}`, cb("adm", "vcost", r.variantId)).row();
  kb.add(sbtn("🎯 Change floor", cb("adm", "marginfl"), "primary")).row();
  kb.text("◀️ Back", cb("adm", "m_money"));
  await show(
    ctx,
    [
      "⚠️ <b>Thin margins</b>",
      `🎯 Your floor: <b>${pct(floorBp)}</b>`,
      "",
      rows.length === 0
        ? "✅ Nothing is priced below your floor right now."
        : [
            `${rows.length} live product(s) earn less than your floor.`,
            "🔴 = you LOSE money on every sale   🟠 = below floor but still profitable",
            "",
            "Tap one to fix its cost, or raise its price in Products.",
          ].join("\n"),
      ...(noCost > 0 ? ["", `ℹ️ ${noCost} active variant(s) have no cost set, so they can't be checked at all.`] : []),
    ].join("\n"),
    kb,
    true,
  );
}

async function qualityView(ctx: Ctx): Promise<void> {
  const { cfg, rows } = await qualityReport();
  const bad = rows.filter((r) => r.bad);
  const kb = new InlineKeyboard();
  kb.add(sbtn(cfg.autoPause ? "🔴 Auto-pause: ON" : "⚪ Auto-pause: OFF", cb("adm", "qualtog"), cfg.autoPause ? "danger" : "primary")).row();
  kb.add(sbtn(`📉 Threshold: ${pct(cfg.thresholdBp)}`, cb("adm", "qualthr"), "primary")).row();
  for (const r of bad.slice(0, 8)) kb.text(`⚠️ ${r.name.slice(0, 24)} · ${pct(r.rateBp)} · ${r.complaints}/${r.delivered}`, cb("adm", "prod", r.productId)).row();
  kb.text("◀️ Back", cb("adm", "m_money"));
  await show(
    ctx,
    [
      "📉 <b>Delivery quality</b>",
      `<i>Complaints per delivery over the last ${cfg.days} days.</i>`,
      "",
      `A product counts as bad at <b>${pct(cfg.thresholdBp)}</b> complaints, once it has at least <b>${cfg.minDeliveries}</b> deliveries.`,
      "",
      bad.length === 0
        ? "✅ Nothing above your threshold. Stock is behaving."
        : `⚠️ <b>${bad.length} product(s) above threshold</b> — likely a dead batch. Tap one to check its stock.`,
      "",
      cfg.autoPause
        ? "🔴 <b>Auto-pause is ON</b> — bad products are hidden from the shop automatically."
        : "⚪ <b>Auto-pause is OFF</b> — you'll be warned but nothing is hidden. Safer, but a bad batch keeps selling until you act.",
      ...(rows.length > 0
        ? ["", "<b>Worst first</b>", ...rows.slice(0, 6).map((r) => `${r.bad ? "⚠️" : "•"} ${escapeHtml(r.name.slice(0, 24))} — ${r.complaints}/${r.delivered} (${pct(r.rateBp)})`)]
        : ["", "<i>No deliveries in this window.</i>"]),
    ].join("\n"),
    kb,
    true,
  );
}

async function recoveryView(ctx: Ctx): Promise<void> {
  const cfg = await getRecoveryConfig();
  const kb = new InlineKeyboard()
    .add(sbtn(cfg.enabled ? "🟢 Reminders: ON" : "⚪ Reminders: OFF", cb("adm", "recovtog"), cfg.enabled ? "success" : "primary")).row()
    .add(sbtn(`⏱ Wait: ${cfg.afterMinutes} min`, cb("adm", "recovmin"), "primary")).row()
    .text("◀️ Back", cb("adm", "m_money"));
  await show(
    ctx,
    [
      "🛒 <b>Checkout recovery</b>",
      "",
      "When someone starts a payment and doesn't finish, we send <b>one</b> reminder with the exact amount and a button back to the order.",
      "",
      `⏱ Sent <b>${cfg.afterMinutes} minutes</b> after the order was created.`,
      `🛡 Skipped if the order has under <b>${cfg.minMinutesLeft} minutes</b> left — reminding someone too late is worse than not at all.`,
      "",
      "Only ever one reminder per order. Nagging loses the customer, not just the sale.",
    ].join("\n"),
    kb,
    true,
  );
}

async function categoriesAdminView(ctx: Ctx): Promise<void> {
  const cats = await listCategoriesAdmin();
  const kb = new InlineKeyboard().add(sbtn("➕ New category", cb("adm", "catnew"), "success")).row();
  for (const c of cats) {
    kb.text(`${c.emoji ?? "🗂"} ${c.name.slice(0, 18)} · ${c.productCount}`, cb("adm", "catpick", c.id)).row();
    kb.text("😀", cb("adm", "catemoji", c.id))
      .text("✏️", cb("adm", "catren", c.id))
      .text(c.isActive ? "👁" : "🙈", cb("adm", "cattgl", c.id))
      .text("🗑", cb("adm", "catdel", c.id))
      .row();
  }
  kb.text("◀️ Back", cb("adm", "m_prod"));
  await show(ctx, [
    "🗂 <b>Categories &amp; grouping</b>",
    "",
    "Customers see these as a grid of tiles under <b>🗂 Shop by Category</b>.",
    "",
    "Tap a category to <b>bulk-assign products</b> to it. Per row: 😀 tile emoji · ✏️ rename · 👁/🙈 show or hide the tile · 🗑 delete.",
    "",
    cats.length === 0 ? "None yet — tap ➕ New category." : `<i>${cats.length} categories. Deleting one moves its products to Uncategorized, never deletes them.</i>`,
  ].join("\n"), kb, true);
}

/** Bulk categoriser: tick products, then move them all into the target category. */
async function categoriseView(ctx: Ctx): Promise<void> {
  const target = ctx.session.catTarget ?? "";
  const cats = await listCategoriesAdmin();
  const cat = cats.find((c) => c.id === target);
  const filter = ctx.session.catFilter ?? "none";
  const r = await listProductsForCategorising({ page: ctx.session.catPage ?? 1, pageSize: 12, filter, search: ctx.session.catSearch });
  const sel = new Set(ctx.session.catSelected ?? []);
  const kb = new InlineKeyboard();

  kb.text(filter === "none" ? "• Uncategorised •" : "Uncategorised", cb("adm", "catfil", "none"))
    .text(filter === "all" ? "• All •" : "All", cb("adm", "catfil", "all"))
    .text(filter === target ? "• In this one •" : "In this one", cb("adm", "catfil", target))
    .row();

  for (const p of r.items) {
    const box = sel.has(p.id) ? "☑️" : "⬜";
    const where = p.categoryName ? ` · ${p.categoryName.slice(0, 10)}` : "";
    kb.text(`${box} ${p.visible ? "👁" : "🙈"} ${p.name.slice(0, 24)}${where}`, cb("adm", "cattog", p.id)).row();
  }
  if (r.pages > 1) {
    if (r.page > 1) kb.text("◀️", cb("adm", "catpg", String(r.page - 1)));
    kb.text(`${r.page}/${r.pages}`, cb("mnu", "noop"));
    if (r.page < r.pages) kb.text("▶️", cb("adm", "catpg", String(r.page + 1)));
    kb.row();
  }
  kb.text("☑️ This page", cb("adm", "catpage")).text(`☑️ All ${r.total}`, cb("adm", "catall"));
  if (sel.size > 0) kb.text("✖️ Clear", cb("adm", "catclr"));
  kb.row();
  kb.text("🔍 Search", cb("adm", "catsearch")).row();
  if (sel.size > 0) {
    kb.add(sbtn(`🗂 Move ${sel.size} into “${(cat?.name ?? "").slice(0, 14)}”`, cb("adm", "catmove"), "success")).row();
  }
  kb.text("◀️ Categories", cb("adm", "cats"));

  await show(ctx, [
    `🗂 <b>Add products to “${escapeHtml(cat?.name ?? "?")}”</b>`,
    `${r.total} product(s) in this view${ctx.session.catSearch ? ` · search: “${escapeHtml(ctx.session.catSearch)}”` : ""}`,
    sel.size > 0 ? `☑️ <b>${sel.size} selected</b>` : "",
    "",
    "Tick products, then tap Move. Ticks survive paging, filtering and searching.",
  ].filter(Boolean).join("\n"), kb, true);
}

async function ticketsListView(ctx: Ctx): Promise<void> {
  const [rows, open] = await Promise.all([adminListTickets({ limit: 15 }), openTicketCount()]);
  const kb = new InlineKeyboard();
  for (const t of rows) {
    const dot = t.waitingOnUs ? "🔴" : "🟡";
    kb.text(`${dot} ${t.ticketNumber} · ${t.who.slice(0, 12)} · ${t.subject.slice(0, 20)}${t.hasItem ? " 📦" : ""}`, cb("adm", "tk", t.id)).row();
  }
  kb.text("◀️ Back", cb("adm", "m_orders"));
  await show(
    ctx,
    rows.length === 0
      ? "🎫 <b>Support Tickets</b>\n\n✅ Nothing waiting. Good work."
      : [
          "🎫 <b>Support Tickets</b>",
          `📬 Open: <b>${open}</b>`,
          "",
          "🔴 = waiting on us   🟡 = waiting on the customer   📦 = about a delivered item",
        ].join("\n"),
    kb,
    true,
  );
}

async function ticketDetailView(ctx: Ctx, ticketId: string): Promise<void> {
  const t = await adminGetTicket(ticketId);
  if (!t) { await show(ctx, "🎫 Ticket not found.", new InlineKeyboard().text("◀️ Back", cb("adm", "tks")), true); return; }
  const kb = new InlineKeyboard();
  kb.add(sbtn("💬 Reply", cb("adm", "tkre", t.id), "success")).row();
  // Only offered when the ticket is tied to a delivered item — this is how support
  // grants an out-of-warranty replacement, by choice rather than automatically.
  if (t.orderItemId) kb.add(sbtn("🔄 Issue replacement", cb("adm", "tkrepl", t.id), "success")).row();
  const pic = [...t.messages].reverse().find((m) => m.proofFileId);
  if (pic) kb.add(sbtn("📷 View screenshot", cb("adm", "tkpic", pic.id), "primary")).row();
  if (t.status !== "RESOLVED") kb.add(sbtn("✅ Resolve", cb("adm", "tkres", t.id), "primary"));
  if (t.status !== "CLOSED") kb.add(sbtn("🔒 Close", cb("adm", "tkcls", t.id), "danger"));
  kb.row().text("◀️ Back", cb("adm", "tks"));
  const label: Record<string, string> = { CUSTOMER: "🧑 Customer", ADMIN: "🎧 You", SYSTEM: "⚙️" };
  await show(
    ctx,
    [
      `🎫 <b>${t.ticketNumber}</b> · ${t.status.replace(/_/g, " ")}`,
      `👤 ${escapeHtml(t.who)}  🆔 <code>${escapeHtml(t.telegramId)}</code>`,
      ...(t.itemLabel ? [`📦 ${escapeHtml(t.itemLabel)}${t.orderNumber ? ` · ${escapeHtml(t.orderNumber)}` : ""}`] : []),
      "",
      ...t.messages.slice(-10).map((m) =>
        `${label[m.authorType] ?? ""} <i>${m.createdAt.toISOString().slice(5, 16).replace("T", " ")}</i>\n${escapeHtml(m.body).slice(0, 500)}${m.proofFileId ? "\n📷 <i>screenshot</i>" : ""}\n`,
      ),
    ].join("\n"),
    kb,
    true,
  );
}

async function replacementsListView(ctx: Ctx): Promise<void> {
  const rows = await listReplacementRequests("PENDING", 15);
  const kb = new InlineKeyboard();
  for (const r of rows) kb.text(`🔄 ${r.who} · ${r.label.slice(0, 22)} · ${r.orderNumber}`, cb("adm", "rrview", r.id)).row();
  kb.text("◀️ Back", cb("adm", "m_orders"));
  await show(ctx, rows.length
    ? `🔄 <b>Replacement requests</b> (${rows.length} pending)\nTap one to review the screenshot and approve.`
    : "🔄 <b>Replacement requests</b>\n\n✅ Nothing pending — all caught up.", kb, true);
}

async function replacementDetailView(ctx: Ctx, id: string): Promise<void> {
  const r = await getReplacementRequest(id);
  if (!r) { await ctx.reply("Request not found."); return replacementsListView(ctx); }
  const kb = new InlineKeyboard();
  if (r.proofFileId) kb.add(sbtn("📷 View screenshot", cb("adm", "rrpic", r.id), "primary")).row();
  if (r.status === "PENDING") {
    kb.add(sbtn("✅ Approve & replace", cb("adm", "rrok", r.id), "success")).row();
    kb.add(sbtn("❌ Reject", cb("adm", "rrno", r.id), "danger")).row();
  }
  kb.text("◀️ Back", cb("adm", "reps"));
  await show(ctx, [
    `🔄 <b>Replacement request</b>`,
    `👤 ${escapeHtml(r.who)}  🆔 <code>${r.telegramId || "—"}</code>`,
    `📦 ${escapeHtml(r.label)}`,
    `🧾 ${r.orderNumber}`,
    `📌 Status: <b>${r.status}</b>`,
    "",
    `💬 ${escapeHtml(r.reason)}`,
    r.proofFileId ? "" : "\n⚠️ No screenshot was submitted.",
  ].join("\n"), kb, true);
}

/**
 * Bulk picker for a supplier's products.
 *
 * Paged and multi-select. The old screen listed the first 30 with no paging and no
 * selection, so a vendor's 200th product was simply unreachable — you could not
 * hide what you could not see.
 */
const SUP_PAGE_SIZE = 12;

/** Quick-mode label — on the deleted tab a tap restores rather than publishes. */
function deletedTabLabel(only: string): string {
  return only === "deleted" ? "⚡ Tapping = restore instantly" : "⚡ Tapping = publish/hide instantly";
}

/** The rows currently on screen, so an index in callback data can be resolved back to an id. */
async function supplierPageIds(ctx: Ctx, supplierId: string): Promise<string[]> {
  return supplierProductIdsOnPage(supplierId, {
    page: ctx.session.supPage ?? 1,
    pageSize: SUP_PAGE_SIZE,
    only: ctx.session.supFilter ?? "all",
  });
}

async function supplierProductsView(ctx: Ctx, supplierId: string): Promise<void> {
  const only = ctx.session.supFilter ?? "all";
  const quick = ctx.session.supMode === "quick";
  const page = ctx.session.supPage ?? 1;
  const sel = new Set(ctx.session.supSelected ?? []);
  const [r, counts, newVis] = await Promise.all([
    listSupplierProducts(supplierId, { page, pageSize: SUP_PAGE_SIZE, only }),
    countSupplierProductStates(supplierId),
    getSupplierNewVisible(supplierId),
  ]);
  const flash = ctx.session.supFlash;
  // listSupplierProducts clamps the page to the available range. Write the
  // clamped value back, otherwise a session stuck on page 5 of a list that
  // shrank to 2 pages keeps re-clamping on every render.
  ctx.session.supPage = r.page;
  ctx.session.supFlash = undefined;
  const confirm = ctx.session.supConfirm;
  ctx.session.supConfirm = undefined;
  const kb = new InlineKeyboard();

  // Nothing imported yet — offer the one button that actually helps.
  if (counts.shown + counts.hidden + counts.deleted === 0) {
    kb.add(sbtn("🔄 Sync catalog now", cb("adm", "supsync", supplierId), "success")).row();
    kb.text("◀️ Back", cb("adm", "sups"));
    await show(ctx, [
      "📂 <b>Supplier products</b>",
      "",
      "Nothing imported yet. Tap 🔄 <b>Sync catalog</b> to pull this vendor's products in.",
      "",
      "They arrive <b>hidden</b> — nothing reaches your shop until you publish it here.",
    ].join("\n"), kb, true);
    return;
  }

  // ── Confirmation gate for the irreversible-looking action ──
  if (confirm === "delete" && sel.size > 0) {
    kb.add(sbtn(`🗑 Yes, delete ${sel.size}`, cb("adm", "spdo", `${supplierId}~delete`), "danger")).row();
    kb.text("✖️ Cancel", cb("adm", "supprods", supplierId));
    await show(ctx, [
      `🗑 <b>Delete ${sel.size} product(s)?</b>`,
      "",
      "They come out of the shop and stop being re-imported by future syncs.",
      "",
      "Existing orders keep their full history, and you can bring them back from the 🗑 <b>Deleted</b> tab.",
    ].join("\n"), kb, true);
    return;
  }

  // ── Filter tabs ──
  const f = (label: string, key: "all" | "visible" | "hidden" | "deleted") =>
    kb.text(only === key ? `• ${label} •` : label, cb("adm", "spfil", `${supplierId}~${key}`));
  f("All", "all"); f(`👁 ${counts.shown}`, "visible"); f(`🙈 ${counts.hidden}`, "hidden");
  if (counts.deleted > 0) f(`🗑 ${counts.deleted}`, "deleted");
  kb.row();

  // ── Mode switch: one-by-one vs bulk ──
  const quickLabel = deletedTabLabel(only);
  kb.add(sbtn(quick ? quickLabel : "☑️ Tapping = tick for bulk", cb("adm", "spmode", supplierId), quick ? "success" : "primary")).row();

  // ── Product rows. Callback carries the ROW INDEX, not the id: two cuids plus
  // the route overflowed Telegram's 64-byte callback_data limit, and cb() throws
  // on overflow, which would take the whole screen down rather than one button.
  const deletedTab = only === "deleted";
  r.items.forEach((p, i) => {
    // The deleted tab used to render a bare 🗑 for every row, so ticks were
    // invisible while "♻️ Restore N" was driven by those very ticks — you could
    // not see what you were about to restore. In quick mode a tap restores
    // outright, so it shows the action rather than a checkbox.
    const box = sel.has(p.id) ? "☑️" : "⬜";
    const mark = deletedTab
      ? (quick ? "♻️" : `${box} 🗑`)
      : (quick ? (p.visible ? "👁" : "🙈") : `${box} ${p.visible ? "👁" : "🙈"}`);
    const stock = p.stock === null ? "" : p.stock <= 0 ? " · ⛔️" : ` · ${p.stock}`;
    kb.text(`${mark} ${p.name.slice(0, 24)} · $${(p.priceMinor / 100).toFixed(2)}${stock}`, cb("adm", "sptog", `${supplierId}~${i}`)).row();
  });

  if (r.pages > 1) {
    if (r.page > 1) kb.text("◀️", cb("adm", "sppg", `${supplierId}~${r.page - 1}`));
    kb.text(`${r.page}/${r.pages}`, cb("adm", "supprods", supplierId));
    if (r.page < r.pages) kb.text("▶️", cb("adm", "sppg", `${supplierId}~${r.page + 1}`));
    kb.row();
  }

  if (!quick) {
    kb.text("☑️ This page", cb("adm", "sppage", supplierId)).text(`☑️ All ${r.total}`, cb("adm", "spallsel", supplierId));
    if (sel.size > 0) kb.text("✖️ Clear", cb("adm", "spclr", supplierId));
    kb.row();

    if (sel.size > 0) {
      if (deletedTab) {
        kb.add(sbtn(`♻️ Restore ${sel.size}`, cb("adm", "spdo", `${supplierId}~restore`), "success")).row();
      } else {
        kb.add(
          sbtn(`👁 Publish ${sel.size}`, cb("adm", "spdo", `${supplierId}~show`), "success"),
          sbtn(`🙈 Hide ${sel.size}`, cb("adm", "spdo", `${supplierId}~hide`), "primary"),
        ).row();
        // Routed through spask, not spdo — deleting on a single tap was too easy.
        kb.add(sbtn(`🗑 Delete ${sel.size}`, cb("adm", "spask", `${supplierId}~delete`), "danger")).row();
      }
    }
  }

  // ── Whole-catalogue shortcuts (uncapped) ──
  if (deletedTab) {
    kb.add(sbtn(`♻️ Restore all ${counts.deleted}`, cb("adm", "spall", `${supplierId}~restore`), "success")).row();
  } else {
    kb.add(
      sbtn("👁 Publish every product", cb("adm", "spall", `${supplierId}~show`), "primary"),
      sbtn("🙈 Hide every product", cb("adm", "spall", `${supplierId}~hide`), "danger"),
    ).row();
  }
  kb.add(sbtn(`🆕 New products arrive: ${newVis ? "👁 visible" : "🙈 hidden"}`, cb("adm", "spnewvis", supplierId), newVis ? "success" : "primary")).row();
  kb.text("🔄 Sync", cb("adm", "supsync", supplierId)).text("◀️ Back", cb("adm", "sups"));

  await show(ctx, [
    flash ? `${flash}\n` : "",
    "📂 <b>Supplier products</b>",
    `👁 ${counts.shown} in shop · 🙈 ${counts.hidden} hidden${counts.deleted > 0 ? ` · 🗑 ${counts.deleted} deleted` : ""}`,
    only !== "all" ? `<i>Showing: ${only}</i>` : "",
    sel.size > 0 && !quick ? `☑️ <b>${sel.size} selected</b>` : "",
    "",
    r.total === 0 ? "<i>No products match this filter.</i>\n" : "",
    deletedTab
      ? `These are out of the shop and will not be re-imported by future syncs. Restore brings them back <b>hidden</b>.${quick ? "\n\n⚡ <b>One-by-one:</b> tap any product to restore it immediately." : "\n\n☑️ <b>Bulk:</b> tick products, then tap Restore."}`
      : quick
        ? "⚡ <b>One-by-one:</b> tap any product to publish or hide it immediately."
        : "☑️ <b>Bulk:</b> tap products to tick them, then choose an action. Ticks survive paging and filtering.",
    "",
    newVis
      ? "🆕 New synced products go <b>straight into the shop</b>."
      : "🆕 New synced products arrive <b>hidden</b>, so a big vendor can't flood your shop. Sync still imports everything.",
  ].filter(Boolean).join("\n"), kb, true);
}

function saleTargetKb(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🛍 Open Shop", cb("adm", "ssaletgt", "menu")).text("📦 A product", cb("adm", "ssaletgt", "prod")).row()
    .text("🎯 Today's Deals", cb("adm", "ssaletgt", "deals")).text("🎁 Refer & Earn", cb("adm", "ssaletgt", "refer")).row()
    .text("🎡 Spin & Win", cb("adm", "ssaletgt", "spin")).text("🎯 Missions", cb("adm", "ssaletgt", "mission")).row()
    .text("🏆 My Tier", cb("adm", "ssaletgt", "tier")).text("💳 Add balance", cb("adm", "ssaletgt", "topup")).row()
    .text("🔗 Custom link", cb("adm", "ssaletgt", "url")).text("🚫 No button", cb("adm", "ssaletgt", "none")).row();
}

function saleColourKb(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🟢 Green", cb("adm", "ssalecol", "success")).text("🔵 Blue", cb("adm", "ssalecol", "primary")).text("🔴 Red", cb("adm", "ssalecol", "danger")).row();
}

function saleFinalKb(): InlineKeyboard {
  return new InlineKeyboard()
    .add(sbtn("📣 Announce now", cb("adm", "ssalego", "now"), "success")).row()
    .text("⏰ Auto — daily", cb("adm", "ssalego", "daily")).text("⏰ Auto — weekly", cb("adm", "ssalego", "weekly")).row()
    .text("✖️ Cancel", cb("adm", "home"));
}

function buildSaleBody(d: NonNullable<Ctx["session"]["saleDraft"]>): string {
  const lines = [d.title ?? "🎉 <b>Special Sale</b>"];
  if (d.body) lines.push("", d.body);
  if (d.endsHours && d.endsHours > 0) lines.push("", `⏳ <b>Hurry — offer ends in ${d.endsHours}h!</b>`);
  return lines.join("\n");
}

async function runSpecialSale(ctx: Ctx, mode: "now" | "daily" | "weekly"): Promise<void> {
  const d = ctx.session.saleDraft;
  if (!d?.title) { await ctx.reply("Sale draft expired — start again."); return sendPanel(ctx, false); }
  const body = buildSaleBody(d);
  const common = { title: "", body, bodyIsHtml: true, segment: "all" as const, buttonText: d.btnText, buttonUrl: d.btnUrl, buttonStyle: d.btnStyle, createdById: "bot-admin" };
  ctx.session.saleDraft = undefined;
  if (mode === "now") {
    const r = await sendBroadcast(common);
    await ctx.reply(`📣 Special sale announced to ${r.targets} users. 🎉`);
  } else {
    await scheduleBroadcast({ ...common, scheduledAt: new Date(Date.now() + 60_000), recurrence: mode });
    await ctx.reply(`⏰ Special sale scheduled to auto-announce <b>${mode}</b> (starting shortly). 🎉`, { parse_mode: "HTML" });
  }
  await sendPanel(ctx, false);
}

async function maintenanceView(ctx: Ctx): Promise<void> {
  const m = await getMaintenance();
  const kb = new InlineKeyboard()
    .add(
      m.enabled
        ? sbtn("✅ Reopen the shop", cb("adm", "maintoff"), "success")
        : sbtn("🛠 Close the shop", cb("adm", "mainton"), "danger"),
    ).row()
    .text("✏️ Edit the closed message", cb("adm", "maintmsg")).row()
    .text("◀️ Back", cb("adm", "m_sec"));
  await show(ctx, [
    "🛠 <b>Maintenance Mode</b>",
    "",
    m.enabled
      ? "🔴 <b>The shop is CLOSED.</b> Customers see the message below and can't browse, order or pay."
      : "🟢 <b>The shop is OPEN.</b> Everything works normally.",
    "",
    "<b>Customers currently see:</b>",
    m.message,
    "",
    "<i>You keep full access while it's closed — admins bypass the gate, so you can always reopen from here.</i>",
  ].join("\n"), kb, true);
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
    case "maint": return maintenanceView(ctx);
    case "mainton": {
      await setMaintenance(true);
      flash(ctx, "🛠 <b>Shop closed.</b> Customers now see the maintenance message. You still have full access.");
      return maintenanceView(ctx);
    }
    case "maintoff": {
      await setMaintenance(false);
      flash(ctx, "✅ <b>Shop reopened.</b> Customers can browse and order again.");
      return maintenanceView(ctx);
    }
    case "maintmsg":
      ctx.session.awaiting = "maint_msg";
      await askStep(ctx, "✏️ Send the message customers should see while the shop is closed.\n\nHTML like <b>bold</b> is allowed.");
      return;
    // m_money was missing from this list while MENUS defined its rows and six
    // buttons pointed at it, so 💰 Money fell through to the default and did
    // nothing — including four "◀️ Back" buttons that dead-ended there.
    case "m_money":
    case "m_prod": case "m_orders": case "m_stats": case "m_pay": case "m_mkt": case "m_content": case "m_sec": case "m_tools":
      await showSubmenu(ctx, `m_${action.slice(2)}`);
      return;
    case "ssale":
      ctx.session.saleDraft = {};
      ctx.session.awaiting = "sale_title";
      await askStep(ctx, "🎉 <b>Special Sale</b>\nStep 1 — send the <b>title/headline</b> (premium emoji OK):");
      return;
    case "ssaletgt": {
      const d = ctx.session.saleDraft ?? {};
      if (id === "none") { ctx.session.saleDraft = { ...d, btnText: undefined, btnUrl: undefined }; ctx.session.awaiting = "sale_timer"; await askStep(ctx, "⏳ Send a countdown in <b>hours</b> (e.g. 24), or <code>-</code> to skip:"); return; }
      // Any in-bot section can be the button target via a start deep link.
      const sections: Record<string, string> = { menu: "shop", deals: "deals", refer: "refer", spin: "spin", mission: "mission", tier: "tier", topup: "topup" };
      if (sections[id]) {
        ctx.session.saleDraft = { ...d, btnUrl: `https://t.me/${ctx.me.username}?start=${sections[id]}` };
        ctx.session.awaiting = "sale_btntext";
        await askStep(ctx, "Send the <b>button label</b> (e.g. 🎁 Refer &amp; earn now):");
        return;
      }
      if (id === "url") { ctx.session.awaiting = "sale_url"; await askStep(ctx, "🔗 Send the full <b>URL</b> the button should open:"); return; }
      if (id === "prod") { await show(ctx, "📦 Pick the product to link:", await (async () => { const kb = new InlineKeyboard(); const ps = await listProductsBrief(30); for (const pr of ps) kb.text(`${pr.iconEmoji ? pr.iconEmoji + " " : ""}${pr.name.slice(0, 30)}`, cb("adm", "ssaleprod", pr.id)).row(); kb.text("◀️ Back", cb("adm", "home")); return kb; })(), true); return; }
      return;
    }
    case "ssaleprod": {
      const pr = await getProductBriefById(id);
      ctx.session.saleDraft = { ...(ctx.session.saleDraft ?? {}), btnUrl: pr ? `https://t.me/${ctx.me.username}?start=p_${pr.slug}` : undefined };
      ctx.session.awaiting = "sale_btntext";
      await askStep(ctx, "Send the <b>button label</b> (e.g. ⚡ Grab the deal):");
      return;
    }
    case "ssalecol":
      ctx.session.saleDraft = { ...(ctx.session.saleDraft ?? {}), btnStyle: id };
      ctx.session.awaiting = "sale_timer";
      await askStep(ctx, "⏳ Send a countdown in <b>hours</b> (e.g. 24), or <code>-</code> to skip:");
      return;
    case "ssalego": return runSpecialSale(ctx, (id === "daily" || id === "weekly" ? id : "now"));
    case "flashhead": {
      const cur = (await getFlashHeadline()).trim();
      ctx.session.awaiting = "admin_flash_headline";
      await askStep(ctx, ["🔥 <b>Flash sale headline</b>", "The hook shown at the top of every flash-sale announcement (premium emoji OK).", cur ? `\nCurrent:\n${cur}` : "\nUsing the default hook.", "\nSend a new headline, or <code>-</code> to reset to default."].join("\n"));
      return;
    }
    case "m_users": return usersMenuView(ctx);
    case "uview": return usersListView(ctx);
    case "uinfo": return userDetailView(ctx, id);
    case "logs": return logsMenuView(ctx);
    case "logv": return logsView(ctx, id);
    case "logclr": {
      await clearLogs((id || "error") as LogChannel);
      flash(ctx, "🧹 Cleared.");
      return logsMenuView(ctx);
    }
    case "loy": {
      const tiers = await getTiers();
      const kb = new InlineKeyboard()
        .add(sbtn("✏️ Edit tiers", cb("adm", "loyedit"), "primary")).row()
        .text("◀️ Back", cb("adm", "m_users"));
      await show(ctx, [
        "🏆 <b>Loyalty Tiers</b>",
        "",
        "Tiers are calculated from each customer's real lifetime spend on completed orders, and they are told when they level up.",
        "",
        ...tiers.map((t) => `<b>${escapeHtml(t.name)}</b> — from <b>${(t.minSpendMinor / 100).toFixed(2)}</b> · ${escapeHtml(t.perk)}`),
        "",
        "<i>Send gifts from 🎁 Gifts — the bot notifies the customer and you deliver by hand.</i>",
      ].join("\n"), kb, true);
      return;
    }
    case "loyedit":
      ctx.session.awaiting = "admin_loy_tiers";
      await askStep(ctx, [
        "✏️ <b>Edit tiers</b> — one per line as <code>Name | minimum spend | perk</code>",
        "",
        "Example:",
        "<code>Bronze | 0 | Member pricing</code>",
        "<code>Silver | 50 | Priority support</code>",
        "<code>Gold | 250 | Priority support + gifts</code>",
      ].join("\n"));
      return;
    case "gifts": {
      const rows = await listGifts("PENDING", 12);
      const kb = new InlineKeyboard().add(sbtn("🎁 Send a gift", cb("adm", "giftnew"), "success")).row();
      for (const g of rows) kb.text(`✅ Mark delivered — ${g.who.slice(0, 14)} · ${g.title.slice(0, 16)}`, cb("adm", "giftdone", g.id)).row();
      kb.text("◀️ Back", cb("adm", "m_users"));
      await show(ctx, [
        "🎁 <b>Gifts</b>",
        rows.length ? `🕐 <b>${rows.length}</b> waiting for you to deliver` : "✅ Nothing pending",
        "",
        ...rows.flatMap((g) => [`🎁 <b>${escapeHtml(g.title)}</b> → ${escapeHtml(g.who)}${g.tier ? ` (${g.tier})` : ""}`, g.detail ? `   <i>${escapeHtml(g.detail).slice(0, 120)}</i>` : ""]),
        "",
        "<i>The customer has already been notified. Send the gift yourself, then mark it delivered.</i>",
      ].filter((l) => l !== "").join("\n"), kb, true);
      return;
    }
    case "giftnew":
      ctx.session.awaiting = "admin_gift_user";
      await askStep(ctx, "🎁 Send the customer's <b>@username</b> or <b>Telegram ID</b>:");
      return;
    case "giftdone": {
      const ok = await markGiftDelivered(id, "bot-admin");
      await ctx.reply(ok ? "✅ Marked delivered — the customer has been told." : "Couldn't update that gift.");
      return handleAdminCallback(ctx, "gifts", []);
    }
    case "spncfg": {
      const [cfg, st] = await Promise.all([getSpinConfig(), spinStats()]);
      const kb = new InlineKeyboard()
        .add(sbtn(cfg.enabled ? "✅ ON — turn off" : "🚫 OFF — turn on", cb("adm", "spntog"), cfg.enabled ? "success" : "danger")).row()
        .add(sbtn("🎯 Minimum to win", cb("adm", "spnmin"), "primary"), sbtn("🎁 Max reward", cb("adm", "spnmax"), "primary")).row()
        .add(sbtn("🔁 Spins per day", cb("adm", "spnday"), "primary")).row()
        .add(sbtn("🎯 Challenge amounts", cb("adm", "spntgt"), "primary"), sbtn("⏳ Days to finish", cb("adm", "spnexp"), "primary")).row()
        .text("◀️ Back", cb("adm", "m_users"));
      await show(ctx, [
        "🎡 <b>Spin &amp; Win</b>",
        `Status: <b>${cfg.enabled ? "ON" : "OFF"}</b>`,
        "",
        "A spin assigns a <b>spend challenge</b>. When the customer reaches it, the reward is credited to their wallet automatically.",
        "",
        "<b>One spin per purchase</b>:",
        `• orders under <b>${(cfg.minSpendMinor / 100).toFixed(2)}</b> → “better luck next time”`,
        `• otherwise a random <b>0.01%–${(cfg.rewardBp / 100).toFixed(1)}%</b> of the order, capped at <b>${(cfg.maxRewardMinor / 100).toFixed(2)}</b>`,
        `• at most <b>${cfg.maxSpinsPerDay}</b> spins per customer per day`,
        "",
        `🎯 Legacy challenge amounts: ${cfg.targetsMinor.map((t) => `<b>${(t / 100).toFixed(2)}</b>`).join(" · ")}`,
        `🎁 Reward: <b>${(cfg.rewardBp / 100).toFixed(1)}%</b> of the amount (hard-capped at <b>${(REWARD_CAP_BP / 100).toFixed(0)}%</b> in code)`,
        `⏳ Time to finish: <b>${cfg.expiryDays}</b> days`,
        "",
        `📊 Active: <b>${st.active}</b> · Completed: <b>${st.completed}</b> · Paid out: <b>${(st.paidMinor / 100).toFixed(2)}</b>`,
        "",
        "<i>Only spend AFTER the spin counts, verified from completed orders. Each reward is credited once.</i>",
      ].join("\n"), kb, true);
      return;
    }
    case "spntog": {
      const cfg = await getSpinConfig();
      const n = await setSpinConfig({ enabled: !cfg.enabled });
      await ctx.reply(n.enabled ? "🎡 Spin & Win is ON — customers can spin from My Account." : "🚫 Spin & Win is OFF.");
      return handleAdminCallback(ctx, "spncfg", []);
    }
    case "promo": {
      const f = await getPromoFlags();
      const row = (k: string, label: string, on: boolean) => sbtn(`${on ? "✅" : "🚫"} ${label}`, cb("adm", "promotog", k), on ? "success" : "danger");
      const kb = new InlineKeyboard()
        .add(row("spin", "Spin & Win", f.spin)).row()
        .add(row("referral", "Referral rewards", f.referral)).row()
        .add(row("loyalty", "Loyalty tiers & gifts", f.loyalty)).row()
        .add(row("cashback", "Cashback", f.cashback)).row()
        .text("◀️ Back", cb("adm", "m_users"));
      await show(ctx, [
        "🎚 <b>Reward Promotions</b>",
        "",
        "Switch any programme off instantly — no deploy needed.",
        "",
        "<i>Turning one off stops the PAYOUT, not just the button. Anything already credited stays credited.</i>",
      ].join("\n"), kb, true);
      return;
    }
    case "promotog": {
      const key = (id || "spin") as "spin" | "referral" | "loyalty" | "cashback";
      const f = await getPromoFlags();
      const next = await setPromoFlag(key, !f[key]);
      await ctx.answerCallbackQuery({ text: next[key] ? "Turned on" : "Turned off" }).catch(() => undefined);
      return handleAdminCallback(ctx, "promo", []);
    }
    case "spnday":
      ctx.session.awaiting = "admin_spn_day";
      await askStep(ctx, "🔁 How many spins may one customer take per day? (e.g. <code>3</code>)");
      return;
    case "spnmin":
      ctx.session.awaiting = "admin_spn_min";
      await askStep(ctx, "🎯 Orders <b>below</b> this amount win nothing. Send the amount (e.g. <code>10</code>):");
      return;
    case "spnmax":
      ctx.session.awaiting = "admin_spn_max";
      await askStep(ctx, "🎁 Most a single spin can ever pay. Send the amount (e.g. <code>0.01</code>):");
      return;
    case "spntgt":
      ctx.session.awaiting = "admin_spn_targets";
      await askStep(ctx, "🎯 Send the challenge amounts, comma separated (e.g. <code>50, 100, 250</code>):");
      return;
    case "spnexp":
      ctx.session.awaiting = "admin_spn_days";
      await askStep(ctx, "⏳ How many <b>days</b> does a customer get to finish a challenge? (e.g. <code>14</code>)");
      return;
    case "ufund": return fundedUsersView(ctx);
    case "uhist": return walletHistoryView(ctx, id);
    case "ubnpl":
      ctx.session.userTarget = id; ctx.session.awaiting = "admin_bnpl_user";
      await askStep(ctx, "🕒 Send the <b>BNPL credit limit</b> for this customer (their currency, e.g. <code>50</code>). Send <code>0</code> to remove the limit:");
      return;
    case "ubnplclose": {
      const kb = new InlineKeyboard()
        .add(sbtn("🔒 Close limit only", cb("adm", "ubnpldo", `${id}~keep`), "primary")).row()
        .add(sbtn("🧹 Close + write off what is owed", cb("adm", "ubnpldo", `${id}~off`), "danger")).row()
        .text("◀️ Back", cb("adm", "uinfo", id));
      await show(ctx, [
        "🔒 <b>Close BNPL</b>",
        "",
        "<b>Close limit only</b> — they can't borrow again, but still owe what is outstanding.",
        "<b>Write off</b> — clears the limit AND forgives the outstanding amount. This cannot be undone.",
      ].join("\n"), kb, true);
      return;
    }
    case "ubnpldo": {
      const [uid, mode] = (id || "").split("~");
      if (!uid) return;
      const r = await closeBnpl(uid, mode === "off");
      await ctx.reply(
        r.ok
          ? mode === "off"
            ? `🧹 BNPL closed and <b>${(r.clearedMinor / 100).toFixed(2)}</b> written off.`
            : "🔒 BNPL limit closed. The outstanding amount still stands."
          : "Couldn't update that customer.",
        { parse_mode: "HTML" },
      );
      return userDetailView(ctx, uid);
    }
    case "ulook":
      ctx.session.awaiting = "admin_user_lookup";
      await askStep(ctx, "🔎 Send the customer's @username or Telegram ID:");
      return;
    case "uadd":
      ctx.session.userTarget = id; ctx.session.awaiting = "admin_user_addbal";
      await askStep(ctx, "➕ Amount to <b>add</b> to their wallet (their currency, e.g. 10):");
      return;
    case "udeduct":
      ctx.session.userTarget = id; ctx.session.awaiting = "admin_user_deductbal";
      await askStep(ctx, "➖ Amount to <b>deduct</b> from their wallet (e.g. 10):");
      return;
    case "uban":
      await setUserBanned(id, true);
      flash(ctx, "🚫 User banned — they can no longer use the bot.");
      return userDetailView(ctx, id);
    case "uunban":
      await setUserBanned(id, false);
      flash(ctx, "✅ User unbanned.");
      return userDetailView(ctx, id);
    case "sales": return salesView(ctx);
    case "sups": return suppliersView(ctx);
    case "supadd":
      ctx.session.supDraft = {};
      ctx.session.awaiting = "admin_sup_name";
      await askStep(ctx, "🏭 <b>Add supplier</b>\nStep 1/4 — send a <b>name</b> for this supplier:");
      return;
    case "supprods":
      // A fresh open starts with a clean selection.
      if (ctx.session.supTarget !== id) {
        ctx.session.supSelected = []; ctx.session.supPage = 1; ctx.session.supFilter = "all"; ctx.session.supMode = "select";
      }
      ctx.session.supTarget = id;
      return supplierProductsView(ctx, id);
    case "spmode": {
      ctx.session.supMode = ctx.session.supMode === "quick" ? "select" : "quick";
      if (ctx.session.supMode === "quick") ctx.session.supSelected = [];
      return supplierProductsView(ctx, id);
    }
    case "spfil": {
      const [supId, key] = id.split("~");
      if (!supId) return;
      const prev = ctx.session.supFilter ?? "all";
      const next = key === "visible" || key === "hidden" || key === "deleted" ? key : "all";
      ctx.session.supFilter = next;
      ctx.session.supPage = 1;
      // Ticks survive all ↔ visible ↔ hidden, which is what the view promises.
      // They are only dropped when crossing the deleted boundary: a deleted id
      // carried into Publish/Hide silently matches nothing (those actions filter
      // deletedAt: null), so the admin would tap "Publish 12" and be told 0 were
      // published with no explanation.
      if ((prev === "deleted") !== (next === "deleted")) {
        const had = (ctx.session.supSelected ?? []).length;
        ctx.session.supSelected = [];
        if (had > 0) ctx.session.supFlash = `✖️ Cleared ${had} tick(s) — deleted products need their own actions.`;
      }
      return supplierProductsView(ctx, supId);
    }
    case "sppg": {
      const [supId, pg] = id.split("~");
      if (supId) { ctx.session.supPage = Math.max(1, Number.parseInt(pg ?? "1", 10) || 1); await supplierProductsView(ctx, supId); }
      return;
    }
    case "sppage": {
      // Tick everything on the current page, keeping earlier ticks.
      const ids = await supplierPageIds(ctx, id);
      const cur = new Set(ctx.session.supSelected ?? []);
      const allOn = ids.length > 0 && ids.every((x) => cur.has(x));
      for (const x of ids) { if (allOn) cur.delete(x); else cur.add(x); }
      ctx.session.supSelected = [...cur].slice(0, 500);
      ctx.session.supFlash = allOn ? "✖️ Page cleared." : `☑️ Selected ${ids.length} on this page.`;
      return supplierProductsView(ctx, id);
    }
    case "spallsel": {
      const ids = await supplierProductIdsAll(id, ctx.session.supFilter ?? "all");
      const cur = new Set(ctx.session.supSelected ?? []);
      // Compare membership, not counts: ticks from another filter made the old
      // length check clear the selection when it should have extended it.
      const allOn = ids.length > 0 && ids.every((x) => cur.has(x));
      ctx.session.supSelected = allOn ? [] : ids;
      ctx.session.supFlash = allOn
        ? "✖️ Selection cleared."
        : `☑️ Selected ${ids.length}.${ids.length >= 500 ? " (capped at 500 — use the “every product” buttons for the whole catalogue.)" : ""}`;
      return supplierProductsView(ctx, id);
    }
    case "spclr":
      ctx.session.supSelected = [];
      ctx.session.supFlash = "✖️ Selection cleared.";
      return supplierProductsView(ctx, id);
    case "spask": {
      // Stage a destructive action so the view can render a confirmation.
      const [supId, act] = id.split("~");
      if (!supId) return;
      if ((ctx.session.supSelected ?? []).length === 0) {
        ctx.session.supFlash = "⚠️ Nothing selected.";
        return supplierProductsView(ctx, supId);
      }
      ctx.session.supConfirm = act;
      return supplierProductsView(ctx, supId);
    }
    case "spdo": {
      const [supId, action] = id.split("~");
      const act = action === "show" || action === "hide" || action === "delete" || action === "restore" ? action : null;
      if (!supId || !act) return;
      const ids = ctx.session.supSelected ?? [];
      if (ids.length === 0) {
        ctx.session.supFlash = "⚠️ Nothing selected.";
        return supplierProductsView(ctx, supId);
      }
      const n = await bulkSupplierProducts(supId, ids, act);
      ctx.session.supSelected = [];
      ctx.session.supFlash =
        act === "show" ? `👁 <b>${n} product(s) published</b> — live in your shop now.`
        : act === "hide" ? `🙈 <b>${n} product(s) hidden.</b> Sync won't put them back.`
        : act === "restore" ? `♻️ <b>${n} product(s) restored</b> — hidden, ready to publish.`
        : `🗑 <b>${n} product(s) deleted.</b> Orders keep their history; restore from the 🗑 tab.`;
      return supplierProductsView(ctx, supId);
    }
    case "spnewvis": {
      const next = !(await getSupplierNewVisible(id));
      await setSupplierNewVisible(id, next);
      ctx.session.supFlash = next
        ? "🆕 New synced products will now go <b>straight into the shop</b>."
        : "🆕 New synced products will now arrive <b>hidden</b>.";
      return supplierProductsView(ctx, id);
    }
    case "spall": {
      const [supId, act] = id.split("~");
      if (!supId) return;
      const a = act === "show" || act === "hide" || act === "restore" ? act : null;
      if (!a) return;
      const n = await bulkAllSupplierProducts(supId, a);
      ctx.session.supSelected = [];
      ctx.session.supFlash =
        a === "show" ? `👁 <b>${n} product(s) published.</b>`
        : a === "hide" ? `🙈 <b>${n} product(s) hidden.</b>`
        : `♻️ <b>${n} product(s) restored</b> — hidden, ready to publish.`;
      return supplierProductsView(ctx, supId);
    }
    case "sptog": {
      const [supId, idxRaw] = id.split("~");
      if (!supId || idxRaw === undefined) return;
      const idx = Number.parseInt(idxRaw, 10);
      if (!Number.isInteger(idx) || idx < 0) return;
      // Resolve the row index against the page as it is RIGHT NOW, so a list that
      // shifted under the admin can't flip the wrong product.
      const page = await listSupplierProducts(supId, {
        page: ctx.session.supPage ?? 1,
        pageSize: SUP_PAGE_SIZE,
        only: ctx.session.supFilter ?? "all",
      });
      const row = page.items[idx];
      if (!row) {
        ctx.session.supFlash = "⚠️ That list moved on — refreshed it for you.";
        return supplierProductsView(ctx, supId);
      }
      if (ctx.session.supMode === "quick") {
        // One-by-one. On the deleted tab the meaningful single action is restore;
        // it previously fell through to ticking a checkbox that was neither
        // visible nor usable, because quick mode hides the bulk action buttons.
        if (ctx.session.supFilter === "deleted") {
          await bulkSupplierProducts(supId, [row.id], "restore");
          ctx.session.supFlash = `♻️ <b>${escapeHtml(row.name.slice(0, 40))}</b> restored — hidden, ready to publish.`;
          return supplierProductsView(ctx, supId);
        }
        const makeVisible = !row.visible;
        await bulkSupplierProducts(supId, [row.id], makeVisible ? "show" : "hide");
        ctx.session.supFlash = `${makeVisible ? "👁" : "🙈"} <b>${escapeHtml(row.name.slice(0, 40))}</b> ${makeVisible ? "published" : "hidden"}.`;
        return supplierProductsView(ctx, supId);
      }
      // Bulk mode: ticks a checkbox — it does not flip visibility on its own.
      const cur = new Set(ctx.session.supSelected ?? []);
      if (cur.has(row.id)) cur.delete(row.id); else cur.add(row.id);
      ctx.session.supSelected = [...cur].slice(0, 500);
      return supplierProductsView(ctx, supId);
    }
    case "supsync": {
      await ctx.reply("🔄 Syncing catalog…");
      const r = await syncSupplierProducts(id).catch((e) =>
        ({ added: 0, updated: 0, skipped: 0, failed: 0, err: String(e) }) as SyncResult & { err?: string });
      if (r.busy) {
        flash(ctx, "⏳ A sync is already running for this supplier — waiting for it to finish. Tapping 🔄 again won't speed it up.");
        return suppliersView(ctx);
      }
      if ("err" in r && r.err) {
        await ctx.reply(`❌ Sync failed: ${escapeHtml(String(r.err)).slice(0, 200)}`);
        return suppliersView(ctx);
      }
      if (r.added + r.updated + r.skipped === 0) {
        flash(ctx, "ℹ️ Synced — nothing imported.\n\nUsually the base URL or key is wrong. Tap 🔎 <b>Auto-find docs</b>, or 🔍 <b>Diagnose</b> to see the raw response.");
        return suppliersView(ctx);
      }
      const goLive = await getSupplierNewVisible(id);
      const kb = new InlineKeyboard()
        .add(sbtn(`📂 Review ${r.added > 0 ? `${r.added} new ` : ""}product(s)`, cb("adm", "supprods", id), "success")).row()
        .text("◀️ Suppliers", cb("adm", "sups"));
      await show(ctx, [
        "✅ <b>Sync complete</b>",
        "",
        `• ➕ ${r.added} added`,
        `• ♻️ ${r.updated} updated`,
        r.skipped > 0 ? `• 🗑 ${r.skipped} skipped (you deleted these)` : "",
        r.failed > 0 ? `• ⚠️ ${r.failed} could not be imported — see 🩺 Logs → Supplier` : "",
        "",
        r.added > 0 && !goLive
          ? "The new products are <b>hidden</b>. Nothing is in your shop until you publish it — open the review list and pick what goes live, one by one or in bulk."
          : r.added > 0
            ? "⚠️ This supplier is set to publish new products <b>immediately</b>, so they are already live. Change that in the review list."
            : "Nothing new this time.",
      ].filter(Boolean).join("\n"), kb, false);
      return;
    }
    case "supauto": {
      await ctx.reply("🔎 Looking for this supplier's documentation…");
      const r = await autoFetchSupplierDocs(id);
      await ctx.reply(r.detail, { parse_mode: "HTML" });
      return sendPanel(ctx, false);
    }
    case "supdocs": {
      ctx.session.supTarget = id;
      ctx.session.awaiting = "admin_sup_docs";
      await askStep(ctx, [
        "📄 <b>Read the supplier's API docs</b>",
        "",
        "Paste either:",
        "• the <b>link</b> to their API documentation, or",
        "• the <b>documentation text</b> itself (copy/paste is fine)",
        "",
        "I'll work out their base URL, auth header, product/order endpoints and field names, save it, then run a live check.",
      ].join("\n"));
      return;
    }
    case "suptest": {
      const r = await testSupplier(id);
      await ctx.reply(r.ok ? `✅ ${escapeHtml(r.detail)}` : `❌ ${escapeHtml(r.detail)}`);
      return;
    }
    case "suprm": {
      // Ask what happens to their products FIRST — deleting the vendor silently
      // used to leave them on sale, unfulfillable, pointing at a dead supplier.
      const c = await countSupplierProducts(id);
      const kb = new InlineKeyboard();
      if (c.total > 0) {
        kb.add(sbtn(`🗑 Remove vendor + delete ${c.total} product(s)`, cb("adm", "suprmx", `${id}~delete`), "danger")).row();
        kb.add(sbtn(`🙈 Remove vendor + hide ${c.total} product(s)`, cb("adm", "suprmx", `${id}~hide`), "primary")).row();
        kb.add(sbtn("📦 Remove vendor, keep products on sale", cb("adm", "suprmx", `${id}~keep`), "primary")).row();
      } else {
        kb.add(sbtn("🗑 Remove vendor", cb("adm", "suprmx", `${id}~delete`), "danger")).row();
      }
      kb.text("✖️ Cancel", cb("adm", "sups"));
      await show(ctx, [
        "🗑 <b>Remove this vendor?</b>",
        "",
        c.total > 0
          ? `They brought in <b>${c.total} product(s)</b>, <b>${c.visible}</b> currently on sale.`
          : "They have no products in your shop.",
        "",
        c.total > 0
          ? [
              "Pick what happens to them:",
              "",
              "🗑 <b>Delete</b> — removed from the shop. Existing orders keep their full history, so nothing is lost.",
              "🙈 <b>Hide</b> — kept but pulled from sale, in case you re-add the vendor.",
              "📦 <b>Keep on sale</b> — they stay listed as manual products. <i>You will have to fulfil them by hand, because the supplier link is gone.</i>",
            ].join("\n")
          : "",
      ].filter(Boolean).join("\n"), kb, true);
      return;
    }
    case "suprmx": {
      const [supId, mode] = id.split("~");
      const m = mode === "hide" || mode === "keep" || mode === "delete" ? mode : "delete";
      if (!supId) return;
      const r = await removeSupplier(supId, m);
      await ctx.answerCallbackQuery().catch(() => undefined);
      await ctx.reply(
        m === "delete" ? `🗑 Vendor removed and ${r.affected} product(s) taken out of the shop.`
        : m === "hide" ? `🗑 Vendor removed. ${r.affected} product(s) hidden and unlinked.`
        : `🗑 Vendor removed. ${r.affected} product(s) stay on sale as manual products — you fulfil those by hand now.`,
      );
      return suppliersView(ctx);
    }
    case "supbuy": {
      const r = await fulfillFromSupplier(id);
      await ctx.reply(r.ok ? "🤖 Bought from supplier and delivered to the customer. ✅" : `❌ Supplier fulfilment failed (${r.reason ?? "error"}). Deliver manually or check the supplier.`);
      return;
    }
    case "dm":
      ctx.session.dmTarget = id;
      ctx.session.awaiting = "admin_dm_reply";
      await askStep(ctx, "↩️ Type your reply — it will be sent to the customer as a Support message:");
      return;
    case "emoji": return emojiRegistryView(ctx);
    case "delnote": {
      const cur = (await getDeliveryInstructions()).trim();
      ctx.session.awaiting = "admin_delivery_note";
      await askStep(ctx, [
        "📋 <b>Post-delivery instructions</b>",
        "This message is sent to the customer after <b>every</b> order delivery (all products).",
        cur ? `\nCurrent:\n${cur}` : "\nNone set yet.",
        "\nSend the new instructions (premium emoji OK), or send <code>-</code> to clear.",
      ].join("\n"));
      return;
    }
    case "emojiadd":
      ctx.session.awaiting = "admin_emoji_capture";
      await askStep(ctx, "🎨 Send <b>one premium emoji</b> (from your Telegram Premium keyboard). I'll capture it.");
      return;
    case "emojirm":
      await removeCustomEmojiEntry(id);
      setDynamicEmojis(await getCustomEmojiRegistry());
      flash(ctx, `✖️ Removed <b>${escapeHtml(id)}</b>.`);
      return emojiRegistryView(ctx);
    case "bnpl":
      ctx.session.awaiting = "admin_bnpl";
      await askStep(ctx, "🕒 Set a customer's <b>Pay Later (BNPL) limit</b>.\nSend: <code>&lt;@user or id&gt; &lt;amount&gt;</code> in their currency.\nExample: <code>@john 50</code> (or <code>0</code> to disable).");
      return;
    case "refrates": return refRatesView(ctx);
    case "refset":
      ctx.session.awaiting = id === "repeat" ? "admin_ref_repeat" : "admin_ref_first";
      await askStep(ctx, `🎁 Send the new <b>${id === "repeat" ? "repeat" : "first-purchase"}</b> referral reward percentage (e.g. <code>${id === "repeat" ? "2" : "5"}</code>). Send <code>0</code> to disable.`);
      return;
    case "refund": {
      const r = await adminRefundOrder(id, String(ctx.from?.id ?? ""));
      if (r.ok) await ctx.reply(r.refundedMinor ? `↩️ Refunded ${fmt(r.refundedMinor, r.currency ?? "USD")} to the customer's wallet.` : "↩️ Order marked refunded (nothing was paid).");
      else await ctx.reply(r.reason === "ALREADY" ? "Already refunded/cancelled." : "Order not found.");
      return orderView(ctx, id);
    }
    case "replace": return replaceItemsView(ctx, id);
    case "repl": {
      const r = await adminReplaceOrderItem(id);
      if (r.ok) await ctx.reply("🔄 Replacement delivered to the customer from stock. ✅");
      else await ctx.reply(r.reason === "NO_STOCK" ? "❌ No stock available to replace with. Add stock keys first." : r.reason === "NOT_AUTOMATIC" ? "This item isn't an auto-delivery product." : "Item not found.");
      return;
    }
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
    case "prods": return productsView(ctx, id ? Number.parseInt(id, 10) || 1 : 1);
    case "prodsrch":
      ctx.session.awaiting = "admin_prod_search";
      await askStep(ctx, "🔎 Send part of the product name to search:");
      return;
    case "prodsclr":
      ctx.session.prodSearch = undefined;
      return productsView(ctx, 1);
    case "prod": return productView(ctx, id);
    case "pprice":
      ctx.session.admProductId = id;
      ctx.session.pubUsdMinor = undefined;
      ctx.session.awaiting = "admin_pubprice_usd";
      await askStep(ctx, "💵 New <b>USD</b> price for everyone (applies to all variants), e.g. <code>9.99</code>. Send <code>0</code> to skip USD.");
      return;
    case "cprice": return customPriceView(ctx, id);
    case "pbtn":
      ctx.session.admProductId = id;
      ctx.session.awaiting = "admin_p_btntext";
      await askStep(ctx, "🎨 Send the <b>Buy button label</b> for this product (e.g. <code>⚡ Get Now</code>). Send <code>-</code> to keep the default.");
      return;
    case "pbtncol": {
      const [pid, style] = id.split("~");
      if (pid && style) { await setProductButton(pid, null, style === "default" ? null : style); await ctx.reply(`🎨 Button colour set to <b>${style}</b>.`, { parse_mode: "HTML" }); await productView(ctx, pid); }
      return;
    }
    case "pmode": {
      const cur = (await getProductBriefById(id))?.fulfillmentMode ?? "AUTOMATIC";
      const next = cur === "MANUAL" ? "AUTOMATIC" : "MANUAL";
      await setProductFulfillmentMode(id, next);
      flash(ctx, `⚙️ Delivery mode set to <b>${next}</b>.`);
      return productView(ctx, id);
    }
    case "ppw": {
      const cur = (await getProductBriefById(id))?.allowPwChange ?? false;
      await setProductPasswordChange(id, !cur);
      await ctx.reply(!cur ? "🔓 Customers can now change this account's password." : "🔒 Customers are told not to change this account's password.");
      return productView(ctx, id);
    }
    case "preuse": {
      const cur = await getProductReusableSecret(id);
      ctx.session.admProductId = id;
      ctx.session.awaiting = "admin_p_reuse";
      await askStep(ctx, [
        "♾ <b>Same link for everyone</b>",
        "",
        "Send the value EVERY buyer should receive — a redemption link, invite link or coupon code.",
        "",
        "While this is set the product is <b>never out of stock</b> and no keys are consumed.",
        cur ? `\nCurrently: <code>${escapeHtml(cur)}</code>` : "",
        "\nSend <code>-</code> to turn it off and go back to normal stock.",
      ].join("\n"));
      return;
    }
    case "pmanqty": {
      ctx.session.admProductId = id;
      ctx.session.awaiting = "admin_p_manqty";
      await askStep(ctx, [
        "🔢 <b>Quantity for this manual product</b>",
        "",
        "Send a number (e.g. <code>25</code>) — it counts down with each sale and shows sold out at 0.",
        "",
        "Send <code>-</code> for <b>unlimited</b> (the default for manual products).",
      ].join("\n"));
      return;
    }
    case "preuseqty": {
      ctx.session.admProductId = id;
      ctx.session.awaiting = "admin_p_reuseqty";
      await askStep(ctx, [
        "🔢 <b>How many times can this link be sold?</b>",
        "",
        "Send a number (e.g. <code>50</code>) — it counts down with each sale and the product goes out of stock at 0.",
        "",
        "Send <code>-</code> for <b>unlimited</b> (never runs out).",
      ].join("\n"));
      return;
    }
    case "pauto": {
      const a = await getAutoPromo();
      const on = a.productIds.includes(id);
      const ids = on ? a.productIds.filter((x) => x !== id) : [...a.productIds, id];
      await setAutoPromo({ productIds: ids });
      await ctx.reply(
        on
          ? "🚫 Removed from Auto-Promo — it won't be posted automatically."
          : `✅ Added to Auto-Promo${a.enabled ? ` — it will be posted with a rotating style every ${a.everyHours}h.` : ".\n\n⚠️ Auto-Promo is currently OFF. Turn it on in Marketing → 🤖 Auto-Promo."}`,
        { parse_mode: "HTML" },
      );
      return productView(ctx, id);
    }
    case "pwar": {
      const b = await getProductBriefById(id);
      const cur = b?.warranty ?? false;
      await setProductWarranty(id, !cur);
      await ctx.reply(!cur ? "🛡 Warranty is ON — buyers can request a replacement for this product." : "🚫 Warranty is OFF — replacement requests will be refused for this product.");
      return productView(ctx, id);
    }
    case "pwardays":
      ctx.session.admProductId = id;
      ctx.session.awaiting = "admin_p_warrantydays";
      await askStep(ctx, "⏱ Send the <b>replacement window in days</b> (e.g. <code>7</code>), or <code>0</code> for no time limit:");
      return;
    case "pcost": {
      // Cost lives on the variant; most products have one, so skip the picker.
      const vs = await listVariantsBrief(id);
      if (vs.length === 1) {
        ctx.session.admVariantId = vs[0]!.id;
        ctx.session.awaiting = "admin_variant_cost";
        await askStep(ctx, "💰 Send what <b>you pay</b> per unit in <b>USD</b> (e.g. <code>1.80</code>), or <code>-</code> to clear it:");
        return;
      }
      const kb = new InlineKeyboard();
      for (const v of vs) kb.text(`${v.name}${v.defaultCostMinor !== null ? ` · $${(v.defaultCostMinor / 100).toFixed(2)}` : " · no cost set"}`, cb("adm", "vcost", v.id)).row();
      kb.text("◀️ Back", cb("adm", "prod", id));
      await show(ctx, vs.length ? "💰 Pick a variant to set your cost on:" : "No variants on this product.", kb, true);
      return;
    }
    case "rstmt": return resellerStmtView(ctx);
    case "rstmtnow": {
      await ctx.answerCallbackQuery({ text: "Sending…" }).catch(() => undefined);
      const r = await sendResellerStatements();
      await ctx.reply(`📊 Sent <b>${r.sent}</b> statement(s).${r.skipped > 0 ? ` ${r.skipped} skipped (no orders in the last 24h).` : ""}`, { parse_mode: "HTML" });
      return resellerStmtView(ctx);
    }
    case "twofa": return twoFaView(ctx);
    case "twofaon": {
      const started = await beginAdminTotp();
      if ("error" in started) {
        await ctx.answerCallbackQuery({ text: "2FA is already on — turn it off with a code first.", show_alert: true }).catch(() => undefined);
        return twoFaView(ctx);
      }
      const { secret, uri } = started;
      await ctx.answerCallbackQuery().catch(() => undefined);
      const png = await QRCode.toBuffer(uri, { width: 340, margin: 1 });
      ctx.session.awaiting = "admin_totp_confirm";
      await ctx.replyWithPhoto(new InputFile(png, "2fa.png"), {
        caption: [
          "🔒 <b>Set up two-factor login</b>",
          "",
          "1. Open Google Authenticator (or any TOTP app)",
          "2. Scan this QR — or add the key by hand:",
          `<code>${secret}</code>`,
          "3. Send me the 6-digit code it shows",
          "",
          "⚠️ <b>It is not switched on until you send a working code</b>, so you cannot lock yourself out by accident. Save that key somewhere safe — if you lose your phone it is the only way back in.",
        ].join("\n"),
        parse_mode: "HTML",
      });
      return;
    }
    case "twofaoff":
      ctx.session.awaiting = "admin_totp_disable";
      await askStep(ctx, "🔓 Send your current <b>6-digit code</b> to switch 2FA off:");
      return;
    case "fin": return profitView(ctx, Math.max(1, Number.parseInt(id || "30", 10) || 30));
    case "recon": return reconView(ctx);
    case "thin": return thinMarginView(ctx);
    case "marginfl":
      ctx.session.awaiting = "admin_margin_floor";
      await askStep(ctx, `🎯 Send your <b>minimum margin</b> as a percentage (e.g. <code>15</code>). Anything below it gets flagged. Current: <b>${((await getMarginFloorBp()) / 100).toFixed(1)}%</b>`);
      return;
    case "qual": return qualityView(ctx);
    case "qualtog": {
      const cfg = await getQualityConfig();
      const next = await saveQualityConfig({ autoPause: !cfg.autoPause });
      await ctx.answerCallbackQuery({ text: next.autoPause ? "Auto-pause ON" : "Auto-pause OFF" }).catch(() => undefined);
      return qualityView(ctx);
    }
    case "qualthr":
      ctx.session.awaiting = "admin_qual_threshold";
      await askStep(ctx, "📉 Send the <b>complaint rate</b> that counts as bad, as a percentage (e.g. <code>25</code>):");
      return;
    case "recov": return recoveryView(ctx);
    case "recovtog": {
      const cfg = await getRecoveryConfig();
      const next = await saveRecoveryConfig({ enabled: !cfg.enabled });
      await ctx.answerCallbackQuery({ text: next.enabled ? "Reminders ON" : "Reminders OFF" }).catch(() => undefined);
      return recoveryView(ctx);
    }
    case "recovmin":
      ctx.session.awaiting = "admin_recov_minutes";
      await askStep(ctx, "⏱ Send how many <b>minutes</b> to wait before reminding someone (e.g. <code>20</code>):");
      return;
    case "vcost":
      ctx.session.admVariantId = id;
      ctx.session.awaiting = "admin_variant_cost";
      await askStep(ctx, "💰 Send what <b>you pay</b> per unit in <b>USD</b> (e.g. <code>1.80</code>), or <code>-</code> to clear it:");
      return;
    case "cats": return categoriesAdminView(ctx);
    case "catnew":
      ctx.session.awaiting = "admin_cat_new";
      await askStep(ctx, "🗂 Send the <b>category name</b> (e.g. <code>Streaming</code>, <code>AI Tools</code>):");
      return;
    case "catpick": {
      // Open the bulk categoriser targeting this category.
      ctx.session.catTarget = id;
      ctx.session.catSelected = [];
      ctx.session.catPage = 1;
      ctx.session.catFilter = "none";
      return categoriseView(ctx);
    }
    case "catfil": {
      ctx.session.catFilter = id || "all";
      ctx.session.catPage = 1;
      return categoriseView(ctx);
    }
    case "catpg":
      ctx.session.catPage = Math.max(1, Number.parseInt(id || "1", 10) || 1);
      return categoriseView(ctx);
    case "cattog": {
      const cur = new Set(ctx.session.catSelected ?? []);
      if (cur.has(id)) cur.delete(id); else cur.add(id);
      ctx.session.catSelected = [...cur].slice(0, 500);
      await ctx.answerCallbackQuery().catch(() => undefined);
      return categoriseView(ctx);
    }
    case "catpage": {
      const r = await listProductsForCategorising({ page: ctx.session.catPage ?? 1, pageSize: 12, filter: ctx.session.catFilter, search: ctx.session.catSearch });
      const ids = r.items.map((i) => i.id);
      const cur = new Set(ctx.session.catSelected ?? []);
      const allOn = ids.every((x) => cur.has(x));
      for (const x of ids) { if (allOn) cur.delete(x); else cur.add(x); }
      ctx.session.catSelected = [...cur].slice(0, 500);
      await ctx.answerCallbackQuery({ text: allOn ? "Page cleared" : `Selected ${ids.length}` }).catch(() => undefined);
      return categoriseView(ctx);
    }
    case "catall": {
      const ids = await productIdsForCategorising(ctx.session.catFilter, ctx.session.catSearch);
      const cur = ctx.session.catSelected ?? [];
      ctx.session.catSelected = cur.length >= ids.length ? [] : ids;
      await ctx.answerCallbackQuery({ text: cur.length >= ids.length ? "Cleared" : `Selected ${ids.length}` }).catch(() => undefined);
      return categoriseView(ctx);
    }
    case "catclr":
      ctx.session.catSelected = [];
      await ctx.answerCallbackQuery().catch(() => undefined);
      return categoriseView(ctx);
    case "catsearch":
      ctx.session.awaiting = "admin_cat_search";
      await askStep(ctx, "🔍 Send part of a product name to filter the list (or <code>-</code> to clear):");
      return;
    case "catmove": {
      const target = ctx.session.catTarget ?? "";
      const ids = ctx.session.catSelected ?? [];
      if (!target || ids.length === 0) { await ctx.answerCallbackQuery({ text: "Nothing selected" }).catch(() => undefined); return; }
      const n = await bulkSetCategory(ids, target);
      ctx.session.catSelected = [];
      await ctx.answerCallbackQuery().catch(() => undefined);
      flash(ctx, `🗂 Moved <b>${n}</b> product(s) into this category. They now appear under its tile in Shop by Category.`);
      return categoriseView(ctx);
    }
    case "catemoji":
      ctx.session.catTarget = id;
      ctx.session.awaiting = "admin_cat_emoji";
      await askStep(ctx, "😀 Send ONE emoji to use as this category's tile icon (or <code>-</code> to remove it):");
      return;
    case "catren":
      ctx.session.catTarget = id;
      ctx.session.awaiting = "admin_cat_rename";
      await askStep(ctx, "✏️ Send the new <b>category name</b>:");
      return;
    case "cattgl": {
      const cats = await listCategoriesAdmin();
      const c = cats.find((x) => x.id === id);
      await setCategoryActive(id, !(c?.isActive ?? true));
      await ctx.answerCallbackQuery({ text: c?.isActive ? "Hidden from the grid" : "Shown in the grid" }).catch(() => undefined);
      return categoriesAdminView(ctx);
    }
    case "catdel": {
      const r = await deleteCategory(id);
      await ctx.answerCallbackQuery().catch(() => undefined);
      await ctx.reply(`🗑 Category deleted. ${r.moved} product(s) moved to Uncategorized — nothing was lost.`);
      return categoriesAdminView(ctx);
    }
    case "tks": return ticketsListView(ctx);
    case "tk": return ticketDetailView(ctx, id);
    case "tkpic": {
      const proof = await getTicketProof(id);
      if (!proof) { await ctx.reply("No screenshot on that message."); return; }
      await ctx.replyWithPhoto(proof, { caption: "📷 Customer screenshot" });
      return;
    }
    case "tkre":
      ctx.session.ticketId = id;
      ctx.session.awaiting = "admin_ticket_reply";
      await askStep(ctx, "💬 Send your <b>reply</b> — the customer gets it as a message in the bot:");
      return;
    case "tkres": {
      const r = await setTicketStatus(id, "RESOLVED");
      await ctx.answerCallbackQuery({ text: r.ok ? "Marked resolved" : "Not found" }).catch(() => undefined);
      return ticketDetailView(ctx, id);
    }
    case "tkcls": {
      const r = await setTicketStatus(id, "CLOSED");
      await ctx.answerCallbackQuery({ text: r.ok ? "Closed" : "Not found" }).catch(() => undefined);
      return ticketDetailView(ctx, id);
    }
    case "tkrepl": {
      // Goodwill replacement from inside a ticket — a human decision, out of warranty.
      const res = await issueReplacementFromTicket(id, { approvedBy: String(ctx.from?.id ?? "admin") });
      await ctx.reply(
        res.ok
          ? [
              "✅ <b>Replacement issued.</b>",
              "",
              `The customer has the new details, the full result is on the ticket thread, and the ticket is now RESOLVED.`,
              res.detail?.replacementOrderNumber ? `🧾 Replacement order: <b>${res.detail.replacementOrderNumber}</b>` : "",
              res.detail?.oldTail ? `❌ Replaced unit ending …${res.detail.oldTail}` : "",
              res.detail ? `✅ New unit ending …${res.detail.newTail}` : "",
            ].filter(Boolean).join("\n")
          // The ticket is deliberately LEFT OPEN on failure, so it can be retried.
          : `❌ ${res.reason === "NO_STOCK" ? "No spare stock left to replace with. Add stock, then try again." : res.reason === "NOT_AUTOMATIC" ? "This product is not auto-deliverable — deliver manually from the order." : res.reason ?? "Could not replace."}\n\n<i>The ticket is still open so you can retry — nothing was closed.</i>`,
        { parse_mode: "HTML" },
      );
      return ticketDetailView(ctx, id);
    }
    case "tkrep": {
      // Shortcut straight off the alert: `id` is the ORDER ITEM, not the ticket.
      const tid = await findTicketByOrderItem(id);
      if (!tid) { await ctx.reply("Ticket not found for that item."); return; }
      const res = await issueReplacementFromTicket(tid, { approvedBy: String(ctx.from?.id ?? "admin"), orderItemId: id });
      await ctx.reply(
        res.ok
          ? `✅ Replacement issued, details posted to the ticket, ticket resolved.${res.detail?.replacementOrderNumber ? `\n🧾 ${res.detail.replacementOrderNumber}` : ""}`
          : `❌ ${res.reason ?? "Could not replace."} — the ticket is still open, so you can retry.`,
      );
      return ticketDetailView(ctx, tid);
    }
    case "reps": return replacementsListView(ctx);
    case "rrview": return replacementDetailView(ctx, id);
    case "rrpic": {
      const r = await getReplacementRequest(id);
      if (!r?.proofFileId) { await ctx.reply("No screenshot on this request."); return; }
      await ctx.replyWithPhoto(r.proofFileId, { caption: `📷 Proof — ${escapeHtml(r.label)} (${r.orderNumber})` });
      return;
    }
    case "rrall": {
      const res = await approveReplacementsForOrder(id, String(ctx.from?.id ?? "admin"));
      await ctx.reply(
        res.failed.length === 0
          ? `✅ ${res.done} replacement(s) issued and sent to the customer.`
          : `✅ ${res.done} issued · ⚠️ ${res.failed.length} failed (${res.failed.map((f) => f.reason).join(", ")}). The failed ones are still pending — add stock and retry.`,
      );
      return replacementsListView(ctx);
    }
    case "rrok": {
      const res = await approveReplacement(id, String(ctx.from?.id ?? "admin"));
      if (res.ok) await ctx.reply("✅ Replacement approved — a different unit was issued and sent to the customer.");
      else await ctx.reply(res.reason === "NO_STOCK" ? "❌ No spare stock left to replace with. Add stock keys, then approve again." : res.reason === "ALREADY_REVIEWED" ? "This request was already reviewed." : res.reason === "NOT_AUTOMATIC" ? "❌ This product is not auto-deliverable — deliver a replacement manually from the order." : res.reason === "FAILED" ? "❌ Replacement failed (not a stock problem) — check the worker logs." : "❌ Could not replace.");
      return replacementsListView(ctx);
    }
    case "rrno":
      ctx.session.admReplaceId = id;
      ctx.session.awaiting = "admin_reject_note";
      await askStep(ctx, "❌ Send a short <b>reason</b> the customer will see, or <code>-</code> to decline without a note:");
      return;
    case "tst": {
      const page = Math.max(1, Number.parseInt(id || "1", 10) || 1);
      const st = (ctx.session.tstFilter ?? "ALL") as "DRAFT" | "PENDING" | "PUBLISHED" | "ARCHIVED" | "ALL";
      const [list, stats] = await Promise.all([
        listTestimonials({ page, pageSize: 6, status: st, search: ctx.session.tstSearch }),
        testimonialStats(),
      ]);
      const kb = new InlineKeyboard();
      kb.add(sbtn("➕ Add testimonial", cb("adm", "tstadd"), "success")).row();
      for (const t of list.rows) {
        const tag = t.status === "PUBLISHED" ? "🟢" : t.status === "PENDING" ? "🕐" : t.status === "ARCHIVED" ? "📦" : "✏️";
        kb.text(`${tag}${t.pinned ? "📌" : ""}${t.spamScore >= 40 ? "⚠️" : ""} ${"⭐".repeat(t.rating)} ${t.customerName.slice(0, 16)}`, cb("adm", "tstv", t.id)).row();
      }
      if (list.pages > 1) {
        const nav: Array<ReturnType<typeof sbtn>> = [];
        if (list.page > 1) nav.push(sbtn("◀️ Prev", cb("adm", "tst", String(list.page - 1)), "primary"));
        if (list.page < list.pages) nav.push(sbtn("Next ▶️", cb("adm", "tst", String(list.page + 1)), "primary"));
        if (nav.length) kb.add(...nav).row();
      }
      kb.add(sbtn(`🔎 ${st}`, cb("adm", "tstfilt"), "primary"), sbtn(ctx.session.tstSearch ? `🔍 "${ctx.session.tstSearch.slice(0, 8)}" ✖️` : "🔍 Search", cb("adm", ctx.session.tstSearch ? "tstclr" : "tstsrch"), "primary")).row();
      kb.add(sbtn("📤 Export", cb("adm", "tstexp"), "primary"), sbtn("📥 Import", cb("adm", "tstimp"), "primary")).row();
      kb.text("◀️ Back", cb("adm", "m_content"));
      await show(ctx, [
        "💬 <b>Testimonials</b>",
        `🟢 ${stats.published} published · 🕐 ${stats.pending} pending · ✏️ ${stats.draft} draft · 📦 ${stats.archived} archived`,
        stats.published > 0 ? `Shown rating on cards: <b>${stats.avgShown.toFixed(1)}</b>★` : "",
        stats.flagged > 0 ? `⚠️ <b>${stats.flagged}</b> flagged as possible spam` : "",
        "",
        `Showing <b>${st}</b>${ctx.session.tstSearch ? ` · matching “${escapeHtml(ctx.session.tstSearch)}”` : ""} · page ${list.page}/${list.pages} · ${list.total} total`,
        "",
        ...list.rows.flatMap((t) => [
          `${t.status === "PUBLISHED" ? "🟢" : t.status === "PENDING" ? "🕐" : t.status === "ARCHIVED" ? "📦" : "✏️"} ${"⭐".repeat(t.rating)} <b>${escapeHtml(t.customerName)}</b>${t.company ? ` · ${escapeHtml(t.company)}` : ""}${t.pinned ? " 📌" : ""}${t.featured ? " ⭐" : ""}`,
          `   <i>${escapeHtml(t.body).slice(0, 140)}</i>`,
          `   📄 source: ${escapeHtml(t.source).slice(0, 60)}${t.spamScore >= 40 ? ` · ⚠️ spam score ${t.spamScore}` : ""}`,
        ]),
        "",
        "<i>ℹ️ Testimonials are marketing content. They never change your ⭐ star average, which comes only from approved customer reviews on real orders.</i>",
      ].filter((l) => l !== "").join("\n").slice(0, 3900), kb, true);
      return;
    }
    case "tstfilt": {
      const order = ["ALL", "PUBLISHED", "PENDING", "DRAFT", "ARCHIVED"] as const;
      const cur = (ctx.session.tstFilter ?? "ALL") as (typeof order)[number];
      ctx.session.tstFilter = order[(order.indexOf(cur) + 1) % order.length];
      return handleAdminCallback(ctx, "tst", ["1"]);
    }
    case "tstsrch":
      ctx.session.awaiting = "admin_tst_search";
      await askStep(ctx, "🔍 Send a name, product or phrase to search testimonials:");
      return;
    case "tstclr":
      ctx.session.tstSearch = undefined;
      return handleAdminCallback(ctx, "tst", ["1"]);
    case "tstadd":
      ctx.session.tstDraft = {};
      ctx.session.awaiting = "admin_tst_name";
      await askStep(ctx, [
        "💬 <b>New testimonial</b> · Step 1/5",
        "",
        "Send the <b>customer's name</b> (as you have permission to show it):",
      ].join("\n"));
      return;
    case "tstv": {
      const t = await getTestimonial(id);
      if (!t) { await ctx.reply("That testimonial is gone."); return handleAdminCallback(ctx, "tst", ["1"]); }
      const lg = await testimonialLog(id, 5);
      const kb = new InlineKeyboard();
      kb.add(
        sbtn(t.status === "PUBLISHED" ? "📦 Unpublish" : "🟢 Publish", cb("adm", t.status === "PUBLISHED" ? "tstdraft" : "tstpub", id), t.status === "PUBLISHED" ? "primary" : "success"),
        sbtn("📦 Archive", cb("adm", "tstarch", id), "primary"),
      ).row();
      kb.add(
        sbtn(t.pinned ? "📌 Unpin" : "📌 Pin", cb("adm", "tstpin", id), "primary"),
        sbtn(t.featured ? "⭐ Unfeature" : "⭐ Feature", cb("adm", "tstfeat", id), "primary"),
      ).row();
      kb.add(sbtn("✏️ Edit text", cb("adm", "tstedit", id), "primary"), sbtn("🔢 Order", cb("adm", "tstord", id), "primary")).row();
      kb.add(sbtn("🗑 Delete", cb("adm", "tstdel", id), "danger")).row();
      kb.text("◀️ Back", cb("adm", "tst", "1"));
      await show(ctx, [
        `💬 <b>Testimonial</b> — ${"⭐".repeat(t.rating)}`,
        `📌 Status: <b>${t.status}</b>${t.pinned ? " · 📌 pinned" : ""}${t.featured ? " · ⭐ featured" : ""}`,
        `👤 <b>${escapeHtml(t.customerName)}</b>${t.company ? ` · ${escapeHtml(t.company)}` : ""}`,
        t.productName ? `📦 ${escapeHtml(t.productName)}` : "",
        `🌐 ${t.locale} · 🔢 order ${t.sortOrder}`,
        "",
        `💬 <i>${escapeHtml(t.body)}</i>`,
        "",
        `📄 <b>Source:</b> ${escapeHtml(t.source)}`,
        t.verified ? "✅ Linked to a real order — shows as a verified purchase" : "ℹ️ Not order-linked — shows as “shared with permission”",
        t.spamScore >= 40 ? `⚠️ Spam score <b>${t.spamScore}</b>/100 — check before publishing` : "",
        lg.length ? `\n🧾 <b>History</b>\n${lg.map((l) => `• ${l.action}${l.detail ? ` — ${escapeHtml(l.detail)}` : ""} · ${l.at.toISOString().slice(5, 16).replace("T", " ")}`).join("\n")}` : "",
      ].filter((l) => l !== "").join("\n"), kb, true);
      return;
    }
    case "tstpub": { await setTestimonialStatus(id, "PUBLISHED", "bot-admin"); await ctx.reply("🟢 Published — customers can see it now."); return handleAdminCallback(ctx, "tstv", [id]); }
    case "tstdraft": { await setTestimonialStatus(id, "DRAFT", "bot-admin"); await ctx.reply("✏️ Unpublished — back to draft."); return handleAdminCallback(ctx, "tstv", [id]); }
    case "tstarch": { await setTestimonialStatus(id, "ARCHIVED", "bot-admin"); await ctx.reply("📦 Archived."); return handleAdminCallback(ctx, "tst", ["1"]); }
    case "tstpin": { const v = await toggleTestimonialFlag(id, "pinned", "bot-admin"); await ctx.answerCallbackQuery({ text: v ? "Pinned" : "Unpinned" }).catch(() => undefined); return handleAdminCallback(ctx, "tstv", [id]); }
    case "tstfeat": { const v = await toggleTestimonialFlag(id, "featured", "bot-admin"); await ctx.answerCallbackQuery({ text: v ? "Featured" : "Unfeatured" }).catch(() => undefined); return handleAdminCallback(ctx, "tstv", [id]); }
    case "tstord":
      ctx.session.tstTarget = id; ctx.session.awaiting = "admin_tst_order";
      await askStep(ctx, "🔢 Send a display order number (lower shows first, e.g. <code>1</code>):");
      return;
    case "tstedit":
      ctx.session.tstTarget = id; ctx.session.awaiting = "admin_tst_editbody";
      await askStep(ctx, "✏️ Send the corrected testimonial text:");
      return;
    case "tstdel": {
      const kb = new InlineKeyboard()
        .add(sbtn("🗑 Yes, delete", cb("adm", "tstdeldo", id), "danger")).row()
        .text("◀️ Cancel", cb("adm", "tstv", id));
      await show(ctx, "🗑 <b>Delete this testimonial?</b>\n\nThis cannot be undone. Archive it instead if you might want it later.", kb, true);
      return;
    }
    case "tstdeldo": { await deleteTestimonial(id, "bot-admin"); await ctx.reply("🗑 Deleted."); return handleAdminCallback(ctx, "tst", ["1"]); }
    case "tstexp": {
      const json = await exportTestimonials();
      await ctx.replyWithDocument(new InputFile(Buffer.from(json, "utf8"), "testimonials.json"), { caption: "📤 All testimonials. Re-import this file to restore them." });
      return;
    }
    case "tstimp":
      ctx.session.awaiting = "admin_tst_import";
      await askStep(ctx, "📥 Send the <b>testimonials.json</b> file (or paste the JSON).\n\n<i>Imported entries land as PENDING, and rows without a source are skipped.</i>");
      return;
    case "revs": {
      const page = Math.max(1, Number.parseInt(id || "1", 10) || 1);
      const filter = (ctx.session.revFilter ?? "pending") as "pending" | "approved" | "rejected" | "all";
      const [list, st, dist] = await Promise.all([listReviews(page, 6, filter), storeRating(), ratingBreakdown()]);
      const kb = new InlineKeyboard();
      for (const r of list.rows) {
        const tag = r.status === "PENDING" ? "🕐" : r.status === "APPROVED" ? "✅" : "❌";
        kb.text(`${tag} ${"⭐".repeat(r.rating)} ${r.who.slice(0, 12)}${r.product ? ` · ${r.product.slice(0, 12)}` : ""}`, cb("adm", "revv", r.id)).row();
      }
      if (list.pages > 1) {
        const nav: Array<ReturnType<typeof sbtn>> = [];
        if (list.page > 1) nav.push(sbtn("◀️ Prev", cb("adm", "revs", String(list.page - 1)), "primary"));
        if (list.page < list.pages) nav.push(sbtn("Next ▶️", cb("adm", "revs", String(list.page + 1)), "primary"));
        if (nav.length) kb.add(...nav).row();
      }
      kb.add(sbtn(`🔎 ${filter}`, cb("adm", "revfilt"), "primary"), sbtn("🔄 Refresh", cb("adm", "revs", String(list.page)), "primary")).row();
      kb.text("◀️ Back", cb("adm", "m_content"));
      const max = Math.max(1, ...dist.map((d) => d.count));
      const chart = st.count > 0 ? dist.map((d) => `${d.stars}⭐ ${"█".repeat(Math.round((d.count / max) * 12)).padEnd(12, "░")} ${d.count}`) : [];
      const lines = [
        "⭐ <b>Reviews &amp; Moderation</b>",
        st.count > 0 ? `${st.stars} <b>${st.avg.toFixed(1)}</b>/5 from <b>${st.count}</b> approved review(s)` : "<i>No approved reviews yet.</i>",
        list.pending > 0 ? `🕐 <b>${list.pending}</b> awaiting your approval` : "✅ Nothing pending",
        "",
        ...(chart.length ? [...chart, ""] : []),
        `Showing <b>${filter}</b> · page ${list.page}/${list.pages} · ${list.total} total`,
        "",
      ];
      for (const r of list.rows) {
        const tag = r.status === "PENDING" ? "🕐" : r.status === "APPROVED" ? "✅" : "❌";
        lines.push(`${tag} ${"⭐".repeat(r.rating)} · <b>${escapeHtml(r.who)}</b>${r.verified ? " ✅<i>verified</i>" : ""} · ${r.at.toISOString().slice(5, 16).replace("T", " ")}`);
        if (r.product) lines.push(`   📦 ${escapeHtml(r.product)}`);
        if (r.comment) lines.push(`   <i>${escapeHtml(r.comment).slice(0, 200)}</i>`);
        if (r.rejectReason) lines.push(`   ❌ ${escapeHtml(r.rejectReason)}`);
      }
      lines.push("", "<i>Tap a review to moderate. You can approve, reject or reply — the star rating and the customer's words can never be edited.</i>");
      await show(ctx, lines.join("\n").slice(0, 3900), kb, true);
      return;
    }
    case "revfilt": {
      const order = ["pending", "approved", "rejected", "all"] as const;
      const cur = (ctx.session.revFilter ?? "pending") as (typeof order)[number];
      ctx.session.revFilter = order[(order.indexOf(cur) + 1) % order.length];
      return handleAdminCallback(ctx, "revs", ["1"]);
    }
    case "revv": {
      const r = await getReview(id);
      if (!r) { await ctx.reply("That review is gone."); return handleAdminCallback(ctx, "revs", ["1"]); }
      const log = await moderationLog(id, 5);
      const kb = new InlineKeyboard();
      if (r.status !== "APPROVED") kb.add(sbtn("✅ Approve", cb("adm", "revok", r.id), "success")).row();
      if (r.status !== "REJECTED") kb.add(sbtn("❌ Reject", cb("adm", "revno", r.id), "danger")).row();
      kb.add(sbtn("💬 Reply", cb("adm", "revrep", r.id), "primary"), sbtn(r.verified ? "✅ Verified — unmark" : "☑️ Mark verified", cb("adm", "revver", r.id), "primary")).row();
      kb.text("◀️ Back", cb("adm", "revs", "1"));
      await show(ctx, [
        `⭐ <b>Review</b> — ${"⭐".repeat(r.rating)} <b>${r.rating}/5</b>`,
        `📌 Status: <b>${r.status}</b>${r.verified ? " · ✅ verified purchase" : ""}`,
        `👤 ${escapeHtml(r.who)}  🆔 <code>${r.telegramId || "—"}</code>`,
        r.product ? `📦 ${escapeHtml(r.product)}` : "",
        "",
        r.comment ? `💬 <i>${escapeHtml(r.comment)}</i>` : "<i>No written comment.</i>",
        r.reply ? `\n🏬 <b>Your reply:</b> ${escapeHtml(r.reply)}` : "",
        r.rejectReason ? `\n❌ Rejected: ${escapeHtml(r.rejectReason)}` : "",
        log.length ? `\n🧾 <b>History</b>\n${log.map((l) => `• ${l.action}${l.reason ? ` — ${escapeHtml(l.reason)}` : ""} · ${l.at.toISOString().slice(5, 16).replace("T", " ")}`).join("\n")}` : "",
      ].filter(Boolean).join("\n"), kb, true);
      return;
    }
    case "revok": {
      const ok = await approveReview(id);
      await ctx.reply(ok ? "✅ Approved — it is now public and counts toward your rating." : "Couldn't approve that.");
      return handleAdminCallback(ctx, "revs", ["1"]);
    }
    case "revno": {
      const kb = new InlineKeyboard();
      for (const reason of REJECT_REASONS) kb.text(`❌ ${reason}`, cb("adm", "revnodo", `${id}~${reason.slice(0, 6)}`)).row();
      kb.text("◀️ Back", cb("adm", "revv", id));
      await show(ctx, "❌ <b>Why are you rejecting this review?</b>\n\nThe customer's rating and words are kept on record — the review simply is not published and does not count.", kb, true);
      return;
    }
    case "revnodo": {
      const [rid, code] = (id || "").split("~");
      const reason = REJECT_REASONS.find((r) => r.startsWith(code ?? "")) ?? "Rejected";
      const ok = await rejectReview(rid ?? "", reason);
      await ctx.reply(ok ? `❌ Rejected (${reason}). It stays out of your public rating.` : "Couldn't reject that.");
      return handleAdminCallback(ctx, "revs", ["1"]);
    }
    case "revrep":
      ctx.session.revTarget = id;
      ctx.session.awaiting = "admin_rev_reply";
      await askStep(ctx, "💬 Send your public reply to this review.\n\n<i>This is shown under the review. It does not change what the customer wrote or scored.</i>");
      return;
    case "revver": {
      const r = await getReview(id);
      if (!r) return;
      await setVerifiedPurchase(id, !r.verified);
      await ctx.answerCallbackQuery({ text: r.verified ? "Unmarked" : "Marked verified" }).catch(() => undefined);
      return handleAdminCallback(ctx, "revv", [id]);
    }

    case "fup": {
      const c = await getFollowupConfig();
      const kb = new InlineKeyboard()
        .add(sbtn(c.enabled ? "✅ ON — turn off" : "🚫 OFF — turn on", cb("adm", "fuptog"), c.enabled ? "success" : "danger")).row()
        .text("✏️ Message", cb("adm", "fuptext")).text("⏱ Delay", cb("adm", "fupdelay")).row()
        .text("🔗 Button (label + link)", cb("adm", "fupbtn")).row()
        .add(sbtn("📤 Send me a preview", cb("adm", "fuptest"), "primary")).row()
        .text("◀️ Back", cb("adm", "m_content"));
      await show(ctx, [
        "💬 <b>After-sale message</b>",
        `Status: <b>${c.enabled ? "ON" : "OFF"}</b> · sent <b>${c.delayMins} min</b> after delivery`,
        c.btnText && c.btnUrl ? "" : "<i>Default button: ⭐ Leave a review (rating captured in the bot, customer thanked instantly by name).</i>",
        "",
        "Sent automatically once an order is delivered — ask for a review, or promote your website/channel.",
        "",
        "<b>Placeholders:</b> <code>{name}</code> <code>{order}</code> <code>{product}</code> <code>{store}</code>",
        "",
        "<b>Current message:</b>",
        c.text,
        c.btnText && c.btnUrl ? `\n🔗 Button: <b>${escapeHtml(c.btnText)}</b> → ${escapeHtml(c.btnUrl)}` : "\n<i>No button set.</i>",
      ].join("\n"), kb, true);
      return;
    }
    case "fuptog": {
      const c = await getFollowupConfig();
      const n = await setFollowupConfig({ enabled: !c.enabled });
      await ctx.reply(n.enabled ? `✅ After-sale message is ON — sent ${n.delayMins} min after each delivery.` : "🚫 After-sale message is OFF.");
      return handleAdminCallback(ctx, "fup", []);
    }
    case "fuptext":
      ctx.session.awaiting = "admin_fup_text";
      await askStep(ctx, "✏️ Send the <b>after-sale message</b>.\n\nUse <code>{name}</code> <code>{order}</code> <code>{product}</code> <code>{store}</code> — premium emoji OK.");
      return;
    case "fupdelay":
      ctx.session.awaiting = "admin_fup_delay";
      await askStep(ctx, "⏱ How many <b>minutes</b> after delivery should it be sent? (e.g. <code>60</code>, or <code>0</code> for immediately)");
      return;
    case "fupbtn":
      ctx.session.awaiting = "admin_fup_btn";
      await askStep(ctx, "🔗 Send the button as <code>Label | https://your-link</code>\n\nExample: <code>⭐ Leave a review | https://t.me/yourchannel</code>\n\nSend <code>-</code> to remove the button.");
      return;
    case "fuptest": {
      const c = await getFollowupConfig();
      const text = renderFollowup(c.text, { name: ctx.from?.first_name ?? "there", order: "GIS-2026-000128", product: "Office 365 100GB", store: loadConfig().STORE_NAME });
      const kb2 = c.btnText && c.btnUrl ? new InlineKeyboard().url(c.btnText, c.btnUrl) : undefined;
      await ctx.reply(text, { parse_mode: "HTML", ...(kb2 ? { reply_markup: kb2 } : {}) }).catch(async () => {
        await ctx.reply("⚠️ That message failed to send — check the HTML tags and the button link (must start with https://).");
      });
      return;
    }
    case "trcfg": {
      const cur = await getTranslateProvider();
      const kb = new InlineKeyboard()
        .add(sbtn(`${cur === "libre" ? "✅ " : ""}LibreTranslate`, cb("adm", "trset", "libre"), "primary")).row()
        .add(sbtn(`${cur === "google" ? "✅ " : ""}Google Translate`, cb("adm", "trset", "google"), "primary")).row()
        .add(sbtn(`${cur === "deepl" ? "✅ " : ""}DeepL`, cb("adm", "trset", "deepl"), "primary")).row()
        .add(sbtn(`${cur === "none" ? "✅ " : ""}Off (English only)`, cb("adm", "trset", "none"), "danger")).row()
        .text("◀️ Back", cb("adm", "m_content"));
      await show(ctx, [
        "🌐 <b>Auto-Translate</b>",
        `Current: <b>${cur}</b>`,
        "",
        "When a customer picks a language, product names and descriptions are translated automatically and cached, so each phrase is only translated once.",
        "",
        "Pick a provider — you'll be asked for the API key next.",
      ].join("\n"), kb, true);
      return;
    }
    case "trset": {
      if (id === "none") {
        await setTranslateCreds("none", undefined, undefined);
        await ctx.reply("🌐 Auto-translate is <b>off</b> — everyone sees the original English text.", { parse_mode: "HTML" });
        return sendPanel(ctx, false);
      }
      ctx.session.trProvider = id;
      ctx.session.awaiting = "admin_tr_key";
      const hint = id === "libre"
        ? "LibreTranslate: send your API key, or <code>-</code> if your instance needs none."
        : id === "google"
          ? "Google Translate: send your Cloud Translation API key."
          : "DeepL: send your DeepL Auth Key.";
      await askStep(ctx, `🌐 <b>${id}</b>\n${hint}`);
      return;
    }
    case "pricealert": {
      const a = ctx.session.priceAlert;
      ctx.session.priceAlert = undefined;
      if (!a) { await ctx.reply("That price change expired."); return sendPanel(ctx, false); }
      const r = await announcePriceChange(a.productId, a.oldMinor, a.newMinor, a.currency as "USD" | "INR");
      await ctx.reply(r.announced ? `📣 Sent to ${r.targets ?? 0} customers. 🎉` : "Couldn't announce that.");
      return productView(ctx, a.productId);
    }
    case "promot": {
      const ps = await listProductsBrief(20);
      const kb = new InlineKeyboard();
      for (const pr of ps) kb.text(`${pr.iconEmoji ? `${pr.iconEmoji} ` : ""}${pr.name.slice(0, 26)}`, cb("adm", "promotp", pr.id)).row();
      kb.text("◀️ Back", cb("adm", "m_mkt"));
      await show(ctx, "📣 <b>Promo Templates</b>\n\nPick the product to announce. You'll choose a style, or let it rotate automatically.", kb, true);
      return;
    }
    case "promotp": {
      ctx.session.promoProduct = id;
      const kb = new InlineKeyboard();
      kb.add(sbtn("🎲 Auto — rotate style", cb("adm", "promoq", "auto"), "success")).row();
      for (const st of PROMO_STYLES) kb.text(STYLE_LABELS[st], cb("adm", "promoq", st)).row();
      kb.text("◀️ Back", cb("adm", "promot"));
      await show(ctx, "📣 <b>Choose a style</b>\n\nTap one to preview it before sending.\n\n<i>Auto never repeats the same style twice in a row for a product.</i>", kb, true);
      return;
    }
    case "promoq": {
      const pid = ctx.session.promoProduct ?? "";
      const c = await promoContext(pid);
      if (!c) { await ctx.reply("That product isn't active."); return handleAdminCallback(ctx, "promot", []); }
      const style = (id === "auto" ? PROMO_STYLES[0] : id) as (typeof PROMO_STYLES)[number];
      ctx.session.promoStyle = id;
      await ctx.reply(renderPromo(style, c), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .add(sbtn(id === "auto" ? "📣 Send (rotating style)" : "📣 Send this", cb("adm", "promogo"), "success")).row()
          .text("◀️ Another style", cb("adm", "promotp", pid)),
      });
      return;
    }
    case "promogo": {
      const pid = ctx.session.promoProduct ?? "";
      const st = (ctx.session.promoStyle ?? "auto") as "auto" | (typeof PROMO_STYLES)[number];
      const r = await announcePromo(pid, st);
      await ctx.reply(r.ok ? `📣 Sent to <b>${r.targets ?? 0}</b> customers using the <b>${r.style}</b> style. 🎉` : "Couldn't send that.", { parse_mode: "HTML" });
      return handleAdminCallback(ctx, "promot", []);
    }
    case "autop": {
      const a = await getAutoPromo();
      const kb = new InlineKeyboard()
        .add(sbtn(a.enabled ? "✅ ON — turn off" : "🚫 OFF — turn on", cb("adm", "autoptog"), a.enabled ? "success" : "danger")).row()
        .add(sbtn("⏱ How often", cb("adm", "autoph"), "primary")).row()
        .text("◀️ Back", cb("adm", "m_mkt"));
      await show(ctx, [
        "🤖 <b>Auto-Promo</b>",
        `Status: <b>${a.enabled ? "ON" : "OFF"}</b> · every <b>${a.everyHours}h</b>`,
        a.lastRunAt ? `Last post: ${a.lastRunAt.slice(0, 16).replace("T", " ")}` : "",
        "",
        "Posts one product on its own, with a <b>different style each time</b>, so your channel stays active without looking copy-pasted.",
        "",
        a.productIds.length ? `🎯 Rotating <b>${a.productIds.length}</b> chosen product(s).` : "🎯 Rotating your pinned and newest active products.",
      ].filter(Boolean).join("\n"), kb, true);
      return;
    }
    case "autoptog": {
      const a = await getAutoPromo();
      const n = await setAutoPromo({ enabled: !a.enabled });
      await ctx.reply(n.enabled ? `🤖 Auto-Promo is ON — next post within ${n.everyHours}h.` : "🚫 Auto-Promo is OFF.");
      return handleAdminCallback(ctx, "autop", []);
    }
    case "autoph":
      ctx.session.awaiting = "admin_autop_hours";
      await askStep(ctx, "⏱ Post how often? Send the number of <b>hours</b> (e.g. <code>12</code>):");
      return;
    case "cataloglist": {
      const kb = new InlineKeyboard()
        .add(sbtn("📣 Send full stock list", cb("adm", "catalogo", "all"), "success")).row()
        .add(sbtn("📦 In-stock items only", cb("adm", "catalogo", "instock"), "primary")).row()
        .text("◀️ Back", cb("adm", "m_mkt"));
      await show(ctx, [
        "🗂 <b>Share full stock list</b>",
        "",
        "Sends every live product to all customers as a clean stock list:",
        "",
        "<i>🎁 Product Name</i>",
        "<i>🎁 12 in stock · $4.99</i>",
        "",
        "Long lists are split automatically so nothing gets cut off.",
      ].join("\n"), kb, true);
      return;
    }
    case "catalogo": {
      await ctx.reply("⏳ Building the stock list…");
      const r = await announceCatalogue({ inStockOnly: id === "instock" });
      await ctx.reply(`🗂 Sent <b>${r.products}</b> products to <b>${r.targets}</b> customers. 🎉`, { parse_mode: "HTML" });
      return sendPanel(ctx, false);
    }
    case "wait": {
      const [restock, drops] = await Promise.all([topWatched("RESTOCK", 10), topWatched("PRICE_DROP", 10)]);
      const kb = new InlineKeyboard().text("🔄 Refresh", cb("adm", "wait")).text("◀️ Back", cb("adm", "m_prod"));
      await show(ctx, [
        "🔔 <b>Waiting Lists</b>",
        "",
        restock.length
          ? ["<b>Waiting for restock</b> — buy these first:", ...restock.map((r, i) => `${i + 1}. <b>${escapeHtml(r.name)}</b> — ${r.count} waiting`)].join("\n")
          : "<i>Nobody waiting on a restock right now.</i>",
        "",
        drops.length
          ? ["<b>Watching for a price drop</b>:", ...drops.map((r) => `• ${escapeHtml(r.name)} — ${r.count} watching`)].join("\n")
          : "",
        "",
        "<i>Everyone on a restock list is messaged automatically when you add stock, and price-drop watchers when you lower a price. Each person is told once, then removed.</i>",
      ].filter((l) => l !== "").join("\n"), kb, true);
      return;
    }
    case "fixacc": {
      await ctx.reply("🧰 Checking stored account stock…");
      const r = await repairBrokenAccounts();
      await ctx.reply(
        r.fixed > 0
          ? `✅ Repaired <b>${r.fixed}</b> of ${r.scanned} accounts that were saved in the broken format. They will now deliver correctly.`
          : `✅ Checked ${r.scanned} accounts — none needed repair.`,
        { parse_mode: "HTML" },
      );
      return sendPanel(ctx, false);
    }
    case "wdok": {
      // args: userId ~ inrMinor ~ usdMinor  (wallet is always credited in USD)
      const [uid, inrRaw, usdRaw] = (id || "").split("~");
      const inrMinor = Number.parseInt(inrRaw ?? "0", 10);
      const usdMinor = Number.parseInt(usdRaw ?? "0", 10);
      if (!uid || !Number.isFinite(usdMinor) || usdMinor <= 0) { await ctx.reply("That top-up request is invalid."); return; }
      const res = await adjustUserWalletById(uid, usdMinor, `UPI top-up approved (₹${(inrMinor / 100).toFixed(2)})`);
      if (res.ok) {
        const tu = await getUserById(uid);
        if (tu) {
          await notifyTopupToAdmins(
            { telegramHandle: null, firstName: tu.label, telegramId: tu.telegramId ? BigInt(tu.telegramId) : null, currency: tu.currency },
            usdMinor, `UPI ₹${(inrMinor / 100).toFixed(2)}`, "", res.newBalanceMinor,
          ).catch(() => undefined);
        }
        await ctx.reply(
          `✅ Credited <b>$${(usdMinor / 100).toFixed(2)}</b> (₹${(inrMinor / 100).toFixed(2)} @ 100 INR = 1 USD). New balance: <b>${(Number(res.newBalanceMinor ?? 0n) / 100).toFixed(2)} ${res.currency ?? "USD"}</b>.`,
          { parse_mode: "HTML" },
        );
        await dmUser(uid, `✅ <b>Wallet topped up!</b>\n\n💰 <b>$${(usdMinor / 100).toFixed(2)}</b> added (₹${(inrMinor / 100).toFixed(2)} at 100 INR = 1 USD).\nYou can pay for any order instantly now. 🚀`).catch(() => undefined);
      } else {
        await ctx.reply("❌ Couldn't credit that customer.");
      }
      return;
    }
    case "wdno": {
      if (!id) return;
      await dmUser(id, "❌ <b>We could not verify that UPI payment.</b>\n\nPlease double-check the UTR on your receipt and send it again, or open 🎫 Support and our team will help. 🙏").catch(() => undefined);
      await ctx.reply("❌ Rejected — the customer has been told.");
      return;
    }
    case "tlprice": {
      const r = await rederiveInrPrices(true);
      const ps = pricingSummary();
      if (r.changes.length === 0) {
        await show(ctx, `🔄 <b>Re-derive INR prices</b>\n\n✅ Every INR price already matches the current rate (${ps.rate}) and surcharge (${ps.surchargePct.toFixed(1)}%). Nothing to change.`, new InlineKeyboard().text("◀️ Back", cb("adm", "m_tools")), true);
        return;
      }
      const kb = new InlineKeyboard()
        .add(sbtn(`✅ Apply to ${r.changes.length} price(s)`, cb("adm", "tlpricego"), "success")).row()
        .text("✖️ Cancel", cb("adm", "m_tools"));
      await show(ctx, [
        "🔄 <b>Re-derive INR prices</b>",
        `Rate <b>${ps.rate}</b> INR = \$1 · surcharge <b>${ps.surchargePct.toFixed(1)}%</b>`,
        "",
        `<b>${r.changes.length}</b> price(s) would change:`,
        "",
        ...r.changes.slice(0, 12).map((c) => `• ${escapeHtml(c.name).slice(0, 24)}: ${c.oldInrMinor === null ? "—" : `₹${(c.oldInrMinor / 100).toFixed(2)}`} → <b>₹${(c.newInrMinor / 100).toFixed(2)}</b>  <i>(\$${(c.usdMinor / 100).toFixed(2)})</i>`),
        r.changes.length > 12 ? `<i>…and ${r.changes.length - 12} more</i>` : "",
        "",
        "<i>Nothing is saved until you tap Apply.</i>",
      ].filter((l) => l !== "").join("\n").slice(0, 3900), kb, true);
      return;
    }
    case "tlpricego": {
      const r = await rederiveInrPrices(false);
      await ctx.reply(`✅ Updated <b>${r.applied}</b> INR price(s) at the current rate and surcharge.`, { parse_mode: "HTML" });
      return showSubmenu(ctx, "m_tools").then(() => undefined);
    }
    case "tladj":
      ctx.session.awaiting = "admin_tool_adjust";
      await askStep(ctx, "📈 Send a percentage to apply to <b>every</b> price.\n\n<code>10</code> = +10%, <code>-5</code> = −5%.\n\n<i>You'll see a preview before anything is saved.</i>");
      return;
    case "tladjgo": {
      const pct = ctx.session.toolPct ?? 0;
      ctx.session.toolPct = undefined;
      const r = await bulkAdjustPrices(pct, false);
      await ctx.reply(`✅ Adjusted <b>${r.changed}</b> price(s) by <b>${pct > 0 ? "+" : ""}${pct}%</b>.`, { parse_mode: "HTML" });
      return showSubmenu(ctx, "m_tools").then(() => undefined);
    }
    case "tlkey":
      ctx.session.awaiting = "admin_tool_key";
      await askStep(ctx, "🔍 Paste the key, or the <b>id</b> of an account, to trace who received it:");
      return;
    case "tlstock": {
      const h = await stockHealth();
      const kb = new InlineKeyboard().text("🔄 Refresh", cb("adm", "tlstock")).text("◀️ Back", cb("adm", "m_tools"));
      await show(ctx, [
        "📊 <b>Stock health</b>",
        `📦 Total units in stock: <b>${h.totalUnits}</b>`,
        "",
        h.low.length ? ["⚠️ <b>Running low</b>", ...h.low.map((x) => `• ${escapeHtml(x.name).slice(0, 26)} — <b>${x.left}</b> left`)].join("\n") : "✅ Nothing running low",
        "",
        h.outOfStock.length ? ["❌ <b>Out of stock</b>", ...h.outOfStock.map((x) => `• ${escapeHtml(x.name).slice(0, 26)}${x.waiting ? ` — 🔔 <b>${x.waiting}</b> waiting` : ""}`)].join("\n") : "",
        "",
        h.dead.length ? ["💀 <b>Dead stock</b> — bought but never sold", ...h.dead.map((x) => `• ${escapeHtml(x.name).slice(0, 26)} — ${x.units} units, ${x.ageDays}d old`)].join("\n") : "✅ No dead stock",
        "",
        "<i>Restock the ones with people waiting first. Stop buying the dead ones.</i>",
      ].filter((l) => l !== "").join("\n").slice(0, 3900), kb, true);
      return;
    }
    case "tlrisk":
      ctx.session.awaiting = "admin_tool_risk";
      await askStep(ctx, "🛡 Send the customer's <b>@username</b> or <b>Telegram ID</b> to see their claim history:");
      return;
    case "tlcsv": {
      await ctx.reply("📄 Building the export…");
      const csv = await exportOrdersCsv(90);
      await ctx.replyWithDocument(new InputFile(Buffer.from(csv, "utf8"), `orders-${new Date().toISOString().slice(0, 10)}.csv`), {
        caption: "📄 Last 90 days of orders — opens in Excel or Google Sheets.",
      });
      return;
    }
    case "fxsur": {
      const [bp, rate] = await Promise.all([getInrSurchargeBp(), getInrPerUsdt()]);
      ctx.session.awaiting = "admin_fx_surcharge";
      await askStep(ctx, [
        "🇮🇳 <b>INR price surcharge</b>",
        "",
        `Current: <b>${(bp / 100).toFixed(1)}%</b> on top of the converted price.`,
        "",
        "INR/UPI costs you manual verification, so INR prices carry a surcharge — that makes <b>USDT the cheaper, instant option</b> and steers customers there.",
        "",
        `Example at ${rate} INR = \$1 and ${(bp / 100).toFixed(1)}%:`,
        `• \$10.00 → <b>₹${(1000 * rate * (10000 + bp) / 10000 / 100).toFixed(2)}</b> (₹${(1000 * rate / 100).toFixed(2)} without it)`,
        "",
        "⚠️ Applies to PRICES only — wallet balances, deposits and refunds convert exactly.",
        "",
        "Send the new percentage (e.g. <code>5</code>), or <code>0</code> for none:",
      ].join("\n"));
      return;
    }
    case "fxrate": {
      const rate = await getInrPerUsdt();
      ctx.session.awaiting = "admin_fx_rate";
      await askStep(ctx, [
        "💱 <b>INR ⇄ USD / USDT rate</b>",
        "",
        `Current: <b>${rate} INR = 1 USD (USDT)</b>`,
        "",
        "This one rate is used everywhere:",
        "• wallet deductions when prices and wallet currency differ",
        "• crediting UPI top-ups in USD",
        "• the exact USDT amount quoted for Binance",
        "• showing a USD price in ₹ (and vice-versa)",
        "",
        `Examples at ${rate}: ₹${rate} → $1.00 · $3 → ₹${rate * 3}`,
        "",
        "Send the new rate — how many <b>INR equal 1 USD</b> (e.g. <code>100</code>):",
      ].join("\n"));
      return;
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
      const [uid, ch] = id.split("~");
      const pid = ctx.session.admProductId ?? "";
      const channel = ch === "D" ? "DIRECT" : ch === "A" ? "API" : "BOTH";
      if (uid && pid) { await removeUserPrice(uid, pid, channel as PriceChannel); await customPriceView(ctx, pid); }
      else await ctx.reply("That screen expired — open the product again.");
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
      flash(ctx, "✖️ Order cancelled.");
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
      await ctx.reply("👁 Now visible — customers can see and buy this product.").catch(() => undefined);
      const ann = await announceProduct(id, { createdById: "bot-admin", force: true });
      await ctx.reply(`🟢 Activated.${ann.announced ? ` 📣 Notified ${ann.targets ?? 0} users with a ⚡ Buy Now button.` : ""}`);
      return productView(ctx, id);
    }
    case "ppause": { await setProductStatus(id, "PAUSED"); await ctx.reply("🙈 Hidden — customers can no longer see or buy this product."); return productView(ctx, id); }
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
      flash(ctx, "🗑 Product deleted.");
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
    case "pguide": {
      ctx.session.admProductId = id;
      ctx.session.awaiting = "admin_p_guide";
      await askStep(ctx, "📄 Send the <b>delivery instructions</b> for this product (shown with the key on delivery). Send <code>-</code> to clear.");
      return;
    }
    case "keys": return variantsForKeys(ctx, id);
    case "kv": {
      ctx.session.awaiting = "admin_addkeys";
      ctx.session.admVariantId = id;
      await ctx.reply([
        "📦 Paste stock <b>one per line</b> — encrypted and added instantly.",
        "",
        "• License keys: one key per line",
        "• Accounts: <code>id|password</code> per line",
        "• With 2FA: <code>id|password|2fa_secret</code>",
        "",
        "📄 <b>Or upload a .txt file</b> — one item per line, up to 5000. Just send the file here.",
        "",
        "♻️ <b>Already delivered something (e.g. a test order)?</b> Just paste it again — it goes back on sale instead of creating a duplicate.",
      ].join("\\n"), { parse_mode: "HTML" });
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
    case "binapi":
      ctx.session.awaiting = "admin_binance_key";
      await askStep(ctx, "🔗 <b>Set Binance API</b>\nSend your Binance <b>API Key</b> (read-only key with Pay/Wallet read access). Your messages are deleted after.");
      return;
    case "bintest": {
      await ctx.reply("🧪 Testing Binance API…");
      const r = await testBinanceApi();
      await ctx.reply(r.ok ? `✅ ${r.detail}` : `❌ Binance API failed:\n<code>${escapeHtml(r.detail)}</code>\n\nCommon fixes: enable READ on the key, remove IP restriction (or allow the VPS IP), and make sure the server clock is correct.`, { parse_mode: "HTML" });
      return;
    }
    case "apikeys": return apiKeysView(ctx);
    case "apiup":
      await setApiKeyScopes(id, ["catalog:read", "orders:read", "orders:write", "wallet:read"]);
      flash(ctx, "⬆️ Purchasing + wallet access enabled on that key. It works immediately — no need to regenerate.");
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
      flash(ctx, "🔑 Key revoked.");
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
      const p = await getProductBriefById(id);
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
    case "webpass":
      ctx.session.awaiting = "admin_web_email";
      await askStep(ctx, "🔐 <b>Reset web admin login</b>\nSend the <b>email</b> for the web panel login (e.g. <code>admin@getitsasta.cloud</code>):");
      return;
    case "chpass":
      ctx.session.awaiting = "admin_newpass";
      await askStep(ctx, "🔑 Send the <b>new</b> admin passcode (at least 6 characters). Keep it private — your message will be deleted after.");
      return;
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
  if (awaiting === "admin_totp_code") {
    // No session exists yet, so this must run before the isBotAdmin guard below.
    const tgId = ctx.from?.id;
    await ctx.deleteMessage().catch(() => undefined);
    if (tgId === undefined) return true;
    const redis = getRedis();
    const tries = await redis.incr(`botadmin:2fa:${tgId}`);
    if (tries === 1) await redis.expire(`botadmin:2fa:${tgId}`, ATTEMPT_WINDOW_SEC);
    if (tries > MAX_ATTEMPTS) { await ctx.reply("⛔ Too many attempts. Send /admin to start again."); return true; }
    if (!(await checkAdminTotp(text))) {
      ctx.session.awaiting = "admin_totp_code";
      await ctx.reply("❌ That code didn't match. Send the current 6-digit code, or /admin to start again.");
      return true;
    }
    await redis.del(`botadmin:2fa:${tgId}`);
    await grantAdminSession(ctx, tgId);
    return true;
  }
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
        TOO_OLD: "❌ That transaction arrived BEFORE this order was created, so it cannot be the payment for it. Check you've got the right transaction — this is exactly how an unpaid order gets released by mistake.",
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
    if (keys.length === 0) { await ctx.reply("❌ Nothing detected."); return true; }
    const r = await addStock(variantId, keys);
    const unit = r.type === "DIGITAL_ACCOUNT" ? "account" : "key";
    const bits = [`✅ Added <b>${r.added}</b> ${unit}(s)`];
    if (r.relisted > 0) bits.push(`♻️ Re-listed <b>${r.relisted}</b> previously delivered ${unit}(s) — back on sale, not duplicated`);
    if (r.skipped > 0) bits.push(`⏭ Skipped <b>${r.skipped}</b> already in stock (duplicate)`);
    await ctx.reply(bits.join("\n"), { parse_mode: "HTML" });
    await sendPanel(ctx, false);
    return true;
  }

  if (awaiting === "admin_p_name") {
    const name = text.slice(0, 200);
    if (!name) { await askStep(ctx, "Please send a product name."); ctx.session.awaiting = "admin_p_name"; return true; }
    const nameHtml = hasCustomEmoji(ctx) ? composeBroadcastHtml(ctx) : undefined;
    ctx.session.admDraft = { ...(ctx.session.admDraft ?? {}), name, nameHtml };
    ctx.session.awaiting = "admin_p_desc";
    await askStep(ctx, `<b>New product · Step 2/6</b>\nSend a <b>description</b> for “${name}” (or send <code>-</code> to skip):`);
    return true;
  }

  if (awaiting === "admin_p_desc") {
    const desc = text === "-" ? "" : text.slice(0, 4000);
    const descriptionHtml = desc && hasCustomEmoji(ctx) ? composeBroadcastHtml(ctx) : undefined;
    ctx.session.admDraft = { ...(ctx.session.admDraft ?? {}), description: desc, descriptionHtml };
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
    const { productId, existed } = await createProductFull({
      name: d.name,
      nameHtml: d.nameHtml,
      description: d.description,
      descriptionHtml: d.descriptionHtml,
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
      existed
        ? `♻️ <b>${escapeHtml(d.name)}</b> already exists — using the <b>same product</b> instead of creating a duplicate.\nAdd your stock to it below; it stays one single listing.`
        : `✅ <b>Product created</b> (as draft).\nAdd stock, then activate to put it live & announce it to users.`,
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
  if (awaiting === "admin_p_btntext") {
    const pid = ctx.session.admProductId ?? "";
    await setProductButton(pid, text.trim() === "-" ? "" : text.trim(), null);
    const kb = new InlineKeyboard()
      .text("🟢 Green", cb("adm", "pbtncol", `${pid}~success`)).text("🔵 Blue", cb("adm", "pbtncol", `${pid}~primary`)).text("🔴 Red", cb("adm", "pbtncol", `${pid}~danger`)).row()
      .text("⚪️ Default", cb("adm", "pbtncol", `${pid}~default`)).row();
    await ctx.reply(text.trim() === "-" ? "Label kept. Pick the button colour:" : "✅ Label saved. Pick the button colour:", { parse_mode: "HTML", reply_markup: kb });
    ctx.session.awaiting = null;
    return true;
  }
  if (awaiting === "admin_p_guide") {
    const pid = ctx.session.admProductId ?? ""; ctx.session.admProductId = undefined;
    await setProductActivationGuide(pid, text.trim() === "-" ? "" : text);
    await ctx.reply(text.trim() === "-" ? "🧹 Delivery instructions cleared." : "✅ Delivery instructions updated for this product.");
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

  if (awaiting === "admin_sup_name") {
    ctx.session.supDraft = { ...(ctx.session.supDraft ?? {}), name: text.trim().slice(0, 80) };
    ctx.session.awaiting = "admin_sup_url";
    await askStep(ctx, "Step 2/4 — send the supplier <b>API base URL</b> (e.g. <code>https://api.supplier.com/v1</code>):");
    return true;
  }
  if (awaiting === "admin_sup_url") {
    ctx.session.supDraft = { ...(ctx.session.supDraft ?? {}), url: text.trim() };
    ctx.session.awaiting = "admin_sup_key";
    await askStep(ctx, "Step 3/4 — send the supplier <b>API key</b> (deleted after saving):");
    return true;
  }
  if (awaiting === "admin_sup_key") {
    await ctx.deleteMessage().catch(() => undefined);
    ctx.session.supDraft = { ...(ctx.session.supDraft ?? {}), key: text.trim() };
    ctx.session.awaiting = "admin_sup_markup";
    await askStep(ctx, "Step 4/4 — send your <b>markup %</b> (e.g. <code>20</code> for +20%):");
    return true;
  }
  if (awaiting === "admin_sup_markup") {
    const d = ctx.session.supDraft ?? {}; ctx.session.supDraft = undefined;
    const pct = Number.parseFloat(text.trim().replace(/[^0-9.]/g, ""));
    if (!d.name || !d.url || !d.key) { await ctx.reply("Draft incomplete — start again from 🏭 Suppliers."); await sendPanel(ctx, false); return true; }
    const { id } = await addSupplier(d.name, d.url, d.key, Number.isFinite(pct) ? pct : 20);
    await ctx.reply("✅ Supplier added. Testing connection…");
    // A pasted Swagger/docs URL is not an API base — fix it before testing.
    const norm = await normalizeSupplierBase(id).catch(() => ({ changed: false, detail: "" }));
    if (norm.changed && norm.detail) await ctx.reply(norm.detail, { parse_mode: "HTML" });
    const t = await testSupplier(id);
    await ctx.reply(t.ok ? `✅ ${escapeHtml(t.detail)}\nTap 🔄 Sync to import their catalog.` : `⚠️ Saved, but test failed: ${escapeHtml(t.detail)}\nCheck the base URL/key/endpoints.`);
    await suppliersView(ctx);
    return true;
  }
  if (awaiting === "admin_binance_key") {
    await ctx.deleteMessage().catch(() => undefined);
    ctx.session.binanceKeyTmp = text.trim();
    ctx.session.awaiting = "admin_binance_secret";
    await askStep(ctx, "🔗 Now send your Binance <b>API Secret</b>:");
    return true;
  }
  if (awaiting === "admin_binance_secret") {
    await ctx.deleteMessage().catch(() => undefined);
    const key = ctx.session.binanceKeyTmp ?? ""; ctx.session.binanceKeyTmp = undefined;
    const secret = text.trim();
    if (!key || !secret) { await ctx.reply("Missing key or secret — tap 🔗 Set Binance API to retry."); return true; }
    await setBinanceCreds(key, secret);
    await ctx.reply("🔐 Saved (encrypted). Testing the connection…");
    const r = await testBinanceApi();
    await ctx.reply(r.ok ? `✅ ${r.detail}` : `❌ ${r.detail}`);
    await sendPanel(ctx, false);
    return true;
  }
  if (awaiting === "admin_delivery_note") {
    if (text.trim() === "-") { await setDeliveryInstructions(""); await ctx.reply("🧹 Delivery instructions cleared."); await sendPanel(ctx, false); return true; }
    await setDeliveryInstructions(composeBroadcastHtml(ctx));
    await ctx.reply("✅ Delivery instructions saved — customers will see them after every order.");
    await sendPanel(ctx, false);
    return true;
  }
  if (awaiting === "admin_web_email") {
    const email = text.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { await askStep(ctx, "Please send a valid email, e.g. admin@getitsasta.cloud"); ctx.session.awaiting = "admin_web_email"; return true; }
    ctx.session.webAdminEmail = email;
    ctx.session.awaiting = "admin_web_pass";
    await askStep(ctx, "🔐 Now send the <b>new password</b> (at least 12 characters). Your message will be deleted after.");
    return true;
  }
  if (awaiting === "admin_web_pass") {
    await ctx.deleteMessage().catch(() => undefined);
    const email = ctx.session.webAdminEmail ?? ""; ctx.session.webAdminEmail = undefined;
    const pass = text.trim();
    const r = await setWebAdminPassword(email, pass);
    if (r.ok) await ctx.reply(`✅ Web admin login updated.\nEmail: <code>${escapeHtml(email)}</code>\nUse it to sign in to the web panel.`, { parse_mode: "HTML" });
    else await ctx.reply(r.reason === "WEAK" ? "⚠️ Password too short — use at least 12 characters. Tap 🔐 Web login password again." : r.reason === "BAD_EMAIL" ? "⚠️ That email looks invalid." : "❌ Couldn't set it (role missing). Run a deploy first.");
    await sendPanel(ctx, false);
    return true;
  }
  if (awaiting === "admin_newpass") {
    await ctx.deleteMessage().catch(() => undefined);
    const pass = text.trim();
    if (pass.length < 6) { await ctx.reply("⚠️ Too short — use at least 6 characters. Tap 🔑 Change passcode to try again."); return true; }
    await setAdminPasscode(pass);
    await ctx.reply("✅ Admin passcode changed. It takes effect immediately for new logins.\nTip: use 🚪 Logout all to force re-login on other devices.");
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
    const chg = await setProductPublicPrice(pid, { usdMinor, inrMinor });
    const rate = await getInrPerUsdt();
    const shownUsd = usdMinor > 0 ? usdMinor : Math.max(1, Math.round(inrMinor / rate));
    const shownInr = inrMinor > 0 ? inrMinor : Math.max(1, Math.round(usdMinor * rate));
    const parts = [`$${(shownUsd / 100).toFixed(2)}`, `₹${(shownInr / 100).toFixed(2)}`].join(" · ") + ((usdMinor > 0) !== (inrMinor > 0) ? ` <i>(the skipped one was auto-converted at ${rate} INR = $1)</i>` : "");
    await ctx.reply(`✅ Public price updated: <b>${parts}</b> (all variants).`, { parse_mode: "HTML" });
    // Offer the customer-facing alert only when the price actually moved.
    if (chg.oldMinor !== null && chg.newMinor !== null && chg.oldMinor !== chg.newMinor) {
      const dropped = chg.newMinor < chg.oldMinor;
      const sym = chg.currency === "INR" ? "₹" : "$";
      ctx.session.priceAlert = { productId: pid, oldMinor: chg.oldMinor, newMinor: chg.newMinor, currency: chg.currency };
      await ctx.reply(
        [
          dropped ? "📉 <b>Price went DOWN</b>" : "📈 <b>Price went UP</b>",
          `${sym}${(chg.oldMinor / 100).toFixed(2)} → <b>${sym}${(chg.newMinor / 100).toFixed(2)}</b>`,
          "",
          dropped
            ? "Tell everyone? They'll get a <b>PRICE CRASHED — hurry, grab now</b> alert with a buy button."
            : "Tell everyone? They'll get a <b>due to low supply, price increased</b> notice with a buy button.",
        ].join("\n"),
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .add(sbtn(dropped ? "📣 Announce the price crash" : "📣 Announce the increase", cb("adm", "pricealert"), dropped ? "success" : "primary")).row()
            .text("🤫 Skip", cb("adm", "prod", pid)),
        },
      );
      return true;
    }
    await productView(ctx, pid);
    return true;
  }
  if (awaiting === "admin_dm_reply") {
    const target = ctx.session.dmTarget ?? ""; ctx.session.dmTarget = undefined;
    if (!target) { await ctx.reply("No customer selected."); return true; }
    const ok = await dmUser(target, text.trim().slice(0, 3000));
    await ctx.reply(ok ? "✅ Reply sent to the customer." : "❌ Couldn't reach that customer.");
    return true;
  }
  if (awaiting === "admin_emoji_capture") {
    const ents = ((ctx.message?.entities ?? []) as Array<{ type: string; offset: number; length: number; custom_emoji_id?: string }>).filter((e) => e.type === "custom_emoji");
    const first = ents[0];
    if (!first?.custom_emoji_id) { await askStep(ctx, "That wasn't a premium emoji. Send a single premium emoji (needs Telegram Premium)."); ctx.session.awaiting = "admin_emoji_capture"; return true; }
    ctx.session.pendEmojiId = first.custom_emoji_id;
    ctx.session.pendEmojiGlyph = text.slice(first.offset, first.offset + first.length) || "✨";
    ctx.session.awaiting = "admin_emoji_name";
    await askStep(ctx, `✅ Captured! Now send a short <b>name</b> for it (e.g. <code>fire</code>, <code>vip</code>). Use a built-in name to theme that spot: <i>${escapeHtml(EMOJI_NAME_HINTS)}</i>`);
    return true;
  }
  if (awaiting === "admin_emoji_name") {
    const name = text.trim().toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 24);
    const eid = ctx.session.pendEmojiId; const glyph = ctx.session.pendEmojiGlyph ?? "✨";
    ctx.session.pendEmojiId = ctx.session.pendEmojiGlyph = undefined;
    if (!name || !eid) { await ctx.reply("Please send a valid name (letters/numbers)."); return true; }
    await setCustomEmojiEntry(name, eid, glyph);
    setDynamicEmojis(await getCustomEmojiRegistry());
    await ctx.reply(`✅ Saved <b>${escapeHtml(name)}</b> → <tg-emoji emoji-id="${eid}">${glyph}</tg-emoji>. It now shows across the bot.`, { parse_mode: "HTML" }).catch(() => ctx.reply(`✅ Saved ${name}.`));
    await emojiRegistryView(ctx);
    return true;
  }
  if (awaiting === "admin_bnpl") {
    const parts = text.trim().split(/\s+/);
    const identifier = parts[0] ?? "";
    const amt = Number.parseFloat(parts[1] ?? "");
    if (!identifier || !Number.isFinite(amt) || amt < 0) { await askStep(ctx, "Format: <@user or id> <amount>. Example: @john 50"); ctx.session.awaiting = "admin_bnpl"; return true; }
    const u = await resolveUserByTelegramId(identifier);
    if (!u) { await ctx.reply("❌ User not found (they must have used the bot)."); return true; }
    await setBnplLimit(u.id, Math.round(amt * 100));
    const st = await getBnplStatus(u.id);
    await ctx.reply(`✅ BNPL limit for ${escapeHtml(u.label)} set to <b>${(st.limitMinor / 100).toFixed(2)} ${st.currency}</b> (owed: ${(st.outstandingMinor / 100).toFixed(2)}).`, { parse_mode: "HTML" });
    await sendPanel(ctx, false);
    return true;
  }
  if (awaiting === "admin_ref_first" || awaiting === "admin_ref_repeat") {
    const kind = awaiting === "admin_ref_repeat" ? "repeat" : "first";
    const pct = Number.parseFloat(text.trim().replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) { await askStep(ctx, "Please send a percentage between 0 and 100, e.g. 5"); ctx.session.awaiting = awaiting; return true; }
    await setReferralRate(kind, pct);
    await ctx.reply(`✅ ${kind === "repeat" ? "Repeat" : "First-purchase"} referral reward set to <b>${pct}%</b>.`, { parse_mode: "HTML" });
    await refRatesView(ctx);
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

  if (awaiting === "admin_tr_key") {
    const provider = ctx.session.trProvider ?? "libre";
    ctx.session.trProvider = undefined;
    const key = text.trim() === "-" ? undefined : text.trim();
    ctx.session.awaiting = "admin_tr_url";
    ctx.session.trKey = key;
    await askStep(ctx, "🌐 Send the API <b>endpoint URL</b>, or <code>-</code> to use the provider default:");
    ctx.session.trProvider = provider;
    return true;
  }
  if (awaiting === "admin_tr_url") {
    const provider = ctx.session.trProvider ?? "libre";
    const key = ctx.session.trKey;
    ctx.session.trProvider = undefined;
    ctx.session.trKey = undefined;
    const url = text.trim() === "-" ? undefined : text.trim();
    await setTranslateCreds(provider, url, key);
    await ctx.reply(`✅ Auto-translate set to <b>${provider}</b>. Product names now follow each customer's language.`, { parse_mode: "HTML" });
    await sendPanel(ctx, false);
    return true;
  }
  if (awaiting === "admin_bnpl_user") {
    const uid = ctx.session.userTarget ?? ""; ctx.session.userTarget = undefined;
    const val = Number.parseFloat(text.trim().replace(/[^0-9.]/g, ""));
    if (!uid || !Number.isFinite(val) || val < 0) { await ctx.reply("Couldn't set that limit."); return true; }
    await setBnplLimit(uid, Math.round(val * 100));
    await ctx.reply(val > 0 ? `🕒 BNPL limit set to <b>${val.toFixed(2)}</b>.` : "🕒 BNPL limit removed.", { parse_mode: "HTML" });
    await userDetailView(ctx, uid);
    return true;
  }
  if (awaiting === "admin_sup_docs") {
    const sid = ctx.session.supTarget ?? ""; ctx.session.supTarget = undefined;
    if (!sid) { await ctx.reply("That supplier expired — open Vendor APIs again."); return true; }
    await ctx.reply("📄 Reading the docs and running a live check…");
    const r = await learnSupplierDocs(sid, text.trim());
    await ctx.reply(r.detail, { parse_mode: "HTML" });
    await sendPanel(ctx, false);
    return true;
  }
  if (awaiting === "admin_fup_text") {
    await setFollowupConfig({ text: composeBroadcastHtml(ctx) });
    await ctx.reply("✅ Message saved. Tap 📤 Send me a preview to see it.");
    await handleAdminCallback(ctx, "fup", []);
    return true;
  }
  if (awaiting === "admin_fup_delay") {
    const n = Number.parseInt(text.trim().replace(/[^0-9]/g, ""), 10);
    await setFollowupConfig({ delayMins: Number.isFinite(n) ? Math.min(n, 10080) : 60 });
    await ctx.reply(`⏱ Delay set to <b>${Number.isFinite(n) ? Math.min(n, 10080) : 60}</b> minutes.`, { parse_mode: "HTML" });
    await handleAdminCallback(ctx, "fup", []);
    return true;
  }
  if (awaiting === "admin_fup_btn") {
    if (text.trim() === "-") {
      await setFollowupConfig({ btnText: null, btnUrl: null });
      await ctx.reply("🔗 Button removed.");
    } else {
      const [label, url] = text.split("|").map((x) => x.trim());
      if (!label || !url || !/^https?:\/\//i.test(url)) {
        ctx.session.awaiting = "admin_fup_btn";
        await askStep(ctx, "⚠️ Use <code>Label | https://link</code> — the link must start with <code>https://</code>.");
        return true;
      }
      await setFollowupConfig({ btnText: label.slice(0, 40), btnUrl: url });
      await ctx.reply(`🔗 Button set: <b>${escapeHtml(label)}</b> → ${escapeHtml(url)}`, { parse_mode: "HTML" });
    }
    await handleAdminCallback(ctx, "fup", []);
    return true;
  }
  if (awaiting === "admin_rev_reply") {
    const rid = ctx.session.revTarget ?? ""; ctx.session.revTarget = undefined;
    const ok = await replyToReview(rid, text.trim());
    await ctx.reply(ok ? "💬 Reply saved — it shows under that review." : "Couldn't save that reply.");
    await handleAdminCallback(ctx, "revs", ["1"]);
    return true;
  }
  if (awaiting === "admin_tst_search") {
    ctx.session.tstSearch = text.trim().slice(0, 60);
    await handleAdminCallback(ctx, "tst", ["1"]);
    return true;
  }
  if (awaiting === "admin_tst_name") {
    ctx.session.tstDraft = { ...(ctx.session.tstDraft ?? {}), customerName: text.trim().slice(0, 120) };
    ctx.session.awaiting = "admin_tst_body";
    await askStep(ctx, "💬 <b>Step 2/5</b> — send the testimonial <b>text</b> exactly as the customer wrote it:");
    return true;
  }
  if (awaiting === "admin_tst_body") {
    ctx.session.tstDraft = { ...(ctx.session.tstDraft ?? {}), body: text.trim().slice(0, 2000) };
    ctx.session.awaiting = "admin_tst_rating";
    await askStep(ctx, "⭐ <b>Step 3/5</b> — send the rating they gave, <code>1</code>–<code>5</code>:");
    return true;
  }
  if (awaiting === "admin_tst_rating") {
    const n = Number.parseInt(text.trim().replace(/[^0-9]/g, ""), 10);
    ctx.session.tstDraft = { ...(ctx.session.tstDraft ?? {}), rating: Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 5 };
    ctx.session.awaiting = "admin_tst_product";
    await askStep(ctx, "📦 <b>Step 4/5</b> — which <b>product</b> is it about? Send the name, or <code>-</code> to skip:");
    return true;
  }
  if (awaiting === "admin_tst_product") {
    ctx.session.tstDraft = { ...(ctx.session.tstDraft ?? {}), productName: text.trim() === "-" ? null : text.trim().slice(0, 200) };
    ctx.session.awaiting = "admin_tst_source";
    await askStep(ctx, [
      "📄 <b>Step 5/5</b> — where did this feedback come from?",
      "",
      "e.g. <code>Telegram DM 04 Aug</code>, <code>email from asif@…</code>, <code>screenshot in group</code>",
      "",
      "<i>Required, so every published quote is traceable to real feedback you received.</i>",
    ].join("\n"));
    return true;
  }
  if (awaiting === "admin_tst_source") {
    const d = ctx.session.tstDraft ?? {};
    ctx.session.tstDraft = undefined;
    if (!d.customerName || !d.body) { await ctx.reply("Draft incomplete — start again from 💬 Testimonials."); return true; }
    try {
      const r = await createTestimonial(
        { customerName: d.customerName, body: d.body, rating: d.rating ?? 5, productName: d.productName ?? null, source: text.trim(), status: "DRAFT" },
        "bot-admin",
      );
      await ctx.reply(
        [
          "✅ <b>Saved as draft.</b>",
          r.spamScore >= 40 ? `⚠️ Spam score <b>${r.spamScore}</b>/100 — worth a second look.` : "",
          "",
          "Open it to publish, pin or feature it.",
        ].filter(Boolean).join("\n"),
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("💬 Open it", cb("adm", "tstv", r.id)).row().text("💬 All testimonials", cb("adm", "tst", "1")) },
      );
    } catch (e) {
      await ctx.reply(String(e).includes("SOURCE") ? "⚠️ A source is required." : "⚠️ Couldn't save that.");
    }
    return true;
  }
  if (awaiting === "admin_tst_order") {
    const tid = ctx.session.tstTarget ?? ""; ctx.session.tstTarget = undefined;
    const n = Number.parseInt(text.trim().replace(/[^0-9-]/g, ""), 10);
    await setTestimonialOrder(tid, Number.isFinite(n) ? n : 0, "bot-admin");
    await ctx.reply(`🔢 Order set to <b>${Number.isFinite(n) ? n : 0}</b>.`, { parse_mode: "HTML" });
    await handleAdminCallback(ctx, "tstv", [tid]);
    return true;
  }
  if (awaiting === "admin_tst_editbody") {
    const tid = ctx.session.tstTarget ?? ""; ctx.session.tstTarget = undefined;
    await updateTestimonial(tid, { body: text.trim() }, "bot-admin");
    await ctx.reply("✏️ Text updated.");
    await handleAdminCallback(ctx, "tstv", [tid]);
    return true;
  }
  if (awaiting === "admin_tst_import") {
    try {
      const r = await importTestimonials(text, "bot-admin");
      await ctx.reply(`📥 Imported <b>${r.added}</b>${r.skipped ? `, skipped <b>${r.skipped}</b> (missing name/text/source)` : ""}. They are PENDING until you publish them.`, { parse_mode: "HTML" });
    } catch {
      await ctx.reply("⚠️ That is not valid JSON. Export a file first to see the expected shape.");
    }
    await handleAdminCallback(ctx, "tst", ["1"]);
    return true;
  }
  if (awaiting === "admin_loy_tiers") {
    const tiers = text.split("\n").map((l) => l.split("|").map((x) => x.trim())).filter((p) => p[0])
      .map((p) => ({ name: p[0] ?? "", minSpendMinor: Math.round(Number.parseFloat((p[1] ?? "0").replace(/[^0-9.]/g, "")) * 100) || 0, perk: p[2] ?? "" }));
    if (tiers.length === 0) { await ctx.reply("⚠️ Couldn't read any tiers — use <code>Name | amount | perk</code> per line.", { parse_mode: "HTML" }); return true; }
    await setTiers(tiers);
    await ctx.reply(`🏆 Saved <b>${tiers.length}</b> tier(s).`, { parse_mode: "HTML" });
    await handleAdminCallback(ctx, "loy", []);
    return true;
  }
  if (awaiting === "admin_gift_user") {
    const u = await resolveUserByTelegramId(text.trim().replace(/^@/, "")) ?? null;
    if (!u) {
      const byId = await getUserById(text.trim()).catch(() => null);
      if (!byId) { await ctx.reply("Couldn't find that customer. Send their @username or Telegram ID."); return true; }
      ctx.session.giftUser = byId.id;
    } else ctx.session.giftUser = u.id;
    ctx.session.awaiting = "admin_gift_title";
    await askStep(ctx, "🎁 What is the gift? (short title the customer will see, e.g. <code>Free 1-month Netflix</code>)");
    return true;
  }
  if (awaiting === "admin_gift_title") {
    ctx.session.giftTitle = text.trim().slice(0, 120);
    ctx.session.awaiting = "admin_gift_detail";
    await askStep(ctx, "📝 Any detail for them? Send <code>-</code> to skip.");
    return true;
  }
  if (awaiting === "admin_gift_detail") {
    const uid = ctx.session.giftUser ?? ""; const title = ctx.session.giftTitle ?? "";
    ctx.session.giftUser = undefined; ctx.session.giftTitle = undefined;
    if (!uid || !title) { await ctx.reply("Gift draft expired — start again from 🎁 Gifts."); return true; }
    await createGift(uid, title, text.trim() === "-" ? null : text.trim(), "bot-admin");
    await ctx.reply("🎁 <b>Gift created.</b> The customer has been notified — now send it to them and tap ✅ Mark delivered.", { parse_mode: "HTML" });
    await handleAdminCallback(ctx, "gifts", []);
    return true;
  }
  if (awaiting === "admin_autop_hours") {
    const n = Number.parseInt(text.trim().replace(/[^0-9]/g, ""), 10);
    const a = await setAutoPromo({ everyHours: Number.isFinite(n) ? Math.max(1, n) : 12 });
    await ctx.reply(`⏱ Auto-Promo will post every <b>${a.everyHours}h</b>.`, { parse_mode: "HTML" });
    await handleAdminCallback(ctx, "autop", []);
    return true;
  }
  if (awaiting === "admin_spn_day") {
    const n = Number.parseInt(text.trim().replace(/[^0-9]/g, ""), 10);
    const c = await setSpinConfig({ maxSpinsPerDay: Number.isFinite(n) ? n : 3 });
    await ctx.reply(`🔁 Limit set to <b>${c.maxSpinsPerDay}</b> spins per customer per day.`, { parse_mode: "HTML" });
    await handleAdminCallback(ctx, "spncfg", []);
    return true;
  }
  if (awaiting === "admin_spn_min") {
    const v = Number.parseFloat(text.trim().replace(/[^0-9.]/g, ""));
    const c = await setSpinConfig({ minSpendMinor: Math.max(0, Math.round((Number.isFinite(v) ? v : 10) * 100)) });
    await ctx.reply(`🎯 Orders under <b>${(c.minSpendMinor / 100).toFixed(2)}</b> now win nothing.`, { parse_mode: "HTML" });
    await handleAdminCallback(ctx, "spncfg", []);
    return true;
  }
  if (awaiting === "admin_spn_max") {
    const v = Number.parseFloat(text.trim().replace(/[^0-9.]/g, ""));
    const c = await setSpinConfig({ maxRewardMinor: Math.max(1, Math.round((Number.isFinite(v) ? v : 0.01) * 100)) });
    await ctx.reply(`🎁 A single spin can now pay at most <b>${(c.maxRewardMinor / 100).toFixed(2)}</b>.`, { parse_mode: "HTML" });
    await handleAdminCallback(ctx, "spncfg", []);
    return true;
  }
  if (awaiting === "admin_spn_targets") {
    const nums = text.split(/[,\s]+/).map((x) => Math.round(Number.parseFloat(x.replace(/[^0-9.]/g, "")) * 100)).filter((n) => Number.isFinite(n) && n > 0);
    if (nums.length === 0) { await ctx.reply("⚠️ Send at least one amount, e.g. <code>50, 100</code>", { parse_mode: "HTML" }); return true; }
    const c = await setSpinConfig({ targetsMinor: nums });
    await ctx.reply(`🎯 Amounts set: ${c.targetsMinor.map((t) => (t / 100).toFixed(2)).join(" · ")}\nMax reward each: ${c.targetsMinor.map((t) => (Math.floor((t * c.rewardBp) / 10000) / 100).toFixed(2)).join(" · ")}`);
    await handleAdminCallback(ctx, "spncfg", []);
    return true;
  }
  if (awaiting === "admin_spn_days") {
    const n = Number.parseInt(text.trim().replace(/[^0-9]/g, ""), 10);
    const c = await setSpinConfig({ expiryDays: Number.isFinite(n) ? n : 14 });
    await ctx.reply(`⏳ Customers get <b>${c.expiryDays}</b> days.`, { parse_mode: "HTML" });
    await handleAdminCallback(ctx, "spncfg", []);
    return true;
  }
  if (awaiting === "admin_tool_adjust") {
    const pct = Number.parseFloat(text.trim().replace(/[^0-9.-]/g, ""));
    if (!Number.isFinite(pct) || pct === 0) { ctx.session.awaiting = "admin_tool_adjust"; await askStep(ctx, "Send a percentage, e.g. <code>10</code> or <code>-5</code>"); return true; }
    const r = await bulkAdjustPrices(pct, true);
    if (r.changed === 0) { await ctx.reply("Nothing would change."); return true; }
    ctx.session.toolPct = pct;
    await ctx.reply(
      [`📈 <b>${pct > 0 ? "+" : ""}${pct}%</b> would change <b>${r.changed}</b> price(s):`, "", ...r.sample.map((x) => `• ${escapeHtml(x)}`), "", "<i>Nothing is saved until you confirm.</i>"].join("\n"),
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().add(sbtn(`✅ Apply ${pct > 0 ? "+" : ""}${pct}%`, cb("adm", "tladjgo"), "success")).row().text("✖️ Cancel", cb("adm", "m_tools")) },
    );
    return true;
  }
  if (awaiting === "admin_tool_key") {
    const t = await findOrderByKey(text);
    if (!t.found) { await ctx.reply("🔍 No match — that key or account is not in your stock."); return true; }
    await ctx.reply(
      [
        "🔍 <b>Key traced</b>",
        `📦 ${escapeHtml(t.product ?? "—")}`,
        `🏷 Type: ${t.kind === "DIGITAL_ACCOUNT" ? "account" : "license key"} · status <b>${t.status}</b>`,
        t.orderNumber ? `🧾 Order <b>${escapeHtml(t.orderNumber)}</b>` : "🧾 <i>Not sold — still in stock</i>",
        t.buyer ? `👤 ${escapeHtml(t.buyer)}  🆔 <code>${t.buyerTelegramId ?? "—"}</code>` : "",
        t.deliveredAt ? `📅 Delivered ${t.deliveredAt.toISOString().slice(0, 16).replace("T", " ")}` : "",
      ].filter(Boolean).join("\n"),
      { parse_mode: "HTML" },
    );
    return true;
  }
  if (awaiting === "admin_tool_risk") {
    const q = text.trim().replace(/^@/, "");
    const found = (await resolveUserByTelegramId(q)) ?? null;
    const uid = found?.id ?? (await getUserById(q).catch(() => null))?.id ?? null;
    if (!uid) { await ctx.reply("Couldn't find that customer."); return true; }
    const r = await customerRisk(uid);
    if (!r) { await ctx.reply("Couldn't build a profile for them."); return true; }
    const bar = r.score >= 60 ? "🔴" : r.score >= 30 ? "🟡" : "🟢";
    await ctx.reply(
      [
        `🛡 <b>${escapeHtml(r.label)}</b>`,
        `${bar} Risk score <b>${r.score}</b>/100`,
        "",
        `📦 Orders: <b>${r.orders}</b> · ✅ completed <b>${r.completed}</b>`,
        `🔄 Replacement claims: <b>${r.claims}</b> (approved <b>${r.claimsApproved}</b>)`,
        `↩️ Refunds: <b>${r.refunds}</b>`,
        `📅 Account age: <b>${r.accountAgeDays}</b> day(s)`,
        r.flags.length ? `\n⚠️ <b>Flags</b>\n${r.flags.map((f) => `• ${escapeHtml(f)}`).join("\n")}` : "\n✅ No flags",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
    return true;
  }
  if (awaiting === "admin_fx_surcharge") {
    const v = Number.parseFloat(text.trim().replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(v) || v < 0) { ctx.session.awaiting = "admin_fx_surcharge"; await askStep(ctx, "Send a percentage, e.g. <code>5</code>"); return true; }
    const bp = await setInrSurchargeBp(Math.round(v * 100));
    const rate = await getInrPerUsdt();
    await ctx.reply(
      [
        `✅ INR surcharge set to <b>${(bp / 100).toFixed(1)}%</b>.`,
        "",
        `\$10.00 now prices at <b>₹${(1000 * rate * (10000 + bp) / 10000 / 100).toFixed(2)}</b>.`,
        "",
        "New prices and any derived INR price use it immediately. Existing INR prices you typed by hand are unchanged — re-save a product to re-derive.",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
    await sendPanel(ctx, false);
    return true;
  }
  if (awaiting === "admin_fx_rate") {
    const v = Number.parseFloat(text.trim().replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(v) || v <= 0) {
      ctx.session.awaiting = "admin_fx_rate";
      await askStep(ctx, "Please send a positive number, e.g. <code>100</code>");
      return true;
    }
    await setInrPerUsdt(v);
    await ctx.reply(
      [
        `✅ Rate set: <b>${v} INR = 1 USD (USDT)</b>`,
        "",
        `₹${v} → <b>$1.00</b>`,
        `$3.00 → <b>₹${(v * 3).toFixed(2)}</b>`,
        "",
        "Applies immediately to wallet deductions, UPI top-up credits, Binance quotes and price display.",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
    await sendPanel(ctx, false);
    return true;
  }
  if (awaiting === "admin_p_manqty") {
    const pid = ctx.session.admProductId ?? "";
    if (text.trim() === "-") {
      await setProductManualStock(pid, null);
      await ctx.reply("♾ Quantity set to <b>unlimited</b> — this manual product never shows sold out.", { parse_mode: "HTML" });
    } else {
      const n = Number.parseInt(text.trim().replace(/[^0-9]/g, ""), 10);
      await setProductManualStock(pid, Number.isFinite(n) ? n : 0);
      await ctx.reply(`🔢 Quantity set to <b>${Number.isFinite(n) ? n : 0}</b>. It counts down with each sale.`, { parse_mode: "HTML" });
    }
    await productView(ctx, pid);
    return true;
  }
  if (awaiting === "admin_p_reuseqty") {
    const pid = ctx.session.admProductId ?? "";
    if (text.trim() === "-") {
      await setProductReusableStock(pid, null);
      await ctx.reply("♾ Quantity set to <b>unlimited</b> — it will never run out.", { parse_mode: "HTML" });
    } else {
      const n = Number.parseInt(text.trim().replace(/[^0-9]/g, ""), 10);
      await setProductReusableStock(pid, Number.isFinite(n) ? n : 0);
      await ctx.reply(`🔢 Quantity set to <b>${Number.isFinite(n) ? n : 0}</b>. It counts down with each sale.`, { parse_mode: "HTML" });
    }
    await productView(ctx, pid);
    return true;
  }
  if (awaiting === "admin_p_reuse") {
    const pid = ctx.session.admProductId ?? "";
    if (text.trim() === "-") {
      await setProductReusableSecret(pid, null);
      await ctx.reply("♾ Turned off — this product uses normal stock again.");
    } else {
      await setProductReusableSecret(pid, text.trim());
      await ctx.reply("♾ Saved. Every buyer now receives this same value, and the product will never show out of stock.");
    }
    await productView(ctx, pid);
    return true;
  }
  if (awaiting === "admin_p_warrantydays") {
    const pid = ctx.session.admProductId ?? "";
    const d = Number.parseInt(text.trim().replace(/[^0-9]/g, ""), 10);
    await setProductWarrantyDays(pid, Number.isFinite(d) && d > 0 ? d : null);
    await ctx.reply(Number.isFinite(d) && d > 0 ? `⏱ Replacement window set to <b>${d} day(s)</b>.` : "⏱ Warranty has <b>no time limit</b> now.", { parse_mode: "HTML" });
    await productView(ctx, pid);
    return true;
  }
  if (awaiting === "admin_totp_confirm") {
    await ctx.deleteMessage().catch(() => undefined);
    if (!(await confirmAdminTotp(text))) {
      ctx.session.awaiting = "admin_totp_confirm";
      await ctx.reply("❌ That code didn't match — 2FA is still OFF. Send the current code from the app, or tap 🔄 Start again.");
      return true;
    }
    await ctx.reply("🔒 <b>Two-factor login is ON.</b>\n\nFrom now on, signing in needs your passcode and a code from your app. Keep that setup key somewhere safe.", { parse_mode: "HTML" });
    await twoFaView(ctx);
    return true;
  }
  if (awaiting === "admin_totp_disable") {
    await ctx.deleteMessage().catch(() => undefined);
    if (!(await disableAdminTotp(text))) {
      await ctx.reply("❌ Wrong code — 2FA is still ON.");
      return true;
    }
    await ctx.reply("🔓 Two-factor login is OFF. Your passcode is now the only protection on the panel.");
    await twoFaView(ctx);
    return true;
  }
  if (awaiting === "admin_cat_new") {
    const c = await createCategoryQuick(text.slice(0, 120));
    await ctx.reply(`✅ Category “${escapeHtml(c.name)}” created. Now pick the products that belong in it.`, { parse_mode: "HTML" });
    ctx.session.catTarget = c.id;
    ctx.session.catSelected = [];
    ctx.session.catPage = 1;
    ctx.session.catFilter = "none";
    await categoriseView(ctx);
    return true;
  }
  if (awaiting === "admin_cat_emoji") {
    const id = ctx.session.catTarget ?? "";
    await setCategoryEmoji(id, text.trim() === "-" ? null : text.trim());
    await ctx.reply(text.trim() === "-" ? "😀 Emoji removed." : `😀 Tile emoji set to ${escapeHtml(text.trim().slice(0, 8))}`, { parse_mode: "HTML" });
    await categoriesAdminView(ctx);
    return true;
  }
  if (awaiting === "admin_cat_rename") {
    await renameCategory(ctx.session.catTarget ?? "", text);
    await ctx.reply("✏️ Renamed.");
    await categoriesAdminView(ctx);
    return true;
  }
  if (awaiting === "admin_cat_search") {
    ctx.session.catSearch = text.trim() === "-" ? undefined : text.trim().slice(0, 40);
    ctx.session.catPage = 1;
    await categoriseView(ctx);
    return true;
  }
  if (awaiting === "admin_margin_floor") {
    const v = Number.parseFloat(text.replace(/[^0-9.]/g, ""));
    const bp = await setMarginFloorBp(Number.isFinite(v) ? v * 100 : 1_000);
    await ctx.reply(`🎯 Margin floor set to <b>${(bp / 100).toFixed(1)}%</b>.`, { parse_mode: "HTML" });
    await thinMarginView(ctx);
    return true;
  }
  if (awaiting === "admin_qual_threshold") {
    const v = Number.parseFloat(text.replace(/[^0-9.]/g, ""));
    const cfg = await saveQualityConfig({ thresholdBp: Number.isFinite(v) ? Math.round(v * 100) : 2_500 });
    await ctx.reply(`📉 Threshold set to <b>${(cfg.thresholdBp / 100).toFixed(1)}%</b>.`, { parse_mode: "HTML" });
    await qualityView(ctx);
    return true;
  }
  if (awaiting === "admin_recov_minutes") {
    const v = Number.parseInt(text.replace(/[^0-9]/g, ""), 10);
    const cfg = await saveRecoveryConfig({ afterMinutes: Number.isFinite(v) && v > 0 ? v : 20 });
    await ctx.reply(`⏱ Reminders will be sent <b>${cfg.afterMinutes} minutes</b> after checkout starts.`, { parse_mode: "HTML" });
    await recoveryView(ctx);
    return true;
  }
  if (awaiting === "admin_variant_cost") {
    const vid = ctx.session.admVariantId ?? "";
    ctx.session.admVariantId = undefined;
    if (text.trim() === "-") {
      await setVariantCost(vid, null);
      await ctx.reply("💰 Cost cleared.");
    } else {
      const v = Number.parseFloat(text.replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(v) || v < 0) { await ctx.reply("Send a number like 1.80, or - to clear."); return true; }
      await setVariantCost(vid, Math.round(v * 100));
      await ctx.reply(`💰 Cost set to <b>$${v.toFixed(2)}</b> per unit. Margin is now tracked for this product.`, { parse_mode: "HTML" });
    }
    await thinMarginView(ctx);
    return true;
  }
  if (awaiting === "admin_ticket_reply") {
    const tid = ctx.session.ticketId ?? "";
    ctx.session.ticketId = undefined;
    const r = await adminReplyTicket(tid, text);
    await ctx.reply(r.ok ? `📨 Sent to the customer on ticket <b>${r.ticketNumber}</b>.` : "Could not find that ticket.", { parse_mode: "HTML" });
    if (r.ok) await ticketDetailView(ctx, tid);
    return true;
  }
  if (awaiting === "admin_reject_note") {
    const rid = ctx.session.admReplaceId ?? "";
    ctx.session.admReplaceId = undefined;
    const note = text.trim() === "-" ? undefined : text.trim().slice(0, 400);
    const res = await rejectReplacement(rid, note);
    await ctx.reply(res.ok ? "❌ Request declined — the customer has been told." : "Could not update that request.");
    await replacementsListView(ctx);
    return true;
  }
  if (awaiting === "maint_msg") {
    ctx.session.awaiting = undefined;
    await setMaintenance((await getMaintenance()).enabled, text);
    await ctx.reply("✅ Maintenance message updated.");
    await maintenanceView(ctx);
    return true;
  }

  if (awaiting === "sale_title") {
    ctx.session.saleDraft = { ...(ctx.session.saleDraft ?? {}), title: composeBroadcastHtml(ctx) };
    ctx.session.awaiting = "sale_body";
    await askStep(ctx, "Step 2 — send the <b>message</b> (premium emoji OK), or <code>-</code> to skip:");
    return true;
  }
  if (awaiting === "sale_body") {
    ctx.session.saleDraft = { ...(ctx.session.saleDraft ?? {}), body: text.trim() === "-" ? undefined : composeBroadcastHtml(ctx) };
    ctx.session.awaiting = null;
    await show(ctx, "Step 3 — add a button? Choose where it links:", saleTargetKb(), false);
    return true;
  }
  if (awaiting === "sale_url") {
    ctx.session.saleDraft = { ...(ctx.session.saleDraft ?? {}), btnUrl: text.trim() };
    ctx.session.awaiting = "sale_btntext";
    await askStep(ctx, "Send the <b>button label</b>:");
    return true;
  }
  if (awaiting === "sale_btntext") {
    ctx.session.saleDraft = { ...(ctx.session.saleDraft ?? {}), btnText: text.trim().slice(0, 40) };
    ctx.session.awaiting = null;
    await show(ctx, "Pick the <b>button colour</b>:", saleColourKb(), false);
    return true;
  }
  if (awaiting === "sale_timer") {
    const h = Number.parseInt(text.trim().replace(/[^0-9]/g, ""), 10);
    ctx.session.saleDraft = { ...(ctx.session.saleDraft ?? {}), endsHours: text.trim() === "-" || !Number.isFinite(h) ? undefined : h };
    ctx.session.awaiting = null;
    await show(ctx, "✅ Ready! Announce now, or set it to auto-announce:", saleFinalKb(), false);
    return true;
  }
  if (awaiting === "admin_flash_headline") {
    if (text.trim() === "-") { await setFlashHeadline(""); await ctx.reply("🔥 Flash headline reset to default."); await sendPanel(ctx, false); return true; }
    await setFlashHeadline(composeBroadcastHtml(ctx));
    await ctx.reply("✅ Flash sale headline saved — it'll lead every flash-sale announcement.");
    await sendPanel(ctx, false);
    return true;
  }
  if (awaiting === "admin_prod_search") {
    ctx.session.prodSearch = text.trim().slice(0, 60) || undefined;
    await productsView(ctx, 1);
    return true;
  }
  if (awaiting === "admin_user_lookup") {
    const u = await getUserSummary(text.trim());
    if (!u) { await ctx.reply("❌ No customer found. Send their @username or Telegram numeric ID."); return true; }
    await userDetailView(ctx, u.id);
    return true;
  }
  if (awaiting === "admin_user_addbal" || awaiting === "admin_user_deductbal") {
    const target = ctx.session.userTarget ?? ""; ctx.session.userTarget = undefined;
    const sign = awaiting === "admin_user_deductbal" ? -1 : 1;
    const val = Number.parseFloat(text.trim().replace(/[^0-9.]/g, ""));
    if (!target || !Number.isFinite(val) || val <= 0) { await ctx.reply("Please send a valid amount, e.g. 10."); return true; }
    const r = await adjustUserWalletById(target, sign * Math.round(val * 100), String(ctx.from?.id ?? ""));
    await ctx.reply(r.ok ? `✅ ${sign > 0 ? "Added" : "Deducted"} ${val.toFixed(2)}. New balance: <b>${(Number(r.newBalanceMinor) / 100).toFixed(2)} ${r.currency}</b>.` : "❌ Could not adjust.", { parse_mode: "HTML" });
    await userDetailView(ctx, target);
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
