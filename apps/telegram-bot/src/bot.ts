import { isDev, loadConfig } from "@gis/config";
import {
  addToCart,
  adjustWallet,
  changeQty,
  checkoutWithWallet,
  clearCart,
  createGatewayCheckout,
  createBinanceManualCheckout,
  verifyBinanceByTxnId,
  createWalletTopup,
  verifyTopupByTxn,
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
  previewCoupon,
  getWallet,
  registerPostTarget,
  removePostTargetByChat,
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
    const { user } = await resolveTelegramUser({
      telegramId: BigInt(ctx.from.id),
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name,
      username: ctx.from.username,
      locale: ctx.from.language_code,
      startPayload: payload,
    });
    ctx.user = user;
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
      if (productId) return render(ctx, await views.productView(ctx.user, productId), false);
    }
    await ctx.reply(
      `${t(ctx.user.locale, "welcome", { name: escapeHtml(ctx.user.firstName ?? "friend") })}\n${t(ctx.user.locale, "tagline")}`,
      { parse_mode: "HTML" },
    );
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
    if (awaiting === "upi_ref") {
      const orderId = ctx.session.upiOrderId ?? "";
      ctx.session.upiOrderId = undefined;
      const ref = ctx.message.text.trim().slice(0, 64);
      const notified = await notifyAdminsForApproval(ctx, orderId, "UPI", ref);
      if (notified === 0) await createTicket(ctx.user.id, "PAYMENT_ISSUE", `UPI payment for order ${orderId}, UTR: ${ref}.`).catch(() => undefined);
      return ctx.reply("✅ Thanks! We've received your UPI reference. Your order will be delivered right after we verify — usually within minutes.");
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
      const created = await createApiKey({ name, scopes: ["catalog:read"], ownerUserId: ctx.user.id });
      const base = (loadConfig().PUBLIC_API_URL ?? "").replace(/\/$/, "") + "/api/v1/developer";
      return ctx.reply(
        [
          "✅ <b>API key created</b> — copy it now, it won’t be shown again:",
          "",
          `<code>${created.apiKey}</code>`,
          "",
          `Scope: catalog:read`,
          `Base URL: <code>${base}</code>`,
          `Docs: ${base}/docs`,
          `Send it as the <code>X-API-Key</code> header.`,
        ].join("\n"),
        { parse_mode: "HTML" },
      );
    }
    if (awaiting === "coupon_code") {
      const code = ctx.message.text.trim().slice(0, 40);
      try {
        const pv = await previewCoupon(ctx.user.id, code);
        ctx.session.couponCode = pv.code;
        await ctx.reply(`✅ Coupon <b>${pv.code}</b> applied — you save ${fmt(pv.discountMinor, pv.currency)}.`, { parse_mode: "HTML" });
      } catch (e) {
        ctx.session.couponCode = undefined;
        await ctx.reply(`❌ ${e instanceof Error ? e.message : "That coupon can't be applied."}`);
      }
      return render(ctx, await views.checkoutSummaryView(ctx.user, ctx.session.couponCode), false);
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
          await render(ctx, await views.productView(user, args[0] ?? ""), true);
          break;
        case "shp:desc":
          await render(ctx, await views.productDescriptionView(user, args[0] ?? ""), true);
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
        case "crt:buynow":
          await addToCart(user.id, args[0] ?? "");
          ctx.session.couponCode = undefined;
          await ctx.answerCallbackQuery({ text: "⚡✨ Boom! Locking in your order…" });
          await render(ctx, await views.checkoutSummaryView(user), true);
          break;
        case "crt:qty":
          await render(ctx, await views.quantitySelectView(user, args[0] ?? "", intArg(args, 1, 1)), true);
          break;
        case "crt:buyqty": {
          const variantId = args[0] ?? "";
          const qty = Math.max(1, intArg(args, 1, 1));
          // Buy-now with quantity: replace any stale cart with just this line, then checkout.
          await clearCart(user.id);
          await addToCart(user.id, variantId, qty);
          ctx.session.couponCode = undefined;
          await ctx.answerCallbackQuery({ text: "⚡✨ Boom! Locking in your order…" });
          await render(ctx, await views.checkoutSummaryView(user), true);
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
          await render(ctx, await views.checkoutSummaryView(user, ctx.session.couponCode), true);
          break;

        case "ord:coupon": {
          await ctx.answerCallbackQuery();
          ctx.session.awaiting = "coupon_code";
          await ctx.reply("🏷 Send your <b>coupon code</b>:", { parse_mode: "HTML" });
          break;
        }
        case "ord:couponclear": {
          ctx.session.couponCode = undefined;
          await ctx.answerCallbackQuery({ text: "Coupon removed" });
          await render(ctx, await views.checkoutSummaryView(user, undefined), true);
          break;
        }

        case "ord:paywallet": {
          await ctx.answerCallbackQuery({ text: "⏳ Processing…" });
          const result = await checkoutWithWallet(user.id, ctx.session.couponCode);
          ctx.session.couponCode = undefined;
          await ctx.editMessageText(
            `✅ Payment received! Order <b>${result.orderNumber}</b> — ${fmt(result.totalMinor, result.currency)}.`,
            { parse_mode: "HTML" },
          );
          await sendDeliveryBatch(ctx, result.deliveries);
          if (result.pendingManualItems > 0) {
            await ctx.reply(
              `🕐 ${result.pendingManualItems} item(s) are being prepared by our team (~12 h). You'll be notified here.`,
            );
          }
          await render(ctx, await views.menuView(user), false);
          break;
        }
        case "ord:paylater": {
          await ctx.answerCallbackQuery({ text: "🕒 Placing your order on credit…" });
          const result = await checkoutWithWallet(user.id, ctx.session.couponCode, { useCredit: true });
          ctx.session.couponCode = undefined;
          const owed = await getWallet(user.id);
          await ctx.editMessageText(
            `✅ Order <b>${result.orderNumber}</b> placed on <b>Pay Later</b>.\n${owed.balanceMinor < 0n ? `You owe <b>${fmt(-owed.balanceMinor, owed.currency)}</b> — top up your 💳 Wallet anytime to clear it.` : ""}`,
            { parse_mode: "HTML" },
          );
          await sendDeliveryBatch(ctx, result.deliveries);
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
          const gw = await createGatewayCheckout(user.id, args[0] ?? "", ctx.session.couponCode);
          ctx.session.couponCode = undefined;
          const payKb = new InlineKeyboard()
            .url(`🔗 Pay ${fmt(gw.totalMinor, gw.currency)}`, gw.url)
            .row()
            .text("🏠 Menu", "mnu:home");
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
        case "ord:paybinance": {
          await ctx.answerCallbackQuery({ text: "⏳ Creating order…" });
          if (user.currency !== "USD") { await setUserCurrency(user.id, "USD"); user.currency = "USD"; }
          const bz = await createBinanceManualCheckout(user.id, ctx.session.couponCode);
          ctx.session.couponCode = undefined;
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
          const up = await createUpiManualCheckout(user.id, ctx.session.couponCode);
          ctx.session.couponCode = undefined;
          ctx.session.upiOrderId = up.orderId;
          // Build a UPI deep link for the EXACT amount and render it as a QR.
          const amountRupees = (up.totalMinor / 100).toFixed(2);
          const payee = up.payeeName || "Get It Sasta";
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
          const oid = args[0] ?? "";
          const revealed = await revealDelivery(user.id, oid);
          await sendRevealed(ctx, revealed.productName, revealed.variantName, revealed.payload, undefined, oid);
          break;
        }
        case "lic:replace": {
          await ctx.answerCallbackQuery({ text: "Opening a replacement request…" });
          const ticket = await createTicket(
            user.id,
            "DELIVERY_ISSUE",
            `🔁 Replacement requested for delivered item ${args[0] ?? ""}. Customer reports it isn't working.`,
          );
          await ctx.reply(
            `🔁 <b>Replacement requested</b> — ticket <b>#${ticket.ticketNumber}</b>.\nOur team will review and reply here shortly. Sorry for the trouble!`,
            { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🧾 My Orders", "lic:list:1").text("🏠 Menu", "mnu:home") },
          );
          break;
        }

        case "wal:view":
          await render(ctx, await views.walletView(user), true);
          break;
        case "wal:hist":
          await render(ctx, await views.walletHistoryView(user, intArg(args, 0, 1)), true);
          break;
        case "wal:topup":
          await ctx.answerCallbackQuery();
          ctx.session.awaiting = "wallet_topup_amount";
          await ctx.reply(`💳 How much do you want to add? Send an amount in ${user.currency} (e.g. <code>500</code>):`, { parse_mode: "HTML" });
          break;
        case "wal:topuptxn":
          await ctx.answerCallbackQuery();
          if (!ctx.session.walletTopupId) { await ctx.reply("This top-up expired. Tap ➕ Top up again."); break; }
          ctx.session.awaiting = "wallet_topup_txn";
          await ctx.reply("🔎 Paste your Binance <b>Order ID</b> to confirm the top-up:", { parse_mode: "HTML" });
          break;
        case "api:home":
          await render(ctx, await views.apiKeysView(user), true);
          break;
        case "api:new":
          await ctx.answerCallbackQuery();
          ctx.session.awaiting = "api_key_name";
          await ctx.reply("🧑‍💻 Send a <b>name</b> for your API key (e.g. <code>my app</code>):", { parse_mode: "HTML" });
          break;
        case "api:revoke": {
          const done = await revokeApiKeyOwned(args[0] ?? "", user.id);
          await ctx.answerCallbackQuery({ text: done ? "Revoked" : "Not found" });
          await render(ctx, await views.apiKeysView(user), true);
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

const STORE_NAME = "THE CRAZY STORE";
const MAX_PER_MESSAGE = 15;

/** Render up to MAX_PER_MESSAGE delivered items into ONE message with a thank-you + T&C footer. */
function renderDeliveryChunk(items: DeliveredSecret[]): string {
  const lines: string[] = ["🎉🎊 <b>Your order is delivered!</b> 🥳", ""];
  const many = items.length > 1;
  items.forEach((d, idx) => {
    const head = many ? `<b>${idx + 1}.</b> ` : "";
    const variant = d.variantName && d.variantName.toLowerCase() !== "standard" ? ` · ${escapeHtml(d.variantName)}` : "";
    lines.push(`${head}📦 <b>${escapeHtml(d.productName)}</b>${variant}`);
    if (d.secret.key) lines.push(`🔑 <code>${escapeHtml(d.secret.key)}</code>`);
    if (d.secret.username) lines.push(`👤 <code>${escapeHtml(d.secret.username)}</code>`);
    if (d.secret.password) lines.push(`🔒 <tg-spoiler>${escapeHtml(d.secret.password)}</tg-spoiler>`);
    if (d.secret.expiresAt) lines.push(`⏳ Valid until: ${d.secret.expiresAt.slice(0, 10)}`);
    if (d.activationGuide) lines.push(`📄 ${escapeHtml(d.activationGuide)}`);
    lines.push("");
  });
  lines.push(
    "━━━━━━━━━━━━━━",
    `🛍 <b>Thank you for purchasing from ${STORE_NAME}!</b> 💛`,
    "We truly appreciate your order. Everything above is saved in 🧾 My Orders.",
    "",
    "📌 <b>Terms &amp; Conditions:</b> Digital items are non-refundable once delivered. Please don't change any account passwords. If something doesn't work, use 🔁 Request replacement in My Orders or open a 🎫 Support ticket and we'll make it right.",
  );
  return lines.join("\n");
}

/** Plain-text version of a delivery (for the downloadable .txt when there are many items). */
function renderDeliveryPlainText(items: DeliveredSecret[]): string {
  const lines: string[] = [`THE CRAZY STORE — Your order (${items.length} items)`, ""];
  items.forEach((d, idx) => {
    const variant = d.variantName && d.variantName.toLowerCase() !== "standard" ? ` - ${d.variantName}` : "";
    lines.push(`${idx + 1}. ${d.productName}${variant}`);
    if (d.secret.key) lines.push(`   Key: ${d.secret.key}`);
    if (d.secret.username) lines.push(`   Login: ${d.secret.username}`);
    if (d.secret.password) lines.push(`   Password: ${d.secret.password}`);
    if (d.secret.expiresAt) lines.push(`   Valid until: ${d.secret.expiresAt.slice(0, 10)}`);
    if (d.activationGuide) lines.push(`   Note: ${d.activationGuide}`);
    lines.push("");
  });
  lines.push(
    "==============================",
    `Thank you for purchasing from ${STORE_NAME}!`,
    "Your items are also saved in My Orders inside the bot.",
    "",
    "Terms & Conditions: Digital items are non-refundable once delivered.",
    "Please don't change any account passwords. Not working? Use 'Request replacement' in My Orders or open a Support ticket.",
  );
  return lines.join("\n");
}

/**
 * Deliver all items. Up to 15 → one formatted chat message; more than 15 → a
 * single downloadable .txt file so nothing is lost in a wall of messages.
 */
async function sendDeliveryBatch(ctx: Ctx, deliveries: DeliveredSecret[]): Promise<void> {
  if (deliveries.length === 0) return;
  const menuKb = new InlineKeyboard().text("🧾 My Orders", "lic:list:1").text("🏠 Menu", "mnu:home");

  if (deliveries.length <= MAX_PER_MESSAGE) {
    await ctx.reply(renderDeliveryChunk(deliveries), { parse_mode: "HTML", reply_markup: menuKb });
    return;
  }

  const file = new InputFile(Buffer.from(renderDeliveryPlainText(deliveries), "utf8"), `the-crazy-store-order-${Date.now()}.txt`);
  await ctx.replyWithDocument(file, {
    caption: [
      `🎉🎊 <b>Your order is delivered!</b> 🥳`,
      `📦 <b>${deliveries.length} items</b> are in the file above — tap to download &amp; save them.`,
      "",
      `🛍 <b>Thank you for purchasing from ${STORE_NAME}!</b> 💛 Also saved in 🧾 My Orders.`,
    ].join("\n"),
    parse_mode: "HTML",
    reply_markup: menuKb,
  });
}

async function sendDelivery(ctx: Ctx, d: DeliveredSecret): Promise<void> {
  await sendRevealed(ctx, d.productName, d.variantName, { kind: d.kind, ...d.secret }, d.activationGuide);
}

async function sendRevealed(
  ctx: Ctx,
  productName: string,
  variantName: string,
  payload: { kind: string; key?: string; username?: string; password?: string; expiresAt?: string },
  activationGuide?: string | null,
  orderItemId?: string,
): Promise<void> {
  const lines = [`📦 <b>${escapeHtml(productName)}</b> · ${escapeHtml(variantName)}`, ""];
  if (payload.key) lines.push(`🔑 <code>${escapeHtml(payload.key)}</code>`);
  if (payload.username) lines.push(`👤 Login: <code>${escapeHtml(payload.username)}</code>`);
  if (payload.password) lines.push(`🔒 Password: <tg-spoiler>${escapeHtml(payload.password)}</tg-spoiler>`);
  if (payload.username) lines.push("", "⚠️ Please do not change the account password.");
  if (payload.expiresAt) lines.push(`⏳ Valid until: ${payload.expiresAt.slice(0, 10)}`);
  if (activationGuide) lines.push("", `📄 ${escapeHtml(activationGuide)}`);
  lines.push("", "Saved in 🧾 My Orders. Not working? Tap 🔁 Request replacement below.");
  const kb = new InlineKeyboard();
  if (orderItemId) kb.text("🔁 Request replacement", cb("lic", "replace", orderItemId)).row();
  kb.text("🏠 Menu", "mnu:home");
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
}
