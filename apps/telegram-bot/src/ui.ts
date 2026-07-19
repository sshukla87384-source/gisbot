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
  return [
    header(`${e("diamond")} ${bold(loadConfig().STORE_NAME)}`),
    ...(user.isVip ? [`${e("vip")} <b>VIP MEMBER</b>`] : []),
    `<b>${t(loc, "tagline")}</b>`,
    "",
    `<b>${t(loc, "wallet_orders", { bal: fmt(balanceMinor, user.currency), n: num(orderCount) })}</b>`,
    "",
    `<b>${t(loc, "hint")}</b>`,
  ].join("\n");
}

export function mainMenuKeyboard(user: BotUser): InlineKeyboard {
  const loc = user.locale;
  const kb = new InlineKeyboard()
    .add(sbtn(t(loc, "b_shopnow"), cb("shp", "home", 1), "success"))
    .row()
    .add(sbtn(t(loc, "b_orders"), cb("ord", "list", 1), "primary"), sbtn(t(loc, "b_wallet"), cb("wal", "view"), "primary"))
    .row()
    .add(sbtn(t(loc, "b_helpsupport"), cb("sup", "home"), "primary"), sbtn(t(loc, "b_referral"), cb("ref", "view"), "primary"))
    .row()
    .add(sbtn(t(loc, "b_currency", { cur: user.currency }), cb("cur", "home"), "primary"), sbtn(t(loc, "b_language"), cb("lang", "home"), "primary"))
    .row()
    .add(sbtn(t(loc, "b_developer"), cb("api", "home"), "primary"));
  if (user.roleNames.includes("RESELLER")) {
    kb.row().text(t(loc, "b_reseller"), cb("rsl", "home"));
  }
  return kb;
}

export function backToMenuRow(kb: InlineKeyboard): InlineKeyboard {
  return kb.row().text("🏠 Menu", cb("mnu", "home"));
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
