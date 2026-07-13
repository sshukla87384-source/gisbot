import { isDev, loadConfig } from "@gis/config";
import {
  addToCart,
  adjustWallet,
  changeQty,
  checkoutWithWallet,
  clearCart,
  createGatewayCheckout,
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
