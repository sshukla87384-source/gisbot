import { formatMinor, cb, type CurrencyCode } from "@gis/shared";
import { loadConfig } from "@gis/config";
import { InlineKeyboard } from "grammy";
import type { BotUser } from "./ctx.js";
import { t } from "./i18n.js";
import { num, header, bold, e } from "./premium.js";
import { sbtn } from "./keyboard.js";

export const fmt = (minor: number | bigint, currency: string): string =>
  num(formatMinor(minor, currency as CurrencyCode));

export function mainMenuText(user: BotUser, balanceMinor: bigint, orderCount: number): string {
  const loc = user.locale;
  const who = user.telegramHandle
    ? `@${user.telegramHandle}`
    : (user.firstName ?? "").trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") || "there";
  return [
    header(`${e("diamond")} ${bold(loadConfig().STORE_NAME)}`),
    `👋 <b>Welcome back, ${who}!</b>`,
    ...(user.isVip ? [`${e("vip")} <b>VIP MEMBER</b>`] : []),
    `<b>${t(loc, "tagline")}</b>`,
    "",
    `💰 Wallet: <b>${fmt(balanceMinor, user.currency)}</b>   ·   📦 Orders: <b>${num(orderCount)}</b>`,
    "",
    `<b>${t(loc, "hint")}</b>`,
    `<i>Tap ❓ Help for all commands &amp; a quick guide.</i>`,
  ].join("\n");
}

export function mainMenuKeyboard(user: BotUser, cfg: Record<string, { label?: string; icon?: string } | undefined> = {}): InlineKeyboard {
  const loc = user.locale;
  const L = (key: string, fallback: string) => cfg[key]?.label || fallback;
  const I = (key: string) => cfg[key]?.icon;
  const kb = new InlineKeyboard()
    .add(sbtn(L("shop", t(loc, "b_shopnow")), cb("shp", "home", 1), "success", I("shop")))
    .row()
    .add(sbtn(L("orders", t(loc, "b_orders")), cb("ord", "list", 1), "primary", I("orders")), sbtn(L("wallet", t(loc, "b_wallet")), cb("wal", "view"), "primary", I("wallet")))
    .row()
    .add(sbtn(L("support", t(loc, "b_helpsupport")), cb("sup", "home"), "primary", I("support")), sbtn(L("referral", t(loc, "b_referral")), cb("ref", "view"), "primary", I("referral")))
    .row()
    .add(sbtn(L("currency", t(loc, "b_currency", { cur: user.currency })), cb("cur", "home"), "primary", I("currency")), sbtn(L("language", t(loc, "b_language")), cb("lang", "home"), "primary", I("language")))
    .row()
    .add(sbtn(L("developer", t(loc, "b_developer")), cb("api", "home"), "primary", I("developer")));
  if (user.roleNames.includes("RESELLER")) {
    kb.row().text(t(loc, "b_reseller"), cb("rsl", "home"));
  }
  return kb;
}

export function backToMenuRow(kb: InlineKeyboard): InlineKeyboard {
  return kb.row().text("🏠 Menu", cb("mnu", "home"));
}

/** A "◀️ Back" (one step) + "🏠 Menu" row for drill-down views. */
export function navRow(kb: InlineKeyboard, backData: string): InlineKeyboard {
  return kb.row().text("◀️ Back", backData).text("🏠 Menu", cb("mnu", "home"));
}

/** ◀️ x/y ▶️ pagination row (Bot UX doc §1). */
export function paginationRow(
  kb: InlineKeyboard,
  ns: string,
  action: string,
  page: number,
  pages: number,
  ...extraArgs: Array<string | number>
): InlineKeyboard {
  if (pages <= 1) return kb;
  kb.row();
  if (page > 1) kb.text("◀️", cb(ns, action, ...extraArgs, page - 1));
  kb.text(`${page}/${pages}`, cb("mnu", "noop"));
  if (page < pages) kb.text("▶️", cb(ns, action, ...extraArgs, page + 1));
  return kb;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const ERROR_COPY: Record<string, string> = {
  CART_EMPTY: "🛒 Your cart is empty.",
  CART_ITEM_UNAVAILABLE: "⚠️ An item in your cart is no longer available.",
  PRICE_UNAVAILABLE: "⚠️ An item has no price in your wallet currency.",
  OUT_OF_STOCK: "❌ Sorry, this just went out of stock. You have not been charged.",
  INSUFFICIENT_BALANCE: "💳 Insufficient wallet balance.",
  PRODUCT_NOT_FOUND: "This product is no longer available.",
  VARIANT_NOT_FOUND: "This option is no longer available.",
  ORDER_NOT_FOUND: "Order not found.",
  WALLET_NOT_FOUND: "Wallet not found — send /start to reinitialize.",
  VALIDATION_FAILED: "⚠️ That didn't work — please try again.",
};
