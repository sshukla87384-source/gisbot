import { isDev, loadConfig } from "@gis/config";
import {
  addToCart,
  adjustWallet,
  changeQty,
  checkoutWithWallet,
  greetName,
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
  getProductIdBySlug,
  getRedis,
  removeItem,
  resolveTelegramUser,
  revealDelivery,
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
} from "@gis/core";
import {
  PRODUCT_DEEPLINK_PREFIX,
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
import { t } from "./i18n.js";
import { vipAnimation, successCard, num } from "./premium.js";
import * as views from "./views.js";
import type { View } from "./views.js";

const SPAM_WINDOW_SEC = 10;
const SPAM_MAX_ACTIONS = 20;

export function createBot(): Bot<Ctx> {
  const config = loadConfig();
  const bot = new Bot<Ctx>(config.BOT_TOKEN);

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
    await next();
  });

  const render = async (ctx: Ctx, view: View, edit: boolean): Promise<void> => {
    const opts = { parse_mode: "HTML" as const, reply_markup: view.kb };
    // A photo message can't be produced by editing a text message, so image
    // cards are always sent fresh (with the text as the caption).
    if (view.photo) {
      const caption = view.text.length > 1024 ? `${view.text.slice(0, 1021)}…` : view.text;
      try {
        await ctx.replyWithPhoto(view.photo, { caption, parse_mode: "HTML", reply_markup: view.kb });
        return;
      } catch {
        // Bad/broken image URL → fall back to a plain text card.
        await ctx.reply(view.text, opts);
        return;
      }
    }
    if (edit && ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(view.text, opts);
      } catch (e) {
        // "message is not modified" is benign; anything else falls through to a fresh send.
        if (e instanceof GrammyError && e.description.includes("message is not modified")) return;
        await ctx.reply(view.text, opts);
      }
    } else {
      await ctx.reply(view.text, opts);
    }
  };

  // ── Commands ──
  bot.command("start", async (ctx) => {
    const payload = ctx.match.trim();
    if (payload.startsWith(PRODUCT_DEEPLINK_PREFIX)) {
      const productId = await getProductIdBySlug(payload.slice(PRODUCT_DEEPLINK_PREFIX.length));
      if (productId) { ctx.session.buyProductId = productId; return render(ctx, await views.productView(ctx.user, productId), false); }
    }
    // Standalone single emoji → Telegram plays a fullscreen animation for the user.
    if (config.CELEBRATION_EMOJI) await ctx.reply(config.CELEBRATION_EMOJI).catch(() => undefined);
    const welcomeText = `${t(ctx.user.locale, "welcome", { name: escapeHtml(ctx.user.firstName ?? "friend"), store: config.STORE_NAME })}\n${t(ctx.user.locale, "tagline")}`;
    const emojiPrefix = config.CUSTOM_EMOJI_ID ? `<tg-emoji emoji-id="${config.CUSTOM_EMOJI_ID}">✨</tg-emoji> ` : "";
    try {
      await ctx.reply(`${emojiPrefix}${welcomeText}`, { parse_mode: "HTML" });
    } catch {
      // Telegram rejects custom emoji the bot doesn't own — fall back to plain text.
      await ctx.reply(welcomeText, { parse_mode: "HTML" });
    }
    // First-time users: let them pick their preferred currency (defaults to USD).
    if (ctx.session.isNewUser) {
      ctx.session.isNewUser = false;
      return render(ctx, views.currencyView(ctx.user), false);
    }
    return render(ctx, await views.menuView(ctx.user), false);
  });
  bot.command("menu", async (ctx) => render(ctx, await views.menuView(ctx.user), false));
  bot.command("shop", async (ctx) => render(ctx, await views.shopHomeView(ctx.user, 1), false));
  bot.command("cart", async (ctx) => render(ctx, await views.cartViewKb(ctx.user), false));
  bot.command("orders", async (ctx) => render(ctx, await views.ordersView(ctx.user, 1), false));
  bot.command("wallet", async (ctx) => render(ctx, await views.walletView(ctx.user), false));
  bot.command("support", async (ctx) => render(ctx, await views.supportHomeView(ctx.user), false));
  bot.command("help", async (ctx) => render(ctx, views.helpView(), false));
  bot.command("admin", async (ctx) => adminCommand(ctx));

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
  bot.on("message:photo", async (ctx) => {
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
    if (awaiting && awaiting.startsWith("admin_")) {
      const handled = await handleAdminText(ctx, awaiting);
      if (handled) return;
    }
    if (awaiting === "binance_txnid") {
      const orderId = ctx.session.binanceOrderId ?? "";
      const txn = ctx.message.text.trim().slice(0, 128);
      const r = await verifyBinanceByTxnId(orderId, txn, ctx.user.id);
      if (r.ok) {
        ctx.session.binanceOrderId = undefined;
        return ctx.reply("✅ Payment verified! Your order has been delivered. Check 📦 My Orders.");
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
      return ctx.reply(
        `${note}We’ve logged your Transaction ID and our team will verify and deliver shortly. You’ll get a message here once it’s confirmed.`,
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
      ctx.session.upiOrderId = undefined;
      const ref = ctx.message.text.trim().slice(0, 64);
      const notified = await notifyAdminsForApproval(ctx, orderId, "UPI", ref);
      if (notified === 0) await createTicket(ctx.user.id, "PAYMENT_ISSUE", `UPI payment for order ${orderId}, UTR: ${ref}.`).catch(() => undefined);
      return ctx.reply("✅ Thanks! We've received your UPI reference. Your order will be delivered right after we verify — usually within minutes.");
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
    if (awaiting === "ticket") {
      const ticket = await createTicket(ctx.user.id, "OTHER", ctx.message.text.trim().slice(0, 2000));
      return ctx.reply(`🎫 Ticket <b>#${ticket.ticketNumber}</b> created. Support will reply here.`, {
        parse_mode: "HTML",
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

        case "ord:paywallet": {
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
              `🕐 ${result.pendingManualItems} item(s) are being prepared by our team (~12 h). You'll be notified here.`,
            );
          }
          await render(ctx, await views.menuView(user), false);
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
          const bz = await createBinanceManualCheckout(user.id);
          ctx.session.binanceOrderId = bz.orderId;
          await ctx.editMessageText(
            [
              `🟡 <b>Pay via Binance</b> — Order <b>${bz.orderNumber}</b>`,
              "",
              `Order value: <b>${fmt(bz.totalMinor, bz.currency)}</b>`,
              `Send exactly: <b>${bz.binanceAmount} ${bz.binanceAsset}</b>`,
              `To Binance UID: <code>${bz.binanceUid}</code>`,
              "",
              "After sending, tap the button below and paste your Binance <b>Order ID</b> (from the payment receipt) — we verify it and deliver instantly.",
            ].join("\n"),
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard()
                .text("✅ I’ve paid — enter Order ID", "ord:binancetxn")
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
          if (user.currency !== "INR") { await setUserCurrency(user.id, "INR"); user.currency = "INR"; }
          const up = await createUpiManualCheckout(user.id);
          ctx.session.upiOrderId = up.orderId;
          // Build a UPI deep link for the EXACT amount and render it as a QR.
          const amountRupees = (up.totalMinor / 100).toFixed(2);
          const payee = up.payeeName || config.STORE_NAME;
          const upiUri =
            `upi://pay?pa=${encodeURIComponent(up.upiId)}&pn=${encodeURIComponent(payee)}` +
            `&am=${amountRupees}&cu=INR&tn=${encodeURIComponent(up.orderNumber)}`;
          const caption = [
            `🇮🇳 <b>Pay via UPI</b> — Order <b>${up.orderNumber}</b>`,
            "",
            `Amount: <b>${fmt(up.totalMinor, up.currency)}</b>`,
            `UPI ID: <code>${up.upiId}</code> (${escapeHtml(payee)})`,
            "",
            "📷 Scan this QR in any UPI app (GPay/PhonePe/Paytm) — the amount is pre-filled.",
            "After paying, tap “I've paid” and paste your UTR number.",
          ].join("\n");
          try {
            const png = await QRCode.toBuffer(upiUri, { width: 512, margin: 2, color: { dark: "#000000", light: "#FFFFFF" } });
            await ctx.replyWithPhoto(new InputFile(png, "upi-qr.png"), {
              caption,
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard().text("✅ I've paid — enter UTR", "ord:upipaid").row().text("🏠 Menu", "mnu:home"),
            });
          } catch {
            await ctx.reply(caption, {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard().text("✅ I've paid — enter UTR", "ord:upipaid").row().text("🏠 Menu", "mnu:home"),
            });
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
        case "lic:view": {
          const revealed = await revealDelivery(user.id, args[0] ?? "");
          await sendRevealed(ctx, revealed.productName, revealed.variantName, revealed.payload);
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
            { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("✅ I have deposited — enter Order ID", "wal:freetxn").row().text("🏠 Menu", "mnu:home") },
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
        case "api:docs":
          await render(ctx, views.apiDocsView(), true);
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

        case "prf:view":
          await render(ctx, views.profileView(user), true);
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
    }
  });

  bot.catch((err) => {
    // Structured error logging; secrets never enter error paths.
    // eslint-disable-next-line no-console
    console.error("bot error", { update_id: err.ctx.update.update_id, error: String(err.error) });
  });

  return bot;
}

async function sendDelivery(ctx: Ctx, d: DeliveredSecret): Promise<void> {
  await sendRevealed(ctx, d.productName, d.variantName, { kind: d.kind, ...d.secret }, d.activationGuide);
}

/**
 * Deliver a whole order in ONE message (never a burst). For 1 item we keep the
 * rich single-item card; for 2..threshold we send one combined message; for
 * large orders (> threshold) we attach a .txt file with all the keys.
 */
async function deliverAll(ctx: Ctx, deliveries: DeliveredSecret[], orderNumber?: string): Promise<void> {
  if (deliveries.length === 0) return;
  if (deliveries.length === 1) { await sendDelivery(ctx, deliveries[0]!); return; }
  const lines = deliveries.map((d) => ({ productName: d.productName, variantName: d.variantName, payload: { kind: d.kind, ...d.secret }, activationGuide: d.activationGuide }));
  const menu = new InlineKeyboard().text("🏠 Menu", "mnu:home");
  if (deliveries.length > DELIVERY_FILE_THRESHOLD) {
    const txt = buildDeliveryTxt(lines, orderNumber);
    const file = new InputFile(Buffer.from(txt, "utf8"), `order-${orderNumber ?? "delivery"}.txt`);
    await ctx.replyWithDocument(file, {
      caption: `🎉 Your order is delivered! ${num(deliveries.length)} items are in the attached file.\n💾 Also saved in 🔑 My Licenses.`,
      parse_mode: "HTML",
      reply_markup: menu,
    });
    return;
  }
  await ctx.reply(buildCombinedDeliveryText(lines, orderNumber), { parse_mode: "HTML", reply_markup: menu });
}

async function sendRevealed(
  ctx: Ctx,
  productName: string,
  variantName: string,
  payload: { kind: string; key?: string; username?: string; password?: string; expiresAt?: string },
  activationGuide?: string | null,
): Promise<void> {
  const vn = variantName.trim().toLowerCase() === "standard" ? "" : ` · ${escapeHtml(variantName)}`;
  const lines = [`📦 <b>${escapeHtml(productName)}</b>${vn}`, ""];
  if (payload.key) lines.push(`🔑 <code>${escapeHtml(payload.key)}</code>`);
  if (payload.username) lines.push(`👤 Login: <code>${escapeHtml(payload.username)}</code>`);
  if (payload.password) lines.push(`🔒 Password: <tg-spoiler>${escapeHtml(payload.password)}</tg-spoiler>`);
  if (payload.username) lines.push("", "⚠️ Please do not change the account password.");
  if (payload.expiresAt) lines.push(`⏳ Valid until: ${payload.expiresAt.slice(0, 10)}`);
  if (activationGuide) lines.push("", `📄 ${escapeHtml(activationGuide)}`);
  lines.push("", "Saved in 🔑 My Licenses. Problem? Open a 🎫 Support ticket.");
  const kb = new InlineKeyboard().text("🏠 Menu", "mnu:home");
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
}
