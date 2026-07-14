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
  type DeliveredSecret,
} from "@gis/core";
import {
  PRODUCT_DEEPLINK_PREFIX,
  intArg,
  isCoreError,
  parseCb,
} from "@gis/shared";
import { Bot, GrammyError, InlineKeyboard, session } from "grammy";
import type { Ctx } from "./ctx.js";
import { redisSessionStorage } from "./session.js";
import { adminCommand, handleAdminCallback, handleAdminText } from "./admin.js";
import { ERROR_COPY, escapeHtml, fmt } from "./ui.js";
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
      `👋 Welcome to <b>Get It Sasta</b>, ${escapeHtml(ctx.user.firstName ?? "friend")}!\nDigital products, instant delivery, best prices.`,
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
      const r = await verifyBinanceByTxnId(orderId, txn);
      if (r.ok) {
        ctx.session.binanceOrderId = undefined;
        return ctx.reply("✅ Payment verified! Your order has been delivered. Check 📦 My Orders.");
      }
      // Not auto-verified → keep it simple for the buyer, hand to support with the ID.
      await createTicket(
        ctx.user.id,
        "PAYMENT_ISSUE",
        `Binance payment — order ${orderId}, transaction ID: ${txn} (auto-verify: ${r.ok ? "ok" : r.reason}).`,
      ).catch(() => undefined);
      const note =
        r.reason === "AMOUNT_MISMATCH"
          ? "⚠️ That transaction’s amount doesn’t match your order. "
          : r.reason === "ALREADY_USED"
            ? "⚠️ That transaction was already used. "
            : "";
      return ctx.reply(
        `${note}We’ve logged your Transaction ID and our team will verify and deliver shortly. You’ll get a message here once it’s confirmed.`,
      );
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
            "After sending, tap the button and paste your Transaction ID — your wallet is credited automatically.",
          ].join("\n"),
          { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("✅ I’ve paid — enter Transaction ID", "wal:topuptxn").row().text("🏠 Menu", "mnu:home") },
        );
      } catch (e) {
        return ctx.reply(isCoreError(e) ? (ERROR_COPY[e.code] ?? "Top-up unavailable right now.") : "Top-up unavailable right now.");
      }
    }
    if (awaiting === "wallet_topup_txn") {
      const topupId = ctx.session.walletTopupId ?? "";
      const txn = ctx.message.text.trim().slice(0, 128);
      const r = await verifyTopupByTxn(topupId, txn);
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
    return render(ctx, await views.menuView(ctx.user), false);
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
          await ctx.answerCallbackQuery({ text: "⚡ Taking you to checkout…" });
          await render(ctx, await views.checkoutSummaryView(user), true);
          break;
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
          const result = await checkoutWithWallet(user.id);
          await ctx.editMessageText(
            `✅ Payment received! Order <b>${result.orderNumber}</b> — ${fmt(result.totalMinor, result.currency)}.`,
            { parse_mode: "HTML" },
          );
          for (const d of result.deliveries) await sendDelivery(ctx, d);
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
        case "ord:paybinance": {
          await ctx.answerCallbackQuery({ text: "⏳ Creating order…" });
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
              "After sending, tap the button below and paste your Binance <b>Transaction ID</b> — we verify it and deliver instantly.",
            ].join("\n"),
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard()
                .text("✅ I’ve paid — enter Transaction ID", "ord:binancetxn")
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
            "🔎 Paste your Binance <b>Transaction ID</b> (open the payment in Binance → it’s the long ID on the receipt):",
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
        case "wal:topup":
          await ctx.answerCallbackQuery();
          ctx.session.awaiting = "wallet_topup_amount";
          await ctx.reply(`💳 How much do you want to add? Send an amount in ${user.currency} (e.g. <code>500</code>):`, { parse_mode: "HTML" });
          break;
        case "wal:topuptxn":
          await ctx.answerCallbackQuery();
          if (!ctx.session.walletTopupId) { await ctx.reply("This top-up expired. Tap ➕ Top up again."); break; }
          ctx.session.awaiting = "wallet_topup_txn";
          await ctx.reply("🔎 Paste your Binance <b>Transaction ID</b> to confirm the top-up:", { parse_mode: "HTML" });
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

async function sendDelivery(ctx: Ctx, d: DeliveredSecret): Promise<void> {
  await sendRevealed(ctx, d.productName, d.variantName, { kind: d.kind, ...d.secret }, d.activationGuide);
}

async function sendRevealed(
  ctx: Ctx,
  productName: string,
  variantName: string,
  payload: { kind: string; key?: string; username?: string; password?: string; expiresAt?: string },
  activationGuide?: string | null,
): Promise<void> {
  const lines = [`📦 <b>${escapeHtml(productName)}</b> · ${escapeHtml(variantName)}`, ""];
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
