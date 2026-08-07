import { isDev, loadConfig } from "@gis/config";
import {
  addToCart,
  adjustWallet,
  changeQty,
  checkoutWithWallet,
  checkoutWithBnpl,
  repayBnpl,
  greetName,
  applyCouponToCart,
  removeCouponFromCart,
  couponReason,
  referralNudgeMessage,
  shouldSendReferralNudge,
  deliveryInstructionsMessage,
  clearCart,
  createGatewayCheckout,
  createBinanceManualCheckout,
  verifyBinanceByTxnId,
  createWalletTopup,
  verifyTopupByTxn,
  creditFreeTopup,
  buildCombinedDeliveryText,
  buildDeliveryTxt,
  DELIVERY_FILE_THRESHOLD,
  createApiKey,
  revokeApiKeyOwned,
  createTicket,
  getWallet,
  convertMinor,
  getCartView,
  tierOf,
  getSpinConfig,
  watchProduct,
  listWatches,
  reorderLines,
  searchMyKeys,
  unwatchProduct,
  getProductView,
  spin,
  spinForOrder,
  claimChallenge,
  getBnplStatus,
  addStock,
  saveReview,
  generateTotp,
  looksLikeTotpSecret,
  orderAlreadyRated,
  addReviewComment,
  logError,
  grantAllScopesToOwner,
  getInrPerUsdt,
  createReplacementBatch,
  createReplacementTicket,
  listUnitsForOrder,
  customerReplyTicket,
  getReplaceableItem,
  getProductIdBySlug,
  getRedis,
  hasUpiUtrBeenUsed,
  claimUpiUtrForOrder,
  markUpiUtrPending,
  enqueueAdminAlert,
  removeItem,
  resolveTelegramUser,
  revealDelivery,
  splitCredential,
  repairAccountPair,
  revealOrderDeliveries,
  setUserCurrency,
  setUserLocale,
  createUpiManualCheckout,
  createStarsCheckout,
  confirmStarsPayment,
  getVariantAvailable,
  registerPostTarget,
  removePostTargetByChat,
  resolveUserByTelegramId,
  setVip,
  setUserPrice,
  removeUserPrice,
  listUserPrices,
  setStoreDefaultPrice,
  type DeliveredSecret,
  getMaintenance,
} from "@gis/core";
import type { Currency } from "@gis/database";
import {
  PRODUCT_DEEPLINK_PREFIX,
  cb,
  decryptSecret,
  encryptSecret,
  intArg,
  isCoreError,
  parseCb,
} from "@gis/shared";
import { Bot, GrammyError, InlineKeyboard, InputFile, session } from "grammy";
import QRCode from "qrcode";
import type { Ctx } from "./ctx.js";
import { redisSessionStorage } from "./session.js";
import { adminCommand, handleAdminCallback, handleAdminText, isBotAdmin, notifyAdminsForApproval, setProductImageFromFileId } from "./admin.js";
import { ERROR_COPY, escapeHtml, fmt } from "./ui.js";
import { sbtn } from "./keyboard.js";
import { t } from "./i18n.js";
import { vipAnimation, successCard, num } from "./premium.js";
import * as views from "./views.js";
import type { View } from "./views.js";

/** Decrypt the session-held TOTP secret. Never stored or logged in the clear. */
function otpSecretOf(ctx: Ctx): string | null {
  const enc = ctx.session.otpSecret;
  if (!enc) return null;
  try {
    return decryptSecret(enc, loadConfig().ENCRYPTION_MASTER_KEY);
  } catch {
    return null;
  }
}

/** Per-user serialization chain — see the middleware in createBot. */
const userLocks = new Map<string, Promise<void>>();

const SPAM_WINDOW_SEC = 10;
const SPAM_MAX_ACTIONS = 20;

/**
 * Both endings of the 2-step claim form (photo sent, or "submit without one").
 * In warranty → a replacement claim. Out of warranty → a support ticket, where
 * a human decides; the bot never promises a replacement it cannot authorise.
 */
async function submitReplaceOrTicket(ctx: Ctx, proofFileId: string | undefined): Promise<void> {
  ctx.session.awaiting = null;
  const orderItemId = ctx.session.replaceItemId ?? "";
  const reason = ctx.session.replaceReason ?? "(no reason given)";
  const viaTicket = ctx.session.replaceViaTicket === true;
  const batch = ctx.session.replaceBatch ?? [];
  ctx.session.replaceItemId = undefined;
  ctx.session.replaceReason = undefined;
  ctx.session.replaceViaTicket = undefined;
  ctx.session.replaceBatch = undefined;
  ctx.session.replaceSelected = [];

  // Multi-unit selection: each id is re-validated server-side, and the customer is
  // told exactly which units were accepted and which were not.
  if (batch.length > 0) {
    const r = await createReplacementBatch({ userId: ctx.user.id, orderItemIds: batch, reason, proofFileId });
    if (!r.ok) {
      await ctx.reply(`⚠️ ${r.reason ?? "None of the selected items can be replaced."}`, {
        reply_markup: new InlineKeyboard().text("🔄 Try again", cb("rep", "home")).text("🏠 Menu", "mnu:home"),
      });
      return;
    }
    const lines = [
      "✅ <b>Request submitted</b>",
      "",
      `📦 <b>${r.accepted.length} item(s)</b> sent to our team:`,
      ...r.accepted.map((a) => `• ${escapeHtml(a.label)} — unit ${a.unitNumber}${a.tail ? ` (…${escapeHtml(a.tail)})` : ""}`),
    ];
    if (r.claimIds.length > 0) {
      lines.push("", `🛡 ${r.claimIds.length} covered by warranty — being reviewed now, your replacement arrives here once approved.`);
    }
    if (r.ticketNumber) {
      lines.push("", `🎫 Out-of-warranty items opened ticket <b>${escapeHtml(r.ticketNumber)}</b> — a person will reply right here.`);
    }
    if (r.rejected.length > 0) {
      lines.push("", "⚠️ <b>Not included:</b>", ...r.rejected.map((x) => `• ${escapeHtml(x.label)}${x.unitNumber ? ` unit ${x.unitNumber}` : ""} — ${escapeHtml(x.reason)}`));
    }
    lines.push("", "🙏 Thank you for your patience.");
    await ctx.reply(lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("📦 My orders", cb("ord", "list", 1)).text("🎫 My tickets", "sup:home"),
    });
    return;
  }

  if (viaTicket) {
    const r = await createReplacementTicket({ userId: ctx.user.id, orderItemId, reason, proofFileId });
    await ctx.reply(
      r.ok
        ? [
            `🎫 <b>Ticket ${r.ticketNumber} raised</b>`,
            "",
            "Our support team has your message and will reply right here.",
            "",
            "<i>This item is outside its warranty, so we can't promise a replacement — but a real person will look at it and do what they can. 🙏</i>",
          ].join("\n")
        : `⚠️ ${r.reason}`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🎫 My tickets", "sup:home").text("🏠 Menu", "mnu:home") },
    );
    return;
  }

  // A single unit is just a batch of one — same validation, same code path, so the
  // two can never drift apart.
  const r = await createReplacementBatch({ userId: ctx.user.id, orderItemIds: [orderItemId], reason, proofFileId });
  if (!r.ok) {
    await ctx.reply(`⚠️ ${r.reason ?? r.rejected[0]?.reason ?? "Not eligible for replacement."}`);
    return;
  }
  await ctx.reply(
    r.ticketNumber
      ? [
          `🎫 <b>Ticket ${escapeHtml(r.ticketNumber)} raised</b>`,
          "",
          "Our support team has your message and will reply right here.",
          "",
          "<i>This item is outside its warranty, so we can't promise a replacement — but a real person will look at it and do what they can. 🙏</i>",
        ].join("\n")
      : `✅ <b>Replacement request submitted!</b>\n\nOur team is reviewing it${proofFileId ? " and your screenshot" : ""} now — your replacement arrives here as soon as it is approved. Thank you for your patience. 🙏`,
    { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("📦 My orders", cb("ord", "list", 1)).text("🎫 My tickets", "sup:home") },
  );
}

export function createBot(): Bot<Ctx> {
  const config = loadConfig();
  const bot = new Bot<Ctx>(config.BOT_TOKEN);

  // Serialize updates per user. Webhook mode handles POSTs concurrently and
  // Telegram redelivers on timeout, so without this a double-tap ran the same
  // handler twice against the SAME session snapshot — producing duplicate
  // replacement requests that could never be approved. A per-user promise chain
  // is enough here and avoids pulling in @grammyjs/runner.
  // ── Drop redelivered updates ──
  // Telegram redelivers an update if the webhook does not answer in time. The
  // per-user serializer below made the retry WAIT rather than dropping it, and
  // the session was loaded before that wait — so the retry resumed from a stale
  // snapshot and re-ran the handler with state the first pass had consumed.
  // That is how one gift became a gift every minute: each retry still saw
  // giftUser/giftTitle set and created the record again.
  bot.use(async (ctx, next) => {
    const id = ctx.update?.update_id;
    if (typeof id !== "number") return next();
    try {
      // NX: the first caller wins, every redelivery is dropped. A whole hour is
      // far longer than Telegram's retry window.
      const first = await getRedis().set(`upd:${id}`, "1", "EX", 3600, "NX");
      if (first !== "OK") return;
    } catch {
      // Redis down: fall through and process. Losing dedupe is better than
      // losing the bot.
    }
    return next();
  });

  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (uid === undefined) return next();
    const key = String(uid);
    const prev = userLocks.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const mine = new Promise<void>((res) => { release = res; });
    // Keep a reference to the exact chained promise we stored, so the cleanup
    // below can tell whether anyone queued behind us.
    const chained = prev.then(() => mine);
    userLocks.set(key, chained);
    await prev.catch(() => undefined);
    try {
      await next();
    } finally {
      release();
      // Only the last waiter clears the entry, so the map cannot grow unbounded.
      if (userLocks.get(key) === chained) userLocks.delete(key);
    }
  });

  // Session is loaded AFTER the serializer on purpose. Loading it before meant
  // every update queued behind another had already taken its snapshot, so it
  // resumed with state the earlier update had since consumed and saved.
  bot.use(session({ initial: (): Ctx["session"] => ({}), storage: redisSessionStorage() }));

  // ── Anti-spam: per-user token bucket (Bot UX doc §14) ──
  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    const redis = getRedis();
    const key = `bot:flood:${uid}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, SPAM_WINDOW_SEC);
    if (count > SPAM_MAX_ACTIONS) {
      if (count === SPAM_MAX_ACTIONS + 1 && ctx.chat) {
        await ctx.reply("🐢 Slow down a little — try again in a few seconds.");
      }
      return;
    }
    await next();
  });

  // ── Telegram Stars: pre-checkout must be answered within 10s (no chat on this update) ──
  bot.on("pre_checkout_query", (ctx) => ctx.answerPreCheckoutQuery(true).catch(() => undefined));

  // ── Group registration commands (work in groups/channels; admin-gated) ──
  bot.command("registergroup", async (ctx) => {
    if (!(await isBotAdmin(ctx.from?.id))) {
      await ctx.reply("Only a logged-in admin can register a group. DM me and use /admin first.").catch(() => undefined);
      return;
    }
    if (!ctx.chat || ctx.chat.type === "private") {
      await ctx.reply("Run this inside the group or channel you want to post products to (add me there as admin first).").catch(() => undefined);
      return;
    }
    const title = "title" in ctx.chat ? (ctx.chat.title ?? null) : null;
    await registerPostTarget(String(ctx.chat.id), title, ctx.from ? String(ctx.from.id) : undefined);
    await ctx.reply("✅ Registered! Product posts from the admin panel will appear here.").catch(() => undefined);
  });
  bot.command("unregistergroup", async (ctx) => {
    if (!(await isBotAdmin(ctx.from?.id))) return;
    if (!ctx.chat || ctx.chat.type === "private") return;
    await removePostTargetByChat(String(ctx.chat.id));
    await ctx.reply("✅ Unregistered — no more product posts here.").catch(() => undefined);
  });

  // ── Resolve DB user for private chats ──
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== "private" || !ctx.from) return;
    const payload = ctx.message?.text?.startsWith("/start") ? ctx.message.text.split(" ")[1] : undefined;
    const { user, isNew } = await resolveTelegramUser({
      telegramId: BigInt(ctx.from.id),
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name,
      username: ctx.from.username,
      locale: ctx.from.language_code,
      startPayload: payload,
    });
    ctx.user = user;
    ctx.session.isNewUser = isNew;
    // Banned users can't use the bot.
    if ((user as { status?: string }).status === "BANNED") {
      await ctx.reply("🚫 Your access has been suspended. Contact support if you think this is a mistake.").catch(() => undefined);
      return;
    }

    // ── Maintenance mode ──
    // Admins always get through, otherwise enabling it would lock the operator
    // out of the very panel that turns it back off. /admin stays reachable for
    // the same reason, before the passcode session exists.
    const isAdminHere = await isBotAdmin(ctx.from.id);
    const cmd = ctx.message?.text ?? "";
    if (!isAdminHere && !cmd.startsWith("/admin")) {
      const maint = await getMaintenance();
      if (maint.enabled) {
        await ctx.reply(maint.message, { parse_mode: "HTML" }).catch(() => undefined);
        return;
      }
    }
    await next();
  });

  // Telegram rejects messages with custom emoji the bot doesn't own. Strip
  // <tg-emoji> tags back to their fallback glyph so the message still sends.
  const stripEmoji = (html: string): string => html.replace(/<tg-emoji[^>]*>(.*?)<\/tg-emoji>/g, "$1");

  const render = async (ctx: Ctx, view: View, edit: boolean): Promise<void> => {
    const opts = { parse_mode: "HTML" as const, reply_markup: view.kb };
    const cap = (t: string) => (t.length > 1024 ? `${t.slice(0, 1021)}…` : t);
    if (view.photo) {
      try {
        await ctx.replyWithPhoto(view.photo, { caption: cap(view.text), parse_mode: "HTML", reply_markup: view.kb });
        return;
      } catch (e) {
        // Retry without custom emoji first (bot may not own them), then plain.
        if (e instanceof GrammyError && e.description.includes("CUSTOM_EMOJI")) {
          try { await ctx.replyWithPhoto(view.photo, { caption: cap(stripEmoji(view.text)), parse_mode: "HTML", reply_markup: view.kb }); return; } catch { /* fall through */ }
        }
        await ctx.reply(cap(stripEmoji(view.text)), opts).catch(() => ctx.reply(cap(view.text.replace(/<[^>]+>/g, ""))).catch(() => undefined));
        return;
      }
    }
    // Telegram hard-caps a text message at 4096 chars. Views that list one row per
    // delivered unit could exceed it, and the failure mode was the user getting
    // NOTHING at all — the last fallback below had no catch either.
    const TG_MAX = 4096;
    const fit = (t: string) => (t.length > TG_MAX ? `${t.slice(0, TG_MAX - 40)}\n\n<i>…truncated</i>` : t);
    const send = async (text: string): Promise<void> => {
      if (edit && ctx.callbackQuery?.message) {
        await ctx.editMessageText(fit(text), opts);
      } else {
        await ctx.reply(fit(text), opts);
      }
    };
    try {
      await send(view.text);
    } catch (e) {
      if (e instanceof GrammyError && e.description.includes("message is not modified")) return;
      // Most likely an unowned custom emoji — retry with tg-emoji stripped.
      try { await send(stripEmoji(view.text)); }
      catch { await ctx.reply(stripEmoji(view.text), opts).catch(() => ctx.reply(view.text.replace(/<[^>]+>/g, ""))); }
    }
  };

  // ── Commands ──
  bot.command("start", async (ctx) => {
    const payload = ctx.match.trim();
    if (payload.startsWith(PRODUCT_DEEPLINK_PREFIX)) {
      const productId = await getProductIdBySlug(payload.slice(PRODUCT_DEEPLINK_PREFIX.length));
      if (productId) { ctx.session.buyProductId = productId; return render(ctx, await views.productView(ctx.user, productId), false); }
    }
    // Deep links so an announcement button can open ANY section of the bot.
    switch (payload) {
      case "shop": return render(ctx, await views.shopHomeView(ctx.user, 1), false);
      case "categories": return render(ctx, await views.categoryGridView(ctx.user), false);
      case "deals": return render(ctx, await views.dealsView(ctx.user), false);
      case "refer": return render(ctx, await views.referralView(ctx.user, ctx.me.username), false);
      case "spin": return render(ctx, await views.spinView(ctx.user), false);
      case "mission": return render(ctx, await views.missionView(ctx.user), false);
      case "tier": return render(ctx, await views.tierView(ctx.user), false);
      case "account": return render(ctx, await views.profileView(ctx.user), false);
      case "topup": return render(ctx, await views.walletView(ctx.user), false);
      case "orders": return render(ctx, await views.ordersView(ctx.user, 1), false);
      default: break;
    }
    // Standalone single emoji → Telegram plays a fullscreen animation for the user.
    if (config.CELEBRATION_EMOJI) await ctx.reply(config.CELEBRATION_EMOJI).catch(() => undefined);
    const who = greetName(ctx.user);
    const welcomeLines = [
      `👋 <b>Welcome, ${who}!</b> 🙏`,
      `It's a real pleasure to have you at <b>${escapeHtml(config.STORE_NAME)}</b>. We're honoured to serve you.`,
      `<i>Digital products · instant delivery · best prices.</i>`,
    ];
    if (ctx.session.isNewUser) {
      welcomeLines.push("", "💱 Your currency is set to <b>USD</b> — you can switch anytime from ⚙️ the menu.");
    }
    const welcomeText = welcomeLines.join("\n");
    const emojiPrefix = config.CUSTOM_EMOJI_ID ? `<tg-emoji emoji-id="${config.CUSTOM_EMOJI_ID}">✨</tg-emoji> ` : "";
    try {
      await ctx.reply(`${emojiPrefix}${welcomeText}`, { parse_mode: "HTML" });
    } catch {
      // Telegram rejects custom emoji the bot doesn't own — fall back to plain text.
      await ctx.reply(welcomeText, { parse_mode: "HTML" });
    }
    ctx.session.isNewUser = false;
    return render(ctx, await views.menuView(ctx.user), false);
  });
  bot.command("menu", async (ctx) => render(ctx, await views.menuView(ctx.user), false));
  bot.command("shop", async (ctx) => render(ctx, await views.shopHomeView(ctx.user, 1), false));
  bot.command("cart", async (ctx) => render(ctx, await views.cartViewKb(ctx.user), false));
  bot.command("orders", async (ctx) => render(ctx, await views.ordersView(ctx.user, 1), false));
  bot.command("wallet", async (ctx) => render(ctx, await views.walletView(ctx.user), false));
  bot.command("support", async (ctx) => render(ctx, await views.supportHomeView(ctx.user), false));
  bot.command("help", async (ctx) => render(ctx, views.helpView(), false));
  bot.command("api", async (ctx) => render(ctx, await views.apiKeysView(ctx.user), false));
  bot.command("replace", async (ctx) => render(ctx, await views.replaceListView(ctx.user), false));
  bot.command(["language", "lang"], async (ctx) => render(ctx, views.languageView(ctx.user), false));
  bot.command("referral", async (ctx) => render(ctx, await views.referralView(ctx.user, ctx.me.username), false));
  // Secret admin trigger — /Shriji (case-insensitive). /admin no longer opens the panel.
  bot.hears(/^\/shriji(?:@\S+)?(?:\s|$)/i, async (ctx) => adminCommand(ctx));

  // ── VIP pricing admin commands (bot-admin only) ──
  const adminOnly = async (ctx: Ctx): Promise<boolean> => {
    if (await isBotAdmin(ctx.from?.id)) return true;
    await ctx.reply("⛔ Admins only. Use /admin first.").catch(() => undefined);
    return false;
  };
  bot.command("setprice", async (ctx) => {
    if (!(await adminOnly(ctx))) return;
    const [uid, pid, price] = ctx.match.trim().split(/\s+/);
    const amt = Math.round(Number.parseFloat(price ?? "") * 100);
    if (!uid || !pid || !Number.isFinite(amt) || amt <= 0) return ctx.reply("Usage: /setprice &lt;user_id&gt; &lt;product_id&gt; &lt;price&gt;", { parse_mode: "HTML" });
    const u = await resolveUserByTelegramId(uid);
    if (!u) return ctx.reply("User not found (they must have used the bot).");
    await setUserPrice(u.id, pid, amt);
    return ctx.reply(`✅ VIP price set for ${u.label} on product ${pid}: ${price}`);
  });
  bot.command("removeprice", async (ctx) => {
    if (!(await adminOnly(ctx))) return;
    const [uid, pid] = ctx.match.trim().split(/\s+/);
    if (!uid || !pid) return ctx.reply("Usage: /removeprice <user_id> <product_id>");
    const u = await resolveUserByTelegramId(uid);
    if (!u) return ctx.reply("User not found.");
    await removeUserPrice(u.id, pid);
    return ctx.reply(`✅ VIP price removed for ${u.label} on ${pid}.`);
  });
  bot.command("prices", async (ctx) => {
    if (!(await adminOnly(ctx))) return;
    const uid = ctx.match.trim();
    if (!uid) return ctx.reply("Usage: /prices <user_id>");
    const u = await resolveUserByTelegramId(uid);
    if (!u) return ctx.reply("User not found.");
    const rows = await listUserPrices(u.id);
    if (rows.length === 0) return ctx.reply(`${u.label} has no VIP prices.`);
    const lines = rows.map((r) => `• ${escapeHtml(r.productName)} — ${(r.amountMinor / 100).toFixed(2)}`);
    return ctx.reply(`💰 <b>VIP prices for ${escapeHtml(u.label)}</b>\n${lines.join("\n")}`, { parse_mode: "HTML" });
  });
  bot.command("storeprice", async (ctx) => {
    if (!(await adminOnly(ctx))) return;
    const [pid, price] = ctx.match.trim().split(/\s+/);
    const amt = Math.round(Number.parseFloat(price ?? "") * 100);
    if (!pid || !Number.isFinite(amt) || amt <= 0) return ctx.reply("Usage: /storeprice <product_id> <default_price>");
    await setStoreDefaultPrice(pid, amt);
    return ctx.reply(`✅ Default price for product ${pid} set to ${price} (INR, USD auto-derived).`);
  });
  bot.command("setvip", async (ctx) => {
    if (!(await adminOnly(ctx))) return;
    const u = await resolveUserByTelegramId(ctx.match.trim());
    if (!u) return ctx.reply("Usage: /setvip <user_id> (user must have used the bot)");
    await setVip(u.id, true);
    return ctx.reply(`👑 ${u.label} is now a VIP member.`);
  });
  bot.command("removevip", async (ctx) => {
    if (!(await adminOnly(ctx))) return;
    const u = await resolveUserByTelegramId(ctx.match.trim());
    if (!u) return ctx.reply("Usage: /removevip <user_id>");
    await setVip(u.id, false);
    return ctx.reply(`✅ ${u.label} is no longer a VIP.`);
  });

  if (isDev()) {
    // Dev-only wallet top-up so checkout is testable end-to-end.
    bot.command("devtopup", async (ctx) => {
      const amount = Number.parseInt(ctx.match.trim(), 10);
      if (!Number.isFinite(amount) || amount <= 0) return ctx.reply("Usage: /devtopup <amount-minor-units>");
      const balance = await adjustWallet({
        userId: ctx.user.id,
        amountMinor: BigInt(amount),
        type: "ADJUSTMENT",
        note: "dev top-up",
      });
      return ctx.reply(`✅ Balance: ${fmt(balance, ctx.user.currency)}`);
    });
  }

  // ── Admin sends a photo to set a product image ──
  // ── Admin uploads stock as a .txt file (bulk keys / accounts) ──
  bot.on("message:document", async (ctx) => {
    if (ctx.session.awaiting !== "admin_addkeys") return;
    if (!(await isBotAdmin(ctx.from?.id))) return;
    const doc = ctx.message.document;
    const variantId = ctx.session.admVariantId ?? "";
    ctx.session.awaiting = null;
    ctx.session.admVariantId = undefined;
    if (!variantId) { await ctx.reply("That product expired — open it again and tap 🔑 Add stock keys."); return; }
    if ((doc.file_size ?? 0) > 2_000_000) { await ctx.reply("⚠️ That file is too large (max 2 MB). Split it and upload again."); return; }
    try {
      await ctx.reply("📄 Reading your file…");
      const file = await ctx.api.getFile(doc.file_id);
      const url = `https://api.telegram.org/file/bot${loadConfig().BOT_TOKEN}/${file.file_path}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) { await ctx.reply("❌ Couldn't download that file from Telegram. Try again."); return; }
      const body = await res.text();
      const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) { await ctx.reply("❌ That file is empty."); return; }
      if (lines.length > 5000) { await ctx.reply(`⚠️ ${lines.length} lines is too many at once — split into files of 5000 or fewer.`); return; }
      const r = await addStock(variantId, lines);
      const unit = r.type === "DIGITAL_ACCOUNT" ? "account" : "key";
      const bits = [`✅ Imported from <b>${escapeHtml(doc.file_name ?? "file")}</b>`, "", `📥 Read <b>${lines.length}</b> line(s)`, `➕ Added <b>${r.added}</b> ${unit}(s)`];
      if (r.relisted > 0) bits.push(`♻️ Re-listed <b>${r.relisted}</b> previously delivered`);
      if (r.skipped > 0) bits.push(`⏭ Skipped <b>${r.skipped}</b> (duplicate or unreadable)`);
      await ctx.reply(bits.join("\n"), { parse_mode: "HTML" });
    } catch (e) {
      void logError("stockUpload", e, { variantId });
      await ctx.reply("❌ Couldn't read that file. Send a plain <b>.txt</b> with one item per line.", { parse_mode: "HTML" });
    }
  });

  bot.on("message:photo", async (ctx) => {
    // Customer submitting a replacement / support screenshot.
    if (ctx.session.awaiting === "replace_proof") {
      const photos = ctx.message.photo;
      await submitReplaceOrTicket(ctx, photos[photos.length - 1]?.file_id);
      return;
    }
    // Customer attaching a screenshot to an open ticket reply.
    if (ctx.session.awaiting === "ticket_reply" && ctx.session.ticketId) {
      ctx.session.awaiting = null;
      const photos = ctx.message.photo;
      const r = await customerReplyTicket(ctx.user.id, ctx.session.ticketId, ctx.message.caption?.slice(0, 1000) || "(screenshot)", photos[photos.length - 1]?.file_id);
      ctx.session.ticketId = undefined;
      await ctx.reply(r.ok ? `📨 Sent to support on ticket <b>${r.ticketNumber}</b>. We'll reply here.` : "⚠️ That ticket is no longer open.", { parse_mode: "HTML" });
      return;
    }
    if (ctx.session.awaiting !== "admin_p_image") return;
    if (!(await isBotAdmin(ctx.from?.id))) return;
    const photos = ctx.message.photo;
    const fileId = photos[photos.length - 1]?.file_id;
    if (fileId) await setProductImageFromFileId(ctx, fileId);
  });

  // ── Telegram Stars: payment succeeded → fulfil the order ──
  bot.on("message:successful_payment", async (ctx) => {
    const orderId = ctx.message.successful_payment.invoice_payload;
    try {
      const r = await confirmStarsPayment(orderId);
      await ctx.reply(
        successCard("Payment Received", [`✅ Paid with ⭐ Telegram Stars`, `📦 Delivered ${num(r.delivered)} item(s)`, `🙏 Thank you so much, ${greetName(ctx.user)} — it is an honour to serve you!`]),
        { parse_mode: "HTML" },
      );
    } catch {
      await ctx.reply("⭐ Payment received — our team will deliver your order shortly.");
    }
  });

  // ── Free-text conversations (search / ticket) ──
  bot.on("message:text", async (ctx) => {
    const awaiting = ctx.session.awaiting;
    ctx.session.awaiting = null;
    if (awaiting && (awaiting.startsWith("admin_") || awaiting.startsWith("sale_"))) {
      const handled = await handleAdminText(ctx, awaiting);
      if (handled) return;
    }
    if (awaiting === "review_comment") {
      const rid = ctx.session.reviewId ?? "";
      const body = ctx.message.text.trim().slice(0, 1000);
      if (!rid) return; // no pending review — fall through to normal handling
      ctx.session.reviewId = undefined;
      await addReviewComment(rid, body);
      await enqueueAdminAlert(`💬 <b>Review comment</b> — ${escapeHtml(greetName(ctx.user))}\n\n${escapeHtml(body).slice(0, 600)}`).catch(() => undefined);
      return ctx.reply(
        `💖 <b>Thank you, ${escapeHtml(greetName(ctx.user))}!</b>\n\nYour words have been sent straight to our team. We truly appreciate you taking the time. 🙏✨`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🛍 Shop again", cb("shp", "home", 1)).text("🏠 Menu", "mnu:home") },
      );
    }
    if (awaiting === "keys_search") {
      const q = ctx.message.text.trim().slice(0, 40);
      return render(ctx, await views.myKeysSearchView(ctx.user, q), false);
    }
    if (awaiting === "replace_proof") {
      // They typed instead of sending a photo — keep the claim alive.
      ctx.session.awaiting = "replace_proof";
      return ctx.reply(
        "📷 Please send the screenshot as a <b>photo</b> (attach an image), or tap Submit without one.",
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("📨 Submit without screenshot", "rep:nopic").text("✖️ Cancel", "rep:home") },
      );
    }
    if (awaiting === "replace_reason") {
      ctx.session.replaceReason = ctx.message.text.trim().slice(0, 1000);
      ctx.session.awaiting = "replace_proof";
      const viaTicket = ctx.session.replaceViaTicket === true;
      return ctx.reply(
        viaTicket
          ? "📷 <b>Step 2 of 2 — send a screenshot</b>\n\nPlease send a photo showing the problem. It helps our support team understand it quickly and decide what they can do for you.\n\n<i>No screenshot? Tap Send without one.</i>"
          : "📷 <b>Step 2 of 2 — send a screenshot</b>\n\nPlease send a photo showing the problem (error message, login screen, etc.). This helps our team approve your replacement fast.\n\n<i>No screenshot? Tap Submit without one.</i>",
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text(viaTicket ? "📨 Send without screenshot" : "📨 Submit without screenshot", "rep:nopic").text("✖️ Cancel", "rep:home") },
      );
    }
    if (awaiting === "otp_secret") {
      // Delete the message holding the secret immediately — chat history is the
      // one place we genuinely cannot control, so don't leave it sitting there.
      const raw = ctx.message.text;
      await ctx.deleteMessage().catch(() => undefined);
      const clean = raw.replace(/[\s-]/g, "").toUpperCase();
      if (!clean) {
        ctx.session.awaiting = "otp_secret";
        return ctx.reply("That looked empty — paste the Base32 secret key.", {
          reply_markup: new InlineKeyboard().text("✖️ Cancel", cb("otp", "tool")),
        });
      }
      if (!looksLikeTotpSecret(clean) || generateTotp(clean) === null) {
        ctx.session.awaiting = "otp_secret";
        return ctx.reply(
          [
            "⚠️ <b>That isn't a valid 2FA secret.</b>",
            "",
            "It should be Base32 — letters A–Z and digits 2–7 only, usually 16 or 32 characters.",
            "If you copied a whole URL by mistake, send just the <code>secret=</code> part.",
          ].join("\n"),
          { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("✖️ Cancel", cb("otp", "tool")) },
        );
      }
      // Encrypted before it touches the session store. The session is persisted in
      // Redis as JSON, so "never saved" was not true of a plaintext field — and
      // Redis is the same instance BullMQ uses, i.e. likely persisted to disk.
      ctx.session.otpSecret = encryptSecret(clean, loadConfig().ENCRYPTION_MASTER_KEY);
      ctx.session.otpReveal = false;
      return render(ctx, views.otpToolView(clean, false), false);
    }
    if (awaiting === "ticket_reply") {
      const id = ctx.session.ticketId ?? "";
      ctx.session.ticketId = undefined;
      if (!id) return;
      const r = await customerReplyTicket(ctx.user.id, id, ctx.message.text.trim().slice(0, 2000));
      return ctx.reply(
        r.ok ? `📨 Sent to support on ticket <b>${r.ticketNumber}</b>. We'll reply right here. 🙏` : "⚠️ That ticket is no longer open. Tap 🎫 Support to open a new one.",
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("📂 View ticket", `tkt:open:${id}`).text("🏠 Menu", "mnu:home") },
      );
    }
    if (awaiting === "wallet_inr_amount") {
      const val = Number.parseFloat(ctx.message.text.replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(val) || val <= 0) {
        ctx.session.awaiting = "wallet_inr_amount";
        return ctx.reply("Please send a valid amount in ₹, e.g. <code>500</code>", { parse_mode: "HTML" });
      }
      const minor = Math.round(val * 100);
      ctx.session.inrTopupMinor = minor;
      const fxRate = await getInrPerUsdt();
      ctx.session.awaiting = "wallet_inr_utr";
      const upiId = config.UPI_ID ?? "";
      const payee = config.UPI_PAYEE_NAME || config.STORE_NAME;
      const rupees = (minor / 100).toFixed(2);
      const uri = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payee)}&am=${rupees}&cu=INR&tn=${encodeURIComponent(`WALLET-${ctx.user.id.slice(-6)}`)}`;
      const caption = [
        "🇮🇳 <b>Add ₹ to your wallet</b>",
        "",
        "┏━━━━━━━━━━━━━━━━━━",
        `┃ 💵 <b>Amount</b>`,
        `┃ <code>${rupees}</code>`,
        "┃",
        `┃ 🆔 <b>UPI ID</b>`,
        `┃ <code>${upiId}</code>`,
        `┃ <i>${escapeHtml(payee)}</i>`,
        "┗━━━━━━━━━━━━━━━━━━",
        "",
        "📷 <b>Scan the QR</b> in GPay / PhonePe / Paytm — the amount is pre-filled.",
        "📋 No QR? Use the copy buttons below.",
        "",
        `💰 Your wallet will be credited <b>$${(Math.round(minor / fxRate) / 100).toFixed(2)}</b>  <i>(${fxRate} INR = 1 USD)</i>`,
        "",
        "✅ After paying, paste your <b>UTR number</b> here.",
        "",
        "🕐 <b>Please note:</b> UPI is verified <b>manually by our team</b>, so crediting can be delayed.",
        "⚡ Need it instantly? Use <b>Binance (USDT)</b> — that is credited automatically.",
      ].join("\n");
      const kb = new InlineKeyboard()
        .copyText(`📋 Copy amount — ₹${rupees}`, rupees).row()
        .copyText(`📋 Copy UPI ID — ${upiId}`, upiId).row()
        .text("✖️ Cancel", "wal:view");
      try {
        const png = await QRCode.toBuffer(uri, { width: 512, margin: 2, color: { dark: "#000000", light: "#FFFFFF" } });
        return ctx.replyWithPhoto(new InputFile(png, "upi-topup.png"), { caption, parse_mode: "HTML", reply_markup: kb });
      } catch {
        return ctx.reply(caption, { parse_mode: "HTML", reply_markup: kb });
      }
    }
    if (awaiting === "wallet_inr_utr") {
      const utr = ctx.message.text.trim().slice(0, 64);
      const minor = ctx.session.inrTopupMinor ?? 0;
      const rate = await getInrPerUsdt();
      const usdMinor = Math.max(1, Math.round(minor / rate));
      // A UPI UTR/RRN is exactly 12 digits. The old check accepted any 6+
      // characters, so "abcdef" passed straight through to an admin alert.
      const digits = utr.replace(/\D/g, "");
      if (digits.length !== 12 || minor <= 0) {
        ctx.session.awaiting = "wallet_inr_utr";
        return ctx.reply(
          "Please paste the <b>12-digit UTR</b> from your UPI receipt.\n\nIt's the long reference number on the payment confirmation — digits only.",
          { parse_mode: "HTML" },
        );
      }
      // One UTR is one payment. Without this the same reference could be
      // submitted repeatedly, and each submission raised a fresh approval
      // request that would credit the wallet again.
      const already = await hasUpiUtrBeenUsed(digits);
      if (already) {
        ctx.session.awaiting = undefined;
        return ctx.reply(
          "⚠️ That UTR has already been submitted.\n\nEach UPI payment can only be credited once. If you've paid again, send the UTR from the <b>new</b> payment, or open 🎫 Support.",
          { parse_mode: "HTML" },
        );
      }
      await markUpiUtrPending(digits);
      ctx.session.inrTopupMinor = undefined;
      const who = ctx.user.telegramHandle ? `@${ctx.user.telegramHandle}` : (ctx.user.firstName ?? "customer");
      await enqueueAdminAlert(
        [
          "🇮🇳 <b>UPI wallet top-up to verify</b>",
          `👤 ${escapeHtml(who)}`,
          `🆔 <code>${ctx.user.telegramId ?? "—"}</code>`,
          `💵 Paid: <b>₹${(minor / 100).toFixed(2)}</b>`,
          `💰 Credit: <b>$${(usdMinor / 100).toFixed(2)}</b>  <i>(${rate} INR = 1 USD)</i>`,
          `🧾 UTR: <code>${escapeHtml(utr)}</code>`,
          "",
          "Check the UTR in your UPI app, then approve to credit their wallet in USD.",
        ].join("\n"),
        [
          { text: `✅ Approve — credit $${(usdMinor / 100).toFixed(2)}`, callbackData: `adm:wdok:${ctx.user.id}~${minor}~${usdMinor}`, style: "success" },
          { text: "❌ Reject", callbackData: `adm:wdno:${ctx.user.id}`, style: "danger" },
        ],
      ).catch(() => undefined);
      return ctx.reply(
        [
          "🧾 <b>Thanks — payment submitted!</b>",
          "",
          `💵 Paid: <b>₹${(minor / 100).toFixed(2)}</b>`,
          `💰 You'll receive: <b>$${(usdMinor / 100).toFixed(2)}</b> <i>(${rate} INR = 1 USD)</i>`,
          `🧾 UTR: <code>${escapeHtml(utr)}</code>`,
          "",
          "🧑‍💼 Our team is verifying it now — UPI is approved by hand, so please allow a little time. Your wallet is credited as soon as it clears and you'll get a message here. 🙏",
          "",
          "⚡ <i>Tip: Binance (USDT) deposits are credited automatically, with no waiting.</i>",
        ].join("\n"),
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("💳 Wallet", cb("wal", "view")).text("🏠 Menu", "mnu:home") },
      );
    }
    if (awaiting === "binance_txnid") {
      const orderId = ctx.session.binanceOrderId ?? "";
      const txn = ctx.message.text.trim().slice(0, 128);
      if (!orderId) {
        return ctx.reply("That checkout expired — please start again from your 🛒 Cart.");
      }
      // Obvious non-IDs (a stray word, a menu tap) shouldn't be sent to admins.
      if (txn.length < 6) {
        ctx.session.awaiting = "binance_txnid";
        return ctx.reply(
          "🔎 That doesn't look like a Binance <b>Order ID</b>. Open the payment in Binance, copy the Order ID from the receipt and paste it here.",
          { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("⚠️ I have paid — need help", `ord:binancehelp:${orderId}`) },
        );
      }
      await ctx.reply("🔎 Verifying your payment…");
      const r = await verifyBinanceByTxnId(orderId, txn, ctx.user.id);
      if (r.ok) {
        ctx.session.binanceOrderId = undefined;
        ctx.session.payRetries = undefined;
        return ctx.reply(
          [
            "✅ <b>Payment verified!</b>",
            "",
            "🚀 Your order has been <b>delivered</b> — check the message above.",
            "💾 It is also saved in 📦 My Orders.",
          ].join("\n"),
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
              .text("📦 View my orders", cb("ord", "list", 1))
              .text("🛍 Buy more", cb("shp", "home", 1)),
          },
        );
      }
      // Not auto-verified → send admins an instant approve/reject card (fallback: ticket).
      const notified = await notifyAdminsForApproval(ctx, orderId, "Binance", txn);
      if (notified === 0) {
        await createTicket(
          ctx.user.id,
          "PAYMENT_ISSUE",
          `Binance payment — order ${orderId}, Order ID: ${txn} (auto-verify: ${r.ok ? "ok" : r.reason}).`,
        ).catch(() => undefined);
      }
      const note =
        r.reason === "AMOUNT_MISMATCH"
          ? "⚠️ That transaction’s amount doesn’t match your order. "
          : r.reason === "ALREADY_USED"
            ? "⚠️ That transaction was already used. "
            : r.reason === "WRONG_USER"
              ? "⚠️ That order doesn’t belong to your account. "
              : "";
      // Re-arm only a couple of times. Leaving this state sticky turned every
      // later chat message into a fresh "approve & deliver" card for admins.
      const tries = (ctx.session.payRetries ?? 0) + 1;
      ctx.session.payRetries = tries;
      if (tries < 3) ctx.session.awaiting = "binance_txnid";
      else ctx.session.binanceOrderId = undefined;
      return ctx.reply(
        [
          note ? `${note}` : "⏳ <b>We couldn't auto-verify that yet.</b>",
          "",
          "🧑‍💼 Our team has been notified and will verify and deliver shortly — you'll get a message here the moment it's confirmed.",
          "",
          "💡 Double-checked your receipt? Paste the correct Order ID here and we'll try again instantly.",
        ].join("\n"),
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("📦 My orders", cb("ord", "list", 1)).text("🏠 Menu", "mnu:home") },
      );
    }
    if (awaiting === "buy_qty") {
      const variantId = ctx.session.buyVariantId ?? "";
      const maxQty = ctx.session.buyMaxQty ?? 99;
      ctx.session.buyVariantId = undefined;
      ctx.session.buyMaxQty = undefined;
      if (!variantId) return ctx.reply("That item expired — open the product again.");
      let qty = Number.parseInt(ctx.message.text.replace(/[^0-9]/g, ""), 10);
      if (!Number.isFinite(qty) || qty < 1) qty = 1;
      let note = "";
      if (maxQty < 1_000_000 && qty > maxQty) { qty = maxQty; note = `Only ${maxQty} available — setting quantity to ${maxQty}. `; }
      if (qty > 99) qty = 99;
      try {
        await clearCart(ctx.user.id);
        await addToCart(ctx.user.id, variantId, qty);
        if (note) await ctx.reply(note);
        return render(ctx, await views.checkoutSummaryView(ctx.user), false);
      } catch (e) {
        return ctx.reply(isCoreError(e) ? (ERROR_COPY[e.code] ?? "Could not start checkout.") : "Could not start checkout.");
      }
    }
    if (awaiting === "upi_ref") {
      const orderId = ctx.session.upiOrderId ?? "";
      const ref = ctx.message.text.trim().slice(0, 64);
      if (!orderId) return ctx.reply("That checkout expired — please start again from your 🛒 Cart.");
      // A UPI UTR/RRN is exactly 12 digits. The old check took any 6+ characters.
      const digits = ref.replace(/\D/g, "");
      if (digits.length !== 12) {
        ctx.session.awaiting = "upi_ref"; // keep waiting instead of dropping the order
        return ctx.reply(
          "🔎 That doesn't look like a <b>UTR</b>. Open your UPI app → the payment → copy the <b>12-digit</b> UTR / RRN / Transaction ID and paste it here.",
          { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("⚠️ I have paid — need help", "ord:upipaid") },
        );
      }

      // Visible progress while the checks run, like a card terminal.
      const progress = await ctx.reply("🔄 <b>Verifying your payment…</b>\n<code>▰▱▱▱▱</code>", { parse_mode: "HTML" });
      const step = async (bar: string, text: string): Promise<void> => {
        await ctx.api.editMessageText(progress.chat.id, progress.message_id, `${text}\n<code>${bar}</code>`, { parse_mode: "HTML" })
          .catch(() => undefined);
      };
      await step("▰▰▱▱▱", "🔄 <b>Checking the reference…</b>");

      // Bind the UTR to this order. @unique means one payment settles exactly
      // one order — a reference cannot be pasted into a second one.
      const claim = await claimUpiUtrForOrder(orderId, digits);
      if (!claim.ok) {
        ctx.session.awaiting = undefined;
        ctx.session.upiOrderId = undefined;
        await step("▰▰▰▰▰", claim.reason === "ALREADY_USED" ? "⚠️ <b>Already used</b>" : "⚠️ <b>Order not awaiting payment</b>");
        return ctx.reply(
          claim.reason === "ALREADY_USED"
            ? "⚠️ That UTR has already been used for another payment.\n\nEach UPI payment can settle one order only. Paste the UTR from <b>this</b> payment, or open 🎫 Support if you think this is wrong."
            : "⚠️ This order is no longer awaiting payment. Check 📦 My orders, or open 🎫 Support.",
          { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("📦 My orders", cb("ord", "list", 1)).text("🎫 Support", "mnu:home") },
        );
      }
      await step("▰▰▰▰▱", "🔄 <b>Confirming with our team…</b>");

      ctx.session.upiOrderId = undefined;
      const notified = await notifyAdminsForApproval(ctx, orderId, "UPI", digits);
      await step("▰▰▰▰▰", "✅ <b>Reference accepted</b>");
      const ref2 = digits;
      if (notified === 0) await createTicket(ctx.user.id, "PAYMENT_ISSUE", `UPI payment for order ${orderId}, UTR: ${ref2}.`).catch(() => undefined);
      return ctx.reply(
        [
          "🧾 <b>Thanks — UTR received!</b>",
          "",
          `🔢 <code>${escapeHtml(ref2)}</code>`,
          "",
          "🧑‍💼 Our team is verifying your payment now. Your order is delivered here as soon as it clears. 🙏",
        ].join("\n"),
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("📦 My orders", cb("ord", "list", 1)).text("🏠 Menu", "mnu:home") },
      );
    }
    if (awaiting === "wallet_free_txn") {
      const txn = ctx.message.text.trim().slice(0, 128);
      const r = await creditFreeTopup(ctx.user.id, txn);
      if (r.ok) return ctx.reply(`✅ Deposited ${fmt(r.amountMinor, r.currency)} to your wallet! New balance: <b>${fmt(r.newBalanceMinor, r.currency)}</b>.`, { parse_mode: "HTML" });
      const msg: Record<string, string> = {
        NOT_FOUND: "❌ That Order ID wasn't found in Binance Pay history.",
        ALREADY_USED: "❌ That Order ID was already used.",
        NO_API: "⚠️ Auto-verify is off — we've logged it and support will credit you.",
        AMOUNT_MISMATCH: "❌ Could not read the amount.",
        NOT_PENDING: "❌ Could not process.",
        WRONG_USER: "❌ That deposit isn't yours.",
      };
      await createTicket(ctx.user.id, "PAYMENT_ISSUE", `Wallet deposit — Order ID ${txn} (${r.ok ? "ok" : r.reason}).`).catch(() => undefined);
      return ctx.reply(msg[r.reason] ?? "❌ Could not verify — support will check.");
    }
    if (awaiting === "wallet_topup_amount") {
      const rupees = Number.parseFloat(ctx.message.text.replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(rupees) || rupees <= 0) return ctx.reply("Please send a valid amount, e.g. 500");
      try {
        const t = await createWalletTopup(ctx.user.id, Math.round(rupees * 100));
        ctx.session.walletTopupId = t.id;
        return ctx.reply(
          [
            "💳 <b>Wallet Top-up</b>",
            "",
            `Amount: <b>${fmt(t.amountMinor, t.currency)}</b>`,
            `Send exactly: <b>${t.binanceAmount} ${t.binanceAsset}</b>`,
            `To Binance UID: <code>${t.binanceUid}</code>`,
            "",
            "After sending, tap the button and paste your Binance Order ID — your wallet is credited automatically.",
          ].join("\n"),
          { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("✅ I’ve paid — enter Order ID", "wal:topuptxn").row().text("🏠 Menu", "mnu:home") },
        );
      } catch (e) {
        return ctx.reply(isCoreError(e) ? (ERROR_COPY[e.code] ?? "Top-up unavailable right now.") : "Top-up unavailable right now.");
      }
    }
    if (awaiting === "wallet_topup_txn") {
      const topupId = ctx.session.walletTopupId ?? "";
      const txn = ctx.message.text.trim().slice(0, 128);
      const r = await verifyTopupByTxn(topupId, txn, ctx.user.id);
      if (r.ok) {
        ctx.session.walletTopupId = undefined;
        return ctx.reply(`✅ Wallet topped up by ${fmt(r.amountMinor, r.currency)}! New balance: <b>${fmt(r.newBalanceMinor, r.currency)}</b>.`, { parse_mode: "HTML" });
      }
      const note = r.reason === "AMOUNT_MISMATCH" ? "⚠️ That transaction’s amount doesn’t match. "
        : r.reason === "ALREADY_USED" ? "⚠️ That transaction was already used. "
        : r.reason === "NO_API" ? "⚠️ Auto-verify is off. " : "";
      await createTicket(ctx.user.id, "PAYMENT_ISSUE", `Wallet top-up ${topupId}, txn ${txn} (${r.ok ? "ok" : r.reason}).`).catch(() => undefined);
      return ctx.reply(`${note}We’ve logged your Transaction ID — our team will credit your wallet shortly.`);
    }
    if (awaiting === "api_key_name") {
      const name = ctx.message.text.trim().slice(0, 120) || "my key";
      const created = await createApiKey({ name, scopes: ["catalog:read", "orders:read", "orders:write", "wallet:read"], ownerUserId: ctx.user.id });
      const base = (loadConfig().PUBLIC_API_URL ?? "").replace(/\/$/, "") + "/api/v1/developer";
      await ctx.reply(
        [
          "✅ <b>API key created</b> — copy it now, it won’t be shown again:",
          "",
          `<code>${created.apiKey}</code>`,
          "",
          `Scopes: catalog:read, orders:read, orders:write, wallet:read`,
          "This key can browse products, check your balance, and <b>buy from your wallet</b>.",
          `Base URL: <code>${base}</code>`,
          `📖 Full docs: ${base}`,
          `🔧 Interactive reference: ${base}/docs`,
          `Send it as <code>Authorization: Bearer &lt;key&gt;</code> or the <code>X-API-Key</code> header.`,
        ].join("\n"),
        { parse_mode: "HTML" },
      );
      return render(ctx, await views.apiKeysListView(ctx.user), false);
    }
    if (awaiting === "search") {
      const q = ctx.message.text.trim().slice(0, 64);
      ctx.session.lastSearch = q;
      return render(ctx, await views.searchResultsView(ctx.user, q, 1), false);
    }
    if (awaiting === "coupon_code") {
      const code = ctx.message.text.trim().slice(0, 32);
      const res = await applyCouponToCart(ctx.user.id, code, ctx.user.currency as Currency);
      if (res.ok) await ctx.reply(`✅ Coupon <b>${escapeHtml(res.code ?? code)}</b> applied — you save <b>${fmt(res.discountMinor ?? 0, ctx.user.currency)}</b>! 🎉`, { parse_mode: "HTML" });
      else await ctx.reply(`❌ ${couponReason(res.reason ?? "INVALID")}`);
      return render(ctx, await views.checkoutSummaryView(ctx.user), false);
    }
    if (awaiting === "ticket") {
      const ticket = await createTicket(ctx.user.id, "OTHER", ctx.message.text.trim().slice(0, 2000));
      return ctx.reply(`🎫 Ticket <b>#${ticket.ticketNumber}</b> created. Support will reply here.`, {
        parse_mode: "HTML",
      });
    }
    if (awaiting === "support_chat") {
      const msg = ctx.message.text.trim().slice(0, 2000);
      const who = ctx.user.telegramHandle ? `@${ctx.user.telegramHandle}` : (ctx.user.firstName ?? String(ctx.from?.id ?? ""));
      const safe = msg.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      await enqueueAdminAlert(
        `💬 <b>Support chat</b> — from ${escapeHtml(who)} (id <code>${ctx.from?.id}</code>):\n${safe}`,
        [{ text: "↩️ Reply", callbackData: `adm:dm:${ctx.user.id}` }],
      );
      ctx.session.awaiting = "support_chat"; // stay in chat
      return ctx.reply("✅ Sent to our team — we'll reply here shortly. (🔚 tap End chat to exit)", {
        reply_markup: new InlineKeyboard().text("🔚 End chat", "sup:endchat"),
      });
    }
    // Don't pop the menu on random text — only /start, /menu or buttons open it.
    return ctx.reply("Tap /menu 🏠 to open the menu, or use /shop to browse.");
  });

  // ── Callback router (Bot UX doc §1: every callback answered < 1 s) ──
  bot.on("callback_query:data", async (ctx) => {
    const parsed = parseCb(ctx.callbackQuery.data);
    if (!parsed) {
      await ctx.answerCallbackQuery({ text: "Menu expired — use /start" });
      return;
    }
    const { ns, action, args } = parsed;
    const route = `${ns}:${action}`;
    const user = ctx.user;

    // Prevent double-submits on payment actions (rapid taps / concurrent webhooks).
    const isPay = route.startsWith("ord:pay");
    if (isPay) {
      const locked = await getRedis().set(`paylock:${user.id}`, "1", "EX", 60, "NX");
      if (!locked) { await ctx.answerCallbackQuery({ text: "⏳ Already processing your order…" }); return; }
      await ctx.editMessageReplyMarkup().catch(() => undefined); // remove buttons so it can't be tapped again
    }

    try {
      if (ns === "adm") {
        await handleAdminCallback(ctx, action, args);
        return;
      }
      switch (route) {
        case "mnu:home":
          await render(ctx, await views.menuView(user), true);
          break;
        case "mnu:help":
          await render(ctx, views.helpView(), true);
          break;
        case "mnu:noop":
          break;
        case "mnu:search":
          ctx.session.awaiting = "search";
          await ctx.reply("🔍 Type the product name you're looking for:");
          break;

        case "shp:home":
          await render(ctx, await views.shopHomeView(user, intArg(args, 0, 1)), true);
          break;
        case "shp:root":
          await render(ctx, await views.categoriesView(null), true);
          break;
        case "shp:sub":
          await render(ctx, await views.categoriesView(args[0] ?? null), true);
          break;
        case "shp:cat":
          await render(ctx, await views.productListView(user, args[0] ?? "", intArg(args, 1, 1)), true);
          break;
        case "shp:prod":
          ctx.session.buyProductId = args[0] ?? "";
          await render(ctx, await views.productView(user, args[0] ?? ""), true);
          break;

        // Shop by category — the brand-tile grid.
        case "cat:home":
          await ctx.answerCallbackQuery().catch(() => undefined);
          await render(ctx, await views.categoryGridView(user), true);
          break;
        case "cat:open":
          await ctx.answerCallbackQuery().catch(() => undefined);
          await render(ctx, await views.categoryProductsView(user, args[0] ?? "", intArg(args, 1, 1)), true);
          break;

        case "shp:find":
          await ctx.answerCallbackQuery();
          ctx.session.awaiting = "search";
          await ctx.reply("🔍 <b>Search products</b>\n\nSend a product name or keyword (e.g. <code>netflix</code>, <code>office</code>):", { parse_mode: "HTML" });
          break;
        case "src:pg": {
          const q = ctx.session.lastSearch ?? "";
          await render(ctx, await views.searchResultsView(user, q, intArg(args, 0, 1)), true);
          break;
        }

        case "crt:add":
          await addToCart(user.id, args[0] ?? "");
          await ctx.answerCallbackQuery({ text: "✅ Added to cart" });
          await render(ctx, await views.cartViewKb(user), true);
          break;
        case "crt:buynow": {
          await ctx.answerCallbackQuery();
          const vId = args[0] ?? "";
          const stock = await getVariantAvailable(vId);
          await render(ctx, views.quantityPickerView(vId, stock, ctx.session.buyProductId), true);
          break;
        }
        case "crt:qty": {
          const vId = args[0] ?? "";
          const stock = await getVariantAvailable(vId);
          let qty = intArg(args, 1, 1);
          if (qty < 1) qty = 1;
          if (stock < 1_000_000 && qty > stock) qty = stock;
          await clearCart(user.id);
          await addToCart(user.id, vId, qty);
          await ctx.answerCallbackQuery({ text: `Quantity: ${qty}` });
          await render(ctx, await views.checkoutSummaryView(user), true);
          break;
        }
        case "crt:qtycustom": {
          const vId = args[0] ?? "";
          ctx.session.buyVariantId = vId;
          ctx.session.buyMaxQty = await getVariantAvailable(vId);
          ctx.session.awaiting = "buy_qty";
          await ctx.answerCallbackQuery();
          const cap = ctx.session.buyMaxQty >= 1_000_000 ? "" : ` (max ${ctx.session.buyMaxQty})`;
          await ctx.reply(`🔢 Send the quantity you want${cap}:`);
          break;
        }
        case "crt:view":
          await render(ctx, await views.cartViewKb(user), true);
          break;
        case "crt:inc":
          await changeQty(user.id, args[0] ?? "", 1);
          await render(ctx, await views.cartViewKb(user), true);
          break;
        case "crt:dec":
          await changeQty(user.id, args[0] ?? "", -1);
          await render(ctx, await views.cartViewKb(user), true);
          break;
        case "crt:del":
          await removeItem(user.id, args[0] ?? "");
          await render(ctx, await views.cartViewKb(user), true);
          break;
        case "crt:clear":
          await clearCart(user.id);
          await render(ctx, await views.cartViewKb(user), true);
          break;
        case "crt:checkout":
          await render(ctx, await views.checkoutSummaryView(user), true);
          break;
        case "crt:coupon":
          await ctx.answerCallbackQuery();
          ctx.session.awaiting = "coupon_code";
          await ctx.reply("🎟 Send your <b>coupon code</b> to apply a discount:", { parse_mode: "HTML" });
          break;
        case "crt:couponrm":
          await removeCouponFromCart(user.id);
          await ctx.answerCallbackQuery({ text: "Coupon removed" });
          await render(ctx, await views.checkoutSummaryView(user), true);
          break;

        // Wallet pay is a two-step: confirm what will be charged, THEN charge.
        case "ord:paywallet": {
          await ctx.answerCallbackQuery();
          const [cv, w] = await Promise.all([
            getCartView(user.id, user.currency as Currency),
            getWallet(user.id),
          ]);
          if (cv.lines.length === 0) { await ctx.reply(ERROR_COPY.CART_EMPTY ?? "🛒 Your cart is empty."); break; }
          const walletCur = w.currency as Currency;
          const payable = cv.subtotalMinor;
          const charge = walletCur === (user.currency as Currency) ? payable : convertMinor(payable, user.currency as Currency, walletCur);
          const after = Number(w.balanceMinor) - charge;
          await ctx.reply(
            [
              "🧾 <b>Confirm your purchase</b>",
              "",
              ...cv.lines.map((l) => `📦 ${escapeHtml(l.productName)}${l.quantity > 1 ? ` ×${l.quantity}` : ""} — ${l.lineTotalMinor === null ? "—" : fmt(l.lineTotalMinor, cv.currency)}`),
              "",
              `💳 <b>Total: ${fmt(payable, cv.currency)}</b>`,
              walletCur !== (user.currency as Currency) ? `🔁 Charged from wallet: <b>${fmt(charge, walletCur)}</b>` : "",
              "",
              `💰 Wallet now: <b>${fmt(w.balanceMinor, walletCur)}</b>`,
              `💰 After payment: <b>${fmt(Math.max(0, after), walletCur)}</b>`,
              "",
              after < 0 ? "⚠️ Not enough balance — top up first." : "⚡ Your item is delivered here the moment you confirm.",
            ].filter((l) => l !== "").join("\n"),
            {
              parse_mode: "HTML",
              reply_markup: after < 0
                ? new InlineKeyboard().text("➕ Add balance", cb("wal", "topup")).row().text("✖️ Cancel", cb("crt", "view"))
                : new InlineKeyboard()
                    .add(sbtn(`✅ Confirm & pay ${fmt(charge, walletCur)}`, cb("ord", "paywalletok"), "success")).row()
                    .text("✖️ Cancel", cb("crt", "view")),
            },
          );
          break;
        }
        case "ord:paywalletok": {
          await ctx.answerCallbackQuery({ text: "⏳ Processing…" });
          await vipAnimation(ctx);
          const result = await checkoutWithWallet(user.id);
          await ctx.reply(
            successCard("Order Success", [
              `✅ Payment confirmed`,
              `📦 Order <b>${result.orderNumber}</b>`,
              `💰 Amount ${fmt(result.totalMinor, result.currency)}`,
              `🙏 Thank you so much, ${greetName(user)} — it is an honour to serve you!`,
            ]),
            { parse_mode: "HTML" },
          );
          await deliverAll(ctx, result.deliveries, result.orderNumber);
          if (result.pendingManualItems > 0) {
            await ctx.reply(
              `⏳ <b>${result.pendingManualItems} item(s) being prepared</b>\nThey arrive in this chat automatically — usually within a minute. Nothing more to do.`,
              { parse_mode: "HTML" },
            );
          }
          // Discovery: after paying, show tier progress and offer the spin.
          try {
            const [ts, scfg] = await Promise.all([tierOf(user.id), getSpinConfig()]);
            const rowKb = new InlineKeyboard();
            rowKb.text("🏆 My Tier", cb("prf", "tier"));
            if (scfg.enabled) rowKb.text("🎡 Spin & Win", cb("spn", "ord", result.orderId));
            await ctx.reply(
              [
                `🏆 <b>${ts.tier.name} member</b> — ${escapeHtml(ts.tier.perk)}`,
                ts.next
                  ? `📈 Spend <b>${fmt(ts.toNextMinor, ts.currency)}</b> more to reach <b>${ts.next.name}</b>`
                  : "👑 You're at the top tier — thank you!",
                scfg.enabled ? "\n🎡 <b>You earned a spin!</b> Tap below to try your luck." : "",
              ].filter(Boolean).join("\n"),
              { parse_mode: "HTML", reply_markup: rowKb },
            );
          } catch { /* never block a delivery over this */ }
          // One tidy closing message: instructions + referral, not three separate ones.
          const closing = [
            await deliveryInstructionsMessage(),
            // Referral pitch only on the day's first delivery, not every order.
            (await shouldSendReferralNudge(user.id)) ? referralNudgeMessage(user.referralCode, ctx.me.username) : null,
          ].filter(Boolean).join("\n\n");
          if (closing) await ctx.reply(closing, { parse_mode: "HTML" }).catch(() => undefined);
          break;
        }
        // Pay Later is credit — confirm the debt before it is taken on.
        case "ord:paybnpl": {
          await ctx.answerCallbackQuery();
          const [cvb, bn] = await Promise.all([
            getCartView(user.id, user.currency as Currency),
            getBnplStatus(user.id),
          ]);
          if (cvb.lines.length === 0) { await ctx.reply(ERROR_COPY.CART_EMPTY ?? "🛒 Your cart is empty."); break; }
          const bCur = bn.currency as Currency;
          const bPayable = cvb.subtotalMinor;
          const bCharge = bCur === (user.currency as Currency) ? bPayable : convertMinor(bPayable, user.currency as Currency, bCur);
          const owedAfter = bn.outstandingMinor + bCharge;
          const leftAfter = bn.availableMinor - bCharge;
          await ctx.reply(
            [
              "🕐 <b>Confirm Pay Later</b>",
              "",
              ...cvb.lines.map((l) => `📦 ${escapeHtml(l.productName)}${l.quantity > 1 ? ` ×${l.quantity}` : ""} — ${l.lineTotalMinor === null ? "—" : fmt(l.lineTotalMinor, cvb.currency)}`),
              "",
              `💳 <b>Total: ${fmt(bPayable, cvb.currency)}</b>`,
              bCur !== (user.currency as Currency) ? `🔁 Added to your credit: <b>${fmt(bCharge, bCur)}</b>` : "",
              "",
              `🕐 You already owe: <b>${fmt(bn.outstandingMinor, bCur)}</b>`,
              `🧾 <b>You will owe: ${fmt(owedAfter, bCur)}</b>`,
              `📉 Credit left after: <b>${fmt(Math.max(0, leftAfter), bCur)}</b>`,
              "",
              leftAfter < 0
                ? "⚠️ This exceeds your Pay Later limit — pay from your wallet instead, or repay some of what you owe."
                : "ℹ️ You are taking this on credit. Repay from 💳 Wallet → Repay to free the limit up again.",
            ].filter((l) => l !== "").join("\n"),
            {
              parse_mode: "HTML",
              reply_markup: leftAfter < 0
                ? new InlineKeyboard().text("💰 Pay from wallet", cb("ord", "paywallet")).row().text("✖️ Cancel", cb("crt", "view"))
                : new InlineKeyboard()
                    .add(sbtn(`✅ Confirm — owe ${fmt(bCharge, bCur)}`, cb("ord", "paybnplok"), "primary")).row()
                    .text("✖️ Cancel", cb("crt", "view")),
            },
          );
          break;
        }
        case "ord:paybnplok": {
          await ctx.answerCallbackQuery({ text: "⏳ Processing…" });
          await vipAnimation(ctx);
          try {
            const result = await checkoutWithBnpl(user.id);
            await ctx.reply(
              successCard("Order Placed — Pay Later", [
                `✅ Placed on 🕒 Pay Later (BNPL)`,
                `📦 Order <b>${result.orderNumber}</b>`,
                `🕒 Added to your BNPL balance: ${fmt(result.totalMinor, result.currency)}`,
                `🙏 Thank you so much, ${greetName(user)} — repay anytime from 💰 Wallet.`,
              ]),
              { parse_mode: "HTML" },
            );
            await deliverAll(ctx, result.deliveries, result.orderNumber);
            if (result.pendingManualItems > 0) await ctx.reply(`🔄 ${result.pendingManualItems} item(s) are being prepared — arriving here shortly.`);
            const instr = await deliveryInstructionsMessage();
            if (instr) await ctx.reply(instr, { parse_mode: "HTML" }).catch(() => undefined);
          } catch {
            await ctx.reply("❌ Couldn't place on Pay Later — your BNPL limit may be exceeded. Try another payment method.");
          }
          break;
        }
        case "ord:paygw": {
          await ctx.answerCallbackQuery({ text: "⏳ Creating payment link…" });
          const gw = await createGatewayCheckout(user.id, args[0] ?? "");
          const payKb = new InlineKeyboard()
            .url(`🔗 Pay ${fmt(gw.totalMinor, gw.currency)}`, gw.url)
            .row()
            .text("🛒 Back to Cart", "crt:view");
          await ctx.editMessageText(
            [
              `🧾 Order <b>${gw.orderNumber}</b> created — ${fmt(gw.totalMinor, gw.currency)}.`,
              "",
              "Complete the payment within <b>15 minutes</b>. Delivery lands here automatically after confirmation.",
            ].join("\n"),
            { parse_mode: "HTML", reply_markup: payKb },
          );
          break;
        }
        case "ord:paystars": {
          await ctx.answerCallbackQuery({ text: "⭐ Creating Stars invoice…" });
          const st = await createStarsCheckout(user.id);
          await ctx.replyWithInvoice(
            `Order ${st.orderNumber}`,
            `${config.STORE_NAME} — instant digital delivery`,
            st.orderId,
            "XTR",
            [{ label: `Order ${st.orderNumber}`, amount: st.stars }],
          );
          break;
        }
        case "ord:paybinance": {
          await ctx.answerCallbackQuery({ text: "⏳ Creating order…" });
          if (user.currency !== "USD") { await setUserCurrency(user.id, "USD"); user.currency = "USD"; }
          const bz = await createBinanceManualCheckout(user.id, { useWallet: args[0] === "w" });
          ctx.session.binanceOrderId = bz.orderId;
          ctx.session.payRetries = 0;
          // Arm the paste right away: the next message they send is treated as the Order ID.
          ctx.session.awaiting = "binance_txnid";
          await ctx.editMessageText(
            [
              `🟡 <b>Pay via Binance Pay</b>`,
              `🧾 Order <b>${bz.orderNumber}</b>`,
              "",
              "┏━━━━━━━━━━━━━━━━━━━━",
              `┃ 💵 <b>Amount</b>`,
              `┃ <code>${bz.binanceAmount}</code> ${bz.binanceAsset}`,
              "┃",
              `┃ 🆔 <b>Binance Pay ID</b>`,
              `┃ <code>${bz.binanceUid}</code>`,
              "┗━━━━━━━━━━━━━━━━━━━━",
              "",
              `🧮 Order value: <b>${fmt(bz.totalMinor, bz.currency)}</b>`,
              "",
              "📋 Tap the buttons below to copy the amount and the Pay ID — paste them straight into Binance.",
              "",
              "⚠️ Send the <b>exact</b> amount. A different amount cannot be matched automatically.",
              "",
              "✅ <b>After paying, just paste your Binance Order ID here</b> — we verify it and deliver instantly. No extra taps needed.",
              "",
              "<i>The Order ID is on your Binance payment receipt.</i>",
              "",
              "⚠️ Problem or error? Tap <b>I have paid — need help</b> and our team takes over.",
            ].join("\n"),
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard()
                .copyText(`📋 Copy amount — ${bz.binanceAmount} ${bz.binanceAsset}`, bz.binanceAmount)
                .row()
                .copyText(`📋 Copy Binance Pay ID — ${bz.binanceUid}`, String(bz.binanceUid))
                .row()
                .text("⚠️ I have paid — need help", `ord:binancehelp:${bz.orderId}`)
                .row()
                .text("🏠 Menu", "mnu:home"),
            },
          );
          break;
        }
        case "ord:binancetxn": {
          await ctx.answerCallbackQuery();
          if (!ctx.session.binanceOrderId) {
            await ctx.reply("This checkout expired. Please start again from your cart.");
            break;
          }
          ctx.session.awaiting = "binance_txnid";
          await ctx.reply(
            "🔎 Paste your Binance <b>Order ID</b> (open the payment in Binance → it’s the ID on the receipt):",
            { parse_mode: "HTML" },
          );
          break;
        }
        case "ord:binancehelp": {
          await ctx.answerCallbackQuery();
          const oid = args[0] ?? ctx.session.binanceOrderId ?? "";
          const notified = await notifyAdminsForApproval(ctx, oid, "Binance", "customer reported an issue").catch(() => 0);
          if (notified === 0) {
            await createTicket(user.id, "PAYMENT_ISSUE", `Binance payment issue on order ${oid} — customer tapped "need help".`).catch(() => undefined);
          }
          ctx.session.awaiting = "binance_txnid"; // they can still paste the ID
          await ctx.reply(
            [
              "🆘 <b>Our team has been notified</b>",
              "",
              "We're checking your payment now and will deliver here as soon as it's confirmed. 🙏",
              "",
              "💡 If you have the Binance <b>Order ID</b> from your receipt, paste it here — that usually verifies instantly.",
            ].join("\n"),
            { parse_mode: "HTML" },
          );
          break;
        }
        case "ord:binancepaid": {
          await ctx.answerCallbackQuery({ text: "Thanks! We’ll verify and deliver soon.", show_alert: true });
          await createTicket(user.id, "PAYMENT_ISSUE", `Binance payment sent for order ${args[0] ?? ""}. Please verify UID and confirm.`).catch(() => undefined);
          break;
        }
        case "ord:list":
          await render(ctx, await views.ordersView(user, intArg(args, 0, 1)), true);
          break;
        case "ord:view":
          await render(ctx, await views.orderDetailView(user, args[0] ?? ""), true);
          break;

        case "lang:home":
          await render(ctx, views.languageView(user), true);
          break;
        case "lang:set": {
          const loc = args[0] ?? "en";
          await setUserLocale(user.id, loc);
          user.locale = loc;
          await ctx.answerCallbackQuery({ text: t(loc, "lang_done") });
          await render(ctx, await views.menuView(user), true);
          break;
        }
        case "cur:home":
          await render(ctx, views.currencyView(user), true);
          break;
        case "cur:set": {
          const cur = args[0] === "USD" ? "USD" : "INR";
          await setUserCurrency(user.id, cur);
          user.currency = cur;
          await ctx.answerCallbackQuery({ text: t(user.locale, "cur_done", { cur }) });
          await render(ctx, await views.menuView(user), true);
          break;
        }
        case "ord:payupi": {
          await ctx.answerCallbackQuery({ text: "⏳ Creating UPI order…" });
          // A stale button must not silently flip a USDT customer to INR.
          if (user.currency !== "INR") {
            await ctx.reply(
              "🪙 Your currency is <b>USD (USDT)</b> — please pay with <b>Binance</b> (instant), or switch to <b>INR</b> from 💱 Currency to use UPI.",
              { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("💱 Currency", cb("cur", "home")).text("🏠 Menu", "mnu:home") },
            );
            break;
          }
          let up;
          try {
            up = await createUpiManualCheckout(user.id, { useWallet: args[0] === "w" });
          } catch (e) {
            const msg = isCoreError(e) ? (ERROR_COPY[e.code] ?? e.message) : "Something went wrong creating your UPI order.";
            await ctx.reply(`⚠️ ${msg}\n\nPlease try again, or pay with 🪙 Binance.`, {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard().text("🛒 Back to cart", cb("crt", "view")).text("🏠 Menu", "mnu:home"),
            });
            break;
          }
          ctx.session.upiOrderId = up.orderId;
          // Arm the UTR paste right away — no extra tap needed.
          ctx.session.awaiting = "upi_ref";
          // Build a UPI deep link for the EXACT amount and render it as a QR.
          const amountRupees = (up.totalMinor / 100).toFixed(2);
          const payee = up.payeeName || config.STORE_NAME;
          const upiUri =
            `upi://pay?pa=${encodeURIComponent(up.upiId)}&pn=${encodeURIComponent(payee)}` +
            `&am=${amountRupees}&cu=INR&tn=${encodeURIComponent(up.orderNumber)}`;
          const caption = [
            `🇮🇳 <b>Pay via UPI</b>`,
            `🧾 Order <b>${up.orderNumber}</b>`,
            "",
            ...(up.walletUsedMinor > 0
              ? [
                  `🧮 Order total: <b>${fmt(up.orderTotalMinor, up.currency)}</b>`,
                  `💰 Paid from wallet: <b>−${fmt(up.walletUsedMinor, up.currency)}</b>`,
                  "",
                ]
              : []),
            "┏━━━━━━━━━━━━━━━━━━",
            `┃ 💵 <b>Amount to pay</b>`,
            `┃ <code>${amountRupees}</code>`,
            "┃",
            `┃ 🆔 <b>UPI ID</b>`,
            `┃ <code>${up.upiId}</code>`,
            `┃ <i>${escapeHtml(payee)}</i>`,
            "┗━━━━━━━━━━━━━━━━━━",
            "",
            "📷 <b>Scan the QR</b> in any UPI app (GPay / PhonePe / Paytm) — the amount is pre-filled.",
            "📋 No QR? Tap the buttons below to copy the amount and UPI ID.",
            "",
            "✅ After paying, paste the <b>12-digit UTR</b> from your receipt here.",
            "",
            "⏳ <b>Pay within 5 minutes</b> — after that this order closes and you'll need to start again.",
            "🕐 UPI payments are checked <b>by our team</b>, so delivery can take a short while.",
            "⚡ Want it instantly? Pay with <b>Binance (USDT)</b> — that verifies automatically.",
          ].join("\n");
          // NOTE: no url() button for the upi:// link — Telegram only accepts
          // http/https/tg in inline URL buttons and rejects the whole message
          // with BUTTON_URL_INVALID, which made this screen fail silently.
          const upiKb = new InlineKeyboard()
            .copyText(`📋 Copy amount — ₹${amountRupees}`, amountRupees)
            .row()
            .copyText(`📋 Copy UPI ID — ${up.upiId}`, up.upiId)
            .row()
            .text("⚠️ I have paid — need help", "ord:upipaid")
            .row()
            .text("🏠 Menu", "mnu:home");
          try {
            const png = await QRCode.toBuffer(upiUri, { width: 512, margin: 2, color: { dark: "#000000", light: "#FFFFFF" } });
            await ctx.replyWithPhoto(new InputFile(png, "upi-qr.png"), {
              caption,
              parse_mode: "HTML",
              reply_markup: upiKb,
            });
          } catch {
            // QR generation or photo send failed — still show the payment details.
            try {
              await ctx.reply(caption, { parse_mode: "HTML", reply_markup: upiKb });
            } catch {
              await ctx.reply(caption.replace(/<[^>]+>/g, ""), {
                reply_markup: new InlineKeyboard().text("⚠️ I have paid — need help", "ord:upipaid").row().text("🏠 Menu", "mnu:home"),
              });
            }
          }
          break;
        }
        case "ord:upipaid": {
          await ctx.answerCallbackQuery();
          if (!ctx.session.upiOrderId) { await ctx.reply("This checkout expired. Please start again from your cart."); break; }
          ctx.session.awaiting = "upi_ref";
          await ctx.reply("🔎 Paste your UPI <b>reference / UTR number</b>:", { parse_mode: "HTML" });
          break;
        }
        case "lic:list":
          await render(ctx, await views.vaultView(user, intArg(args, 0, 1)), true);
          break;
        // Standalone 2FA/OTP generator — paste any secret, get the live code.
        case "otp:tool": {
          await ctx.answerCallbackQuery();
          await render(ctx, views.otpToolView(otpSecretOf(ctx), ctx.session.otpReveal === true), true);
          break;
        }
        case "otp:ask": {
          ctx.session.awaiting = "otp_secret";
          await ctx.answerCallbackQuery();
          await ctx.reply(
            [
              "🔐 <b>Send your 2FA secret key</b>",
              "",
              "Paste the Base32 setup key — the one an app would scan as a QR code.",
              "Spaces and lower case are fine; I'll tidy it up.",
              "",
              "<i>🔒 I delete your message straight after reading it, and the secret is never written to our database or any log. It is held encrypted for this session only so I can refresh the code — 🗑 Clear removes it immediately.</i>",
            ].join("\n"),
            { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("✖️ Cancel", cb("otp", "tool")) },
          );
          break;
        }
        case "otp:gen": {
          const secret = otpSecretOf(ctx);
          const t = secret ? generateTotp(secret) : null;
          if (!t) {
            await ctx.answerCallbackQuery({ text: "That secret is not valid — send it again", show_alert: true });
            break;
          }
          await ctx.answerCallbackQuery({ text: `Code ${t.code} · ${t.secondsLeft}s left` });
          await render(ctx, views.otpToolView(secret, ctx.session.otpReveal === true), true);
          break;
        }
        case "otp:eye": {
          ctx.session.otpReveal = !(ctx.session.otpReveal === true);
          await ctx.answerCallbackQuery();
          await render(ctx, views.otpToolView(otpSecretOf(ctx), ctx.session.otpReveal === true), true);
          break;
        }
        case "otp:clr": {
          // Wipe it from the session — the only place it ever lived.
          ctx.session.otpSecret = undefined;
          ctx.session.otpReveal = undefined;
          await ctx.answerCallbackQuery({ text: "Cleared" });
          await render(ctx, views.otpToolView(null, false), true);
          break;
        }
        case "otp:get": {
          await ctx.answerCallbackQuery();
          try {
            const rv = await revealDelivery(user.id, args[0] ?? "");
            const fixed = repairAccountPair(rv.payload.username, rv.payload.password);
            const secret = (fixed?.twofa ?? (rv.payload as { twofa?: string }).twofa ?? "").trim();
            const t = secret ? generateTotp(secret) : null;
            if (!t) {
              await ctx.reply("⚠️ No valid 2FA secret is stored for this item. Open a 🎫 Support ticket and we'll sort it.");
              break;
            }
            await ctx.reply(
              [
                "🔢 <b>Your login code</b>",
                "",
                `<code>${t.code}</code>`,
                "",
                `⏳ Valid for <b>${t.secondsLeft}s</b>${t.secondsLeft <= 8 ? ` — expiring soon, next code: <code>${t.nextCode}</code>` : ""}`,
                "",
                "<i>Tap the code to copy it. Codes change every 30 seconds — tap again for a fresh one.</i>",
              ].join("\n"),
              {
                parse_mode: "HTML",
                reply_markup: new InlineKeyboard()
                  .copyText(`📋 Copy ${t.code}`, t.code).row()
                  .text("🔄 New code", cb("otp", "get", args[0] ?? "")),
              },
            );
          } catch {
            await ctx.reply("⚠️ Couldn't read that item. Open it from 📦 My orders and try again.");
          }
          break;
        }
        case "lic:view": {
          const oiId = args[0] ?? "";
          const revealed = await revealDelivery(user.id, oiId);
          await sendRevealed(ctx, oiId, revealed.productName, revealed.variantName, revealed.payload);
          break;
        }
        case "ord:reveal": {
          await ctx.answerCallbackQuery({ text: "Fetching your keys…" });
          const all = await revealOrderDeliveries(user.id, args[0] ?? "");
          // Mark superseded units. For orders over 10 items this is the only way
          // the customer sees their keys, so a retired one must never be handed
          // back silently among the live ones.
          const ds = all.map((r) => ({
            orderItemId: "",
            productName: r.replaced ? `${r.productName} — ⚠️ REPLACED, no longer works` : r.productName,
            variantName: r.variantName,
            kind: (r.payload.kind === "DIGITAL_ACCOUNT" ? "DIGITAL_ACCOUNT" : "LICENSE_KEY") as "LICENSE_KEY" | "DIGITAL_ACCOUNT",
            secret: { key: r.payload.key, username: r.payload.username, password: r.payload.password, expiresAt: r.payload.expiresAt },
            activationGuide: null,
          }));
          if (ds.length === 0) { await ctx.reply("No delivered keys found for this order."); break; }
          const deadCount = all.filter((r) => r.replaced).length;
          if (deadCount > 0) {
            await ctx.reply(
              `ℹ️ <b>${deadCount} of these was replaced.</b> The old value is kept for your records but no longer works — it's marked <b>REPLACED</b> below, and the working one came in your replacement order.`,
              { parse_mode: "HTML" },
            );
          }
          await deliverAll(ctx, ds, args[0] ?? "");
          break;
        }

        case "wal:view":
          await render(ctx, await views.walletView(user), true);
          break;
        case "wal:hist":
          await render(ctx, await views.walletHistoryView(user, intArg(args, 0, 1)), true);
          break;
        case "wal:topup": {
          await ctx.answerCallbackQuery();
          const uid = config.BINANCE_PAY_UID;
          if (!uid) { await ctx.reply("Wallet deposits aren't configured yet."); break; }
          await ctx.reply(
            [
              "💳 <b>Add funds to your Wallet — Binance (USDT)</b>",
              "━━━━━━━━━━━━━━━━━━━━",
              "Deposit <b>any amount</b> — it is credited to your wallet automatically after we verify your Order ID.",
              "",
              "<b>Step 1.</b> Open the <b>Binance</b> app → <b>Pay</b> → <b>Send</b>.",
              "<b>Step 2.</b> Send USDT to our Binance UID:",
              `        👉 <code>${uid}</code>  (tap to copy)`,
              "<b>Step 3.</b> Enter the amount you want to deposit and confirm the transfer.",
              "<b>Step 4.</b> Open the completed payment in Binance and copy its <b>Order ID</b> (the long number in the transaction details).",
              "<b>Step 5.</b> Come back here, tap the button below, and paste the <b>Order ID</b>.",
              "",
              "✅ We read the exact USDT amount you sent and credit your wallet instantly.",
              "⚠️ Send only <b>USDT</b>. Each Order ID can be used once.",
            ].join("\n"),
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard()
                .copyText(`📋 Copy Binance Pay ID — ${uid}`, String(uid)).row()
                .text("✅ I have deposited — enter Order ID", "wal:freetxn").row()
                .add(...(config.UPI_ID && user.currency === "INR" ? [{ text: "🇮🇳 Add INR via UPI (🕐 manual approval)", callback_data: "wal:topupinr" }] : [])).row()
                .text("🏠 Menu", "mnu:home"),
            },
          );
          break;
        }
        case "wal:bnplrepay": {
          await ctx.answerCallbackQuery({ text: "Processing…" });
          try {
            const r = await repayBnpl(user.id);
            if (r.repaidMinor > 0) await ctx.reply(`✅ Repaid <b>${fmt(r.repaidMinor, r.currency)}</b> from your wallet. Remaining BNPL: <b>${fmt(r.outstandingMinor, r.currency)}</b>.`, { parse_mode: "HTML" });
            else await ctx.reply("Nothing to repay, or your wallet balance is 0. Top up first.");
          } catch { await ctx.reply("Couldn't repay — add wallet funds first."); }
          await render(ctx, await views.walletView(user), false);
          break;
        }
        case "wal:topupinr": {
          await ctx.answerCallbackQuery();
          if (!config.UPI_ID) { await ctx.reply("UPI deposits aren't configured yet."); break; }
          if (user.currency !== "INR") {
            await ctx.reply(
              "🪙 Your wallet currency is <b>USD (USDT)</b>, so deposits go through <b>Binance</b> — it is instant and automatic.\n\nSwitch your currency to <b>INR</b> from 💱 Currency if you want to pay by UPI.",
              { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("💱 Currency", cb("cur", "home")).text("🏠 Menu", "mnu:home") },
            );
            break;
          }
          ctx.session.awaiting = "wallet_inr_amount";
          await ctx.reply(
            "🇮🇳 <b>Add INR to your wallet</b>\n\nHow much do you want to add? Send the amount in ₹ (e.g. <code>500</code>).\n\n<i>Your wallet is held in USD and credited at the store rate.</i>",
            { parse_mode: "HTML" },
          );
          break;
        }
        case "wal:topuptxn": {
          // This button was emitted but never handled. The customer had already
          // SENT the USDT, tapped "I've paid — enter Order ID", and nothing
          // happened — while the message above it promised their wallet would be
          // credited automatically. The wallet_topup_txn text handler and
          // verifyTopupByTxn were both already written and reachable from
          // nowhere; only the case was missing.
          await ctx.answerCallbackQuery();
          if (!ctx.session.walletTopupId) {
            await ctx.reply(
              "That top-up request has expired. Start a new one from 💳 Wallet — if you already sent the payment, open 🎫 Support and we'll sort it out.",
              { reply_markup: new InlineKeyboard().text("💳 Wallet", "wal:view").row().text("🏠 Menu", "mnu:home") },
            );
            break;
          }
          ctx.session.awaiting = "wallet_topup_txn";
          await ctx.reply(
            "🔎 Paste your Binance <b>Order ID</b> now (Binance → Pay → History → the completed payment). We'll verify it and credit your wallet.",
            { parse_mode: "HTML" },
          );
          break;
        }
        case "wal:freetxn":
          await ctx.answerCallbackQuery();
          ctx.session.awaiting = "wallet_free_txn";
          await ctx.reply("🔎 Paste your Binance <b>Order ID</b> now (from the completed payment in Binance → Pay → History). We will verify it and credit your wallet instantly:", { parse_mode: "HTML" });
          break;
        case "api:home":
          await render(ctx, await views.apiKeysView(user), true);
          break;
        case "api:list":
          await render(ctx, await views.apiKeysListView(user), true);
          break;
        case "api:fixscopes": {
          await ctx.answerCallbackQuery({ text: "Updating…" });
          const r = await grantAllScopesToOwner(user.id);
          await ctx.reply(
            [
              `🛠 <b>Permissions updated</b> — ${r.updated} key(s).`,
              "",
              `Your keys now have: <code>${r.scopes.join("</code>, <code>")}</code>`,
              "",
              "Catalog, balance and orders endpoints will all respond now. No need to regenerate the key.",
            ].join("\n"),
            { parse_mode: "HTML" },
          );
          await render(ctx, await views.apiKeysView(user), false);
          break;
        }
        case "api:docs":
          await render(ctx, views.apiDocsView(), true);
          break;
        case "api:orders":
          await render(ctx, await views.apiOrdersView(user), true);
          break;
        case "api:balance":
          await render(ctx, await views.apiBalanceView(user), true);
          break;
        case "api:new":
          await ctx.answerCallbackQuery();
          ctx.session.awaiting = "api_key_name";
          await ctx.reply("🧑‍💻 Send a <b>name</b> for your API key (e.g. <code>my app</code>):", { parse_mode: "HTML" });
          break;
        case "api:revoke": {
          const done = await revokeApiKeyOwned(args[0] ?? "", user.id);
          await ctx.answerCallbackQuery({ text: done ? "Revoked" : "Not found" });
          await render(ctx, await views.apiKeysListView(user), true);
          break;
        }

        case "rep:nopic": {
          await ctx.answerCallbackQuery();
          await submitReplaceOrTicket(ctx, undefined);
          break;
        }
        case "rev:new": {
          await ctx.answerCallbackQuery();
          const oid = args[0] ?? "";
          if (oid && (await orderAlreadyRated(oid))) {
            await ctx.reply("🙏 You've already rated this order — thank you! One rating per order keeps them honest.");
            break;
          }
          const kb = new InlineKeyboard()
            .text("⭐️", `rev:rate:${oid}:1`).text("⭐️⭐️", `rev:rate:${oid}:2`).row()
            .text("⭐️⭐️⭐️", `rev:rate:${oid}:3`).row()
            .text("⭐️⭐️⭐️⭐️", `rev:rate:${oid}:4`).row()
            .text("⭐️⭐️⭐️⭐️⭐️", `rev:rate:${oid}:5`);
          await ctx.reply(
            `⭐ <b>How would you rate your order, ${escapeHtml(greetName(user))}?</b>\n\nTap the stars — it takes one second and really helps us. 🙏`,
            { parse_mode: "HTML", reply_markup: kb },
          );
          break;
        }
        case "rev:rate": {
          const oid = args[0] ?? "";
          const rating = Math.min(5, Math.max(1, Number.parseInt(args[1] ?? "5", 10) || 5));
          let saved: { id: string; alreadyRated: boolean };
          try {
            saved = await saveReview(user.id, rating, oid || undefined);
          } catch (err) {
            const m = String(err instanceof Error ? err.message : err);
            await ctx.answerCallbackQuery({
              text: m.includes("NOT_ELIGIBLE") ? "Only delivered orders can be rated." : "That order was not found.",
              show_alert: true,
            }).catch(() => undefined);
            break;
          }
          ctx.session.reviewId = saved.id;
          await ctx.answerCallbackQuery({ text: "Thank you! 🙏" });
          const stars = "⭐️".repeat(rating);
          const warm = rating >= 4
            ? [
                `🎉 <b>Thank you so much, ${escapeHtml(greetName(user))}!</b> 💖`,
                "",
                `${stars}`,
                "",
                "Your support genuinely means a lot to us — it is customers like you that keep this store going. 🙏✨",
                "",
                "🛍 We'll keep the best deals coming just for you!",
                "",
                "<i>Your review will appear publicly once our team checks it.</i>",
              ]
            : [
                `🙏 <b>Thank you for the honest feedback, ${escapeHtml(greetName(user))}.</b>`,
                "",
                `${stars}`,
                "",
                "We're sorry it wasn't perfect — and we want to make it right.",
                "",
                "Tell us what went wrong below and our team will fix it personally. 💬",
              ];
          ctx.session.awaiting = "review_comment";
          await ctx.reply(warm.join("\n"), {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
              .text("✍️ Add a comment", "rev:comment").row()
              .text("🛍 Shop again", cb("shp", "home", 1)).text("🏠 Menu", "mnu:home"),
          });
          // Admins moderate before anything is published.
          await enqueueAdminAlert(
            [
              `⭐ <b>New review — awaiting approval</b>`,
              `${stars} <b>${rating}/5</b>`,
              `👤 ${escapeHtml(greetName(user))}`,
              `🆔 <code>${user.telegramId ?? "—"}</code>`,
              oid ? `🧾 Order <code>${escapeHtml(oid.slice(-8))}</code>` : "",
              "",
              "<i>It is not visible to customers until you approve it.</i>",
            ].filter(Boolean).join("\n"),
            [
              { text: "✅ Approve", callbackData: `adm:revok:${saved.id}`, style: "success" },
              { text: "❌ Reject", callbackData: `adm:revno:${saved.id}`, style: "danger" },
              { text: "💬 Reply", callbackData: `adm:revrep:${saved.id}`, style: "primary" },
            ],
          ).catch(() => undefined);
          break;
        }
        case "rev:comment":
          await ctx.answerCallbackQuery();
          ctx.session.awaiting = "review_comment";
          await ctx.reply("✍️ Send your comment — we read every one.");
          break;

        case "dls:home":
          await render(ctx, await views.dealsView(user), true);
          break;
        case "wch:list":
          await render(ctx, await views.watchlistView(user), true);
          break;
        case "wch:clear": {
          const ws = await listWatches(user.id);
          for (const w of ws) await unwatchProduct(user.id, w.productId, w.type);
          await ctx.answerCallbackQuery({ text: "Watchlist cleared" });
          await render(ctx, await views.watchlistView(user), true);
          break;
        }
        case "lic:find":
          await ctx.answerCallbackQuery();
          ctx.session.awaiting = "keys_search";
          await ctx.reply("🔑 <b>Find your keys</b>\n\nSend part of the product name (e.g. <code>netflix</code>):", { parse_mode: "HTML" });
          break;
        case "ord:again": {
          await ctx.answerCallbackQuery({ text: "Adding to cart…" });
          const lines = await reorderLines(user.id, args[0] ?? "");
          if (lines.length === 0) {
            await ctx.reply("⚠️ None of those items are available any more. Browse 🛍 Shop for what's in stock.");
            break;
          }
          await clearCart(user.id);
          for (const l of lines) await addToCart(user.id, l.variantId, l.quantity).catch(() => undefined);
          await ctx.reply(
            [`⚡ <b>Added to your cart</b>`, "", ...lines.map((l) => `📦 ${escapeHtml(l.productName)}${l.quantity > 1 ? ` ×${l.quantity}` : ""}`), "", "Ready when you are 👇"].join("\n"),
            { parse_mode: "HTML" },
          );
          await render(ctx, await views.checkoutSummaryView(user), false);
          break;
        }
        case "wch:onr": case "wch:onp": {
          const kind = action === "wch:onr" ? "RESTOCK" : "PRICE_DROP";
          const pid = args[0] ?? "";
          let base: number | undefined;
          if (kind === "PRICE_DROP") {
            const pv = await getProductView(pid, user.currency as Currency, user.id, "DIRECT", user.locale).catch(() => null);
            const priced = (pv?.variants ?? []).map((v) => v.priceMinor).filter((n): n is number => n !== null);
            base = priced.length ? Math.min(...priced) : undefined;
          }
          const r = await watchProduct(user.id, pid, kind, base, user.currency as Currency);
          await ctx.answerCallbackQuery({
            text: r.already ? "Already on the list" : kind === "RESTOCK" ? "🔔 We'll tell you first!" : "📉 We'll tell you if it drops!",
            show_alert: !r.already,
          });
          await render(ctx, await views.productView(user, pid), true);
          break;
        }
        case "wch:offr": case "wch:offp": {
          const kind = action === "wch:offr" ? "RESTOCK" : "PRICE_DROP";
          await unwatchProduct(user.id, args[0] ?? "", kind);
          await ctx.answerCallbackQuery({ text: "Stopped notifying" });
          await render(ctx, await views.productView(user, args[0] ?? ""), true);
          break;
        }
        case "rep:home":
          await render(ctx, await views.replaceListView(user), true);
          break;
        case "rep:pick": {
          const it = await getReplaceableItem(user.id, args[0] ?? "");
          if (!it) { await ctx.answerCallbackQuery({ text: "Item not found" }); break; }
          await ctx.answerCallbackQuery();
          // Out of warranty: no replacement button at all — only the option to
          // raise a ticket, which a human answers.
          if (it.route === "ticket") { await render(ctx, views.replaceTicketOfferView(it), true); break; }
          if (it.route === "blocked") { await render(ctx, views.replaceBlockedView(it), true); break; }
          ctx.session.replaceItemId = it.orderItemId;
          ctx.session.replaceReason = undefined;
          ctx.session.replaceViaTicket = false;
          ctx.session.awaiting = "replace_reason";
          await render(ctx, views.replaceAskReasonView(it.label, false), true);
          break;
        }
        // Per-order unit picker: choose exactly which delivered unit(s) to claim on.
        case "rep:ord": {
          const oid = args[0] ?? "";
          if (ctx.session.replaceOrderId !== oid) { ctx.session.replaceSelected = []; ctx.session.replacePage = 1; }
          ctx.session.replaceOrderId = oid;
          await ctx.answerCallbackQuery();
          await render(ctx, await views.replaceSelectView(user, oid, ctx.session.replaceSelected ?? []), true);
          break;
        }
        case "rep:tog": {
          const id = args[0] ?? "";
          const oid = ctx.session.replaceOrderId ?? "";
          const cur = new Set(ctx.session.replaceSelected ?? []);
          const adding = !cur.has(id);
          if (adding && cur.size >= 25) {
            // Say so rather than silently dropping the tap.
            await ctx.answerCallbackQuery({ text: "That's the maximum of 25 items in one request.", show_alert: true });
            break;
          }
          if (adding) cur.add(id); else cur.delete(id);
          ctx.session.replaceSelected = [...cur];
          await ctx.answerCallbackQuery({ text: adding ? "Selected" : "Removed" });
          await render(ctx, await views.replaceSelectView(user, oid, ctx.session.replaceSelected, ctx.session.replacePage ?? 1), true);
          break;
        }
        case "rep:pg": {
          const oid = args[0] ?? ctx.session.replaceOrderId ?? "";
          ctx.session.replacePage = Math.max(1, Number.parseInt(args[1] ?? "1", 10) || 1);
          await ctx.answerCallbackQuery();
          await render(ctx, await views.replaceSelectView(user, oid, ctx.session.replaceSelected ?? [], ctx.session.replacePage), true);
          break;
        }
        case "rep:all": {
          const oid = args[0] ?? "";
          const units = await listUnitsForOrder(user.id, oid);
          const eligible = units.filter((u) => u.route === "claim" || u.route === "ticket").map((u) => u.orderItemId);
          const cur = ctx.session.replaceSelected ?? [];
          // Toggle: a full selection clears, anything else selects all eligible.
          const capped = Math.min(eligible.length, 25);
          ctx.session.replaceSelected = cur.length >= capped ? [] : eligible.slice(0, 25);
          await ctx.answerCallbackQuery({ text: eligible.length > 25 ? "Selected the first 25 eligible items" : undefined });
          await render(ctx, await views.replaceSelectView(user, oid, ctx.session.replaceSelected, ctx.session.replacePage ?? 1), true);
          break;
        }
        case "rep:go": {
          const sel = ctx.session.replaceSelected ?? [];
          if (sel.length === 0) { await ctx.answerCallbackQuery({ text: "Pick at least one item first", show_alert: true }); break; }
          ctx.session.replaceBatch = sel;
          ctx.session.replaceItemId = undefined;
          ctx.session.replaceViaTicket = undefined;
          ctx.session.awaiting = "replace_reason";
          await ctx.answerCallbackQuery();
          await render(ctx, views.replaceBatchAskReasonView(sel.length), true);
          break;
        }
        case "rep:tkt": {
          const it = await getReplaceableItem(user.id, args[0] ?? "");
          if (!it) { await ctx.answerCallbackQuery({ text: "Item not found" }); break; }
          if (it.route !== "ticket") { await ctx.answerCallbackQuery({ text: "Use the replacement claim for this item", show_alert: true }); break; }
          ctx.session.replaceItemId = it.orderItemId;
          ctx.session.replaceReason = undefined;
          ctx.session.replaceViaTicket = true;
          ctx.session.awaiting = "replace_reason";
          await ctx.answerCallbackQuery();
          await render(ctx, views.replaceAskReasonView(it.label, true), true);
          break;
        }

        case "tkt:open": {
          await ctx.answerCallbackQuery();
          await render(ctx, await views.ticketThreadView(user, args[0] ?? ""), true);
          break;
        }
        case "tkt:re": {
          const id = args[0] ?? "";
          ctx.session.ticketId = id;
          ctx.session.awaiting = "ticket_reply";
          await ctx.answerCallbackQuery();
          await ctx.reply("💬 Type your reply to support (you can attach a screenshot instead):", {
            reply_markup: new InlineKeyboard().text("✖️ Cancel", `tkt:open:${id}`),
          });
          break;
        }

        case "ref:view":
          await render(ctx, await views.referralView(user, ctx.me.username), true);
          break;

        case "sup:home":
          await render(ctx, await views.supportHomeView(user), true);
          break;
        case "sup:new":
          ctx.session.awaiting = "ticket";
          await ctx.reply("🎫 Describe your issue in one message:");
          break;
        case "sup:chat":
          ctx.session.awaiting = "support_chat";
          await ctx.reply(
            "💬 <b>Live Support Chat</b>\nType your message and our team will reply here. You can keep sending messages.\nTap 🔚 End chat when you're done.",
            { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🔚 End chat", "sup:endchat") },
          );
          break;
        case "sup:endchat":
          ctx.session.awaiting = null;
          await ctx.answerCallbackQuery({ text: "Chat ended" });
          await render(ctx, await views.menuView(user), false);
          break;

        case "prf:tier":
          await render(ctx, await views.tierView(user), true);
          break;
        case "spn:ord": {
          const r = await spinForOrder(user.id, args[0] ?? "");
          if (!r.ok) {
            await ctx.answerCallbackQuery({
              text:
                r.reason === "ALREADY_SPUN" ? "You already spun for this order"
                : r.reason === "DAILY_LIMIT" ? `Daily limit reached — ${r.maxSpinsPerDay} spins a day. Try again tomorrow!`
                : r.reason === "ON_MISSION" ? "Spins are paused while your Mission is active"
                : r.reason === "DISABLED" ? "Not running right now"
                : "Not eligible",
              show_alert: true,
            });
            break;
          }
          await ctx.answerCallbackQuery({ text: "🎡 Spinning…" });
          const cur = (r.currency ?? user.currency) as Currency;
          await ctx.reply(
            r.won
              ? [
                  "🎡✨ <b>YOU WON!</b> ✨🎡",
                  "",
                  `🎁 <b>${fmt(r.rewardMinor ?? 0, cur)}</b> has been added to your wallet.`,
                  "",
                  `💰 Spend it on your next order — you get a spin with every purchase (up to ${r.maxSpinsPerDay ?? 3} a day).`,
                ].join("\n")
              : [
                  "🎡 <b>Better luck next time!</b> 🍀",
                  "",
                  `This spin didn't win — orders under <b>${fmt(r.minSpendMinor ?? 0, cur)}</b> aren't eligible for a prize.`,
                  "",
                  `🛍 Your order was <b>${fmt(r.orderValueMinor ?? 0, cur)}</b>. Spend a little more next time and your spin can win!`,
                ].join("\n"),
            { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("💳 Wallet", cb("wal", "view")).text("🛍 Shop", cb("shp", "home", 1)) },
          );
          break;
        }
        case "spn:home":
          await render(ctx, await views.spinView(user), true);
          break;
        case "msn:home":
          await render(ctx, await views.missionView(user), true);
          break;
        case "msn:go": {
          const r = await spin(user.id);
          await ctx.answerCallbackQuery({ text: r.ok ? "🎡 Spinning…" : r.reason === "ALREADY_ACTIVE" ? "You already have a challenge" : "Not available" });
          if (r.ok && r.challenge) {
            await ctx.reply(
              [
                "🎡 <b>Your challenge is set!</b>",
                "",
                `🎯 Spend <b>${fmt(r.challenge.targetMinor, r.challenge.currency)}</b>`,
                `🎁 Earn <b>${fmt(r.challenge.rewardMinor, r.challenge.currency)}</b> wallet credit`,
                `📅 You have until ${r.challenge.expiresAt.toISOString().slice(0, 10)}`,
                "",
                "Only spending from now on counts. Good luck! 🍀",
              ].join("\n"),
              { parse_mode: "HTML" },
            );
          }
          await render(ctx, await views.missionView(user), false);
          break;
        }
        case "msn:claim": {
          const r = await claimChallenge(user.id, args[0] ?? "");
          await ctx.answerCallbackQuery({
            text: r.ok ? "🎉 Reward added!" : r.reason === "NOT_REACHED" ? "Not there yet" : r.reason === "ALREADY_CLAIMED" ? "Already claimed" : "Expired",
            show_alert: !r.ok,
          });
          await render(ctx, await views.missionView(user), false);
          break;
        }
        case "prf:orders":
          await render(ctx, await views.recentOrdersView(user), true);
          break;
        case "prf:view":
          await render(ctx, await views.profileView(user), true);
          break;
        case "set:view":
          await render(ctx, views.settingsView(user), true);
          break;
        case "set:curr": {
          const next = user.currency === "INR" ? "USD" : "INR";
          await setUserCurrency(user.id, next);
          user.currency = next;
          await ctx.answerCallbackQuery({ text: `Currency: ${next}` });
          await render(ctx, views.settingsView(user), true);
          break;
        }

        case "rsl:home":
          await ctx.answerCallbackQuery({
            text: "Reseller hub opens with the reseller phase.",
            show_alert: true,
          });
          break;

        default:
          await ctx.answerCallbackQuery({ text: "Menu expired — use /start" });
      }
      // Ensure the spinner always stops.
      await ctx.answerCallbackQuery().catch(() => undefined);
    } catch (e) {
      const copy = isCoreError(e) ? (ERROR_COPY[e.code] ?? "Something went wrong.") : "Something went wrong.";
      await ctx.answerCallbackQuery({ text: copy, show_alert: true }).catch(() => undefined);
      if (!isCoreError(e)) throw e;
    } finally {
      if (isPay) await getRedis().del(`paylock:${user.id}`).catch(() => undefined);
    }
  });

  bot.catch((err) => {
    // Structured error logging; secrets never enter error paths.
    // eslint-disable-next-line no-console
    console.error("bot error", { update_id: err.ctx.update.update_id, error: String(err.error) });
    // Also record it so an admin can read it in the bot (🩺 Logs).
    void logError("bot", err.error, {
      update: err.ctx.update.update_id ?? null,
      from: err.ctx.from?.id ?? null,
      data: err.ctx.callbackQuery?.data ?? null,
    });
  });

  return bot;
}

async function sendDelivery(ctx: Ctx, d: DeliveredSecret): Promise<void> {
  const oiId = (d as unknown as { orderItemId?: string }).orderItemId ?? "";
  await sendRevealed(ctx, oiId, d.productName, d.variantName, { kind: d.kind, ...d.secret }, d.activationGuide, d.allowPwChange);
}

/**
 * Deliver a whole order in ONE message (never a burst). For 1 item we keep the
 * rich single-item card; for 2..threshold we send one combined message; for
 * large orders (> threshold) we attach a .txt file with all the keys.
 */
async function deliverAll(ctx: Ctx, deliveries: DeliveredSecret[], orderNumber?: string): Promise<void> {
  if (deliveries.length === 0) return;
  if (deliveries.length === 1) { await sendDelivery(ctx, deliveries[0]!); return; }
  const lines = deliveries.map((d) => ({ productName: d.productName, variantName: d.variantName, payload: { kind: d.kind, ...d.secret }, activationGuide: d.activationGuide, allowPwChange: d.allowPwChange }));
  const menu = new InlineKeyboard().text("🏠 Menu", "mnu:home");
  if (deliveries.length > DELIVERY_FILE_THRESHOLD) {
    const txt = buildDeliveryTxt(lines, orderNumber);
    try {
      const file = new InputFile(Buffer.from(txt, "utf8"), `order-${orderNumber ?? "delivery"}.txt`);
      await ctx.replyWithDocument(file, {
        caption: `🎉 Your order is delivered! ${num(deliveries.length)} items are in the attached file.\n💾 Also saved in 🔑 My Licenses.`,
        reply_markup: menu,
      });
      return;
    } catch {
      // Fallback: if the file send fails, deliver the keys as text messages (chunked under Telegram's 4096 limit).
      const chunks: string[] = [];
      let buf = "🎉 Your order is delivered:\n";
      for (const l of lines) {
        const row = `\n${l.productName}: ${l.payload.key ?? [l.payload.username, l.payload.password].filter(Boolean).join(" / ")}`;
        if ((buf + row).length > 3800) { chunks.push(buf); buf = ""; }
        buf += row;
      }
      if (buf.trim()) chunks.push(buf);
      for (let i = 0; i < chunks.length; i++) await ctx.reply(chunks[i]!, i === chunks.length - 1 ? { reply_markup: menu } : {}).catch(() => undefined);
      return;
    }
  }
  await ctx.reply(buildCombinedDeliveryText(lines, orderNumber), { parse_mode: "HTML", reply_markup: menu }).catch(async () => {
    await ctx.reply(buildCombinedDeliveryText(lines, orderNumber).replace(/<[^>]+>/g, ""), { reply_markup: menu }).catch(() => undefined);
  });
}

async function sendRevealed(
  ctx: Ctx,
  orderItemId: string,
  productName: string,
  variantName: string,
  payload: { kind: string; key?: string; username?: string; password?: string; twofa?: string; expiresAt?: string },
  activationGuide?: string | null,
  allowPwChange?: boolean,
): Promise<void> {
  const vn = variantName.trim().toLowerCase() === "standard" ? "" : ` · ${escapeHtml(variantName)}`;
  const lines = [`📦 <b>${escapeHtml(productName)}</b>${vn}`, ""];
  let shownCreds = false;
  if (payload.key) {
    const rows = payload.key.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
    const creds = rows.map(splitCredential);
    if (rows.length > 0 && creds.every((c) => c !== null)) {
      shownCreds = true;
      rows.forEach((_, i) => {
        const c = creds[i] as { id: string; pw: string; twofa?: string };
        if (rows.length > 1) lines.push(`<b>━━ Account ${i + 1} ━━</b>`);
        lines.push(`👤 <b>ID:</b>  <code>${escapeHtml(c.id)}</code>`);
        lines.push(`🔐 <b>Password:</b>  <code>${escapeHtml(c.pw)}</code>`);
        if (c.twofa) lines.push(`🔢 <b>2FA secret:</b>  <code>${escapeHtml(c.twofa)}</code>`);
        if (rows.length > 1 && i < rows.length - 1) lines.push("");
      });
    } else if (rows.length > 1) {
      lines.push("🔑 <b>Your keys:</b>");
      for (const r of rows) lines.push(`<code>${escapeHtml(r)}</code>`);
    } else {
      lines.push(`🔑 <b>Key:</b> <code>${escapeHtml(payload.key)}</code>`);
    }
  }
  const rc = repairAccountPair(payload.username, payload.password);
  const rName = rc?.id ?? payload.username;
  const rPass = rc?.pw ?? payload.password;
  const rTwo = rc?.twofa ?? payload.twofa;
  if (rName) lines.push(`👤 <b>ID:</b>  <code>${escapeHtml(rName)}</code>`);
  if (rPass) lines.push(`🔐 <b>Password:</b>  <code>${escapeHtml(rPass)}</code>`);
  if (rTwo) {
    lines.push(`🔢 <b>2FA secret:</b>  <code>${escapeHtml(rTwo)}</code>`);
    lines.push("", '🔐 Paste the <b>2FA secret</b> at <a href="https://2fa.live">2fa.live</a> to get your 6-digit OTP.');
  }
  if (rName && rPass) {
    lines.push("", "📋 <b>Copy all credentials:</b>", `<code>${escapeHtml(rName)}|${escapeHtml(rPass)}${rTwo ? `|${escapeHtml(rTwo)}` : ""}</code>`);
  }
  if (shownCreds && payload.key) {
    const rows = payload.key.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
    if (rows.map(splitCredential).some((c) => c?.twofa)) {
      lines.push("", '🔐 Paste the <b>2FA secret</b> at <a href="https://2fa.live">2fa.live</a> to get your 6-digit OTP.');
    }
    lines.push("", "📋 <b>Copy all credentials:</b>");
    for (const r of rows) lines.push(`<code>${escapeHtml(r)}</code>`);
  }
  if (rName || shownCreds) {
    lines.push("", "ℹ️ Tap any value above to copy it.");
    lines.push(allowPwChange ? "🔓 This account is yours — you're welcome to change the password." : "🔒 Please do <b>not</b> change the account password.");
  }
  if (payload.expiresAt) lines.push(`⏳ Valid until: ${payload.expiresAt.slice(0, 10)}`);
  if (activationGuide) lines.push("", `📄 ${escapeHtml(activationGuide)}`);
  lines.push("", "💾 <b>Saved in 📦 My Orders</b> — reopen it any time.", "Problem? Open a 🎫 Support ticket.");
  const kb = new InlineKeyboard();
  if (rName) kb.copyText("📋 Copy ID", rName).row();
  if (rPass) kb.copyText("📋 Copy password", rPass).row();
  if (rTwo) kb.copyText("📋 Copy 2FA secret", rTwo).row();
  if (rName && rPass) kb.copyText("📋 Copy ALL credentials", `${rName}|${rPass}${rTwo ? `|${rTwo}` : ""}`).row();
  // Generate the OTP in the bot instead of sending them to 2fa.live.
  if (rTwo && looksLikeTotpSecret(rTwo)) kb.add(sbtn("🔢 Get my login code (OTP)", cb("otp", "get", orderItemId), "success")).row();
  kb.text("📦 View my orders", cb("ord", "list", 1)).text("🛍 Buy more", cb("shp", "home", 1)).row()
    .text("🏠 Menu", "mnu:home");
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
}
