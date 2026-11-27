/**
 * Centralized styled-button builder using the native Bot API button style
 * property ("primary" | "success" | "danger") — added in a recent Bot API and
 * present in @grammyjs/types. Colors:
 *   primary = blue (navigation)   success = green (buy/confirm)   danger = red (destructive)
 * icon_custom_emoji_id renders a custom emoji ICON on the button when provided.
 * A config flag lets you disable styles instantly if ever needed (safe fallback).
 */
import { loadConfig } from "@gis/config";
import type { InlineKeyboardButton, KeyboardButton, ReplyKeyboardMarkup } from "grammy/types";

export type BtnStyle = "primary" | "success" | "danger";

/** A styled callback button. Style/icon are dropped if the feature is disabled. */
export function sbtn(text: string, data: string, style?: BtnStyle, iconCustomEmojiId?: string): InlineKeyboardButton {
  const btn: InlineKeyboardButton.CallbackButton = { text, callback_data: data };
  if (loadConfig().BUTTON_STYLES_ENABLED) {
    if (style) (btn as InlineKeyboardButton & { style?: BtnStyle }).style = style;
    if (iconCustomEmojiId) (btn as InlineKeyboardButton & { icon_custom_emoji_id?: string }).icon_custom_emoji_id = iconCustomEmojiId;
  }
  return btn;
}

/**
 * The always-visible quick bar under the message box: six buttons, like other
 * shop bots — Shop · Wallet · Orders / Account · Support · Home. Each label is
 * matched by QUICK_BAR_RE in bot.ts, so keep the words in step.
 */
export const QUICK_BAR_VERSION = 1;
export function quickBarKeyboard(): ReplyKeyboardMarkup {
  const styled = loadConfig().BUTTON_STYLES_ENABLED;
  const b = (text: string, style?: BtnStyle): KeyboardButton => {
    const k: KeyboardButton.CommonButton = { text };
    if (styled && style) (k as KeyboardButton.CommonButton & { style?: BtnStyle }).style = style;
    return k;
  };
  return {
    keyboard: [
      [b("🛍 Shop", "success"), b("💰 Wallet", "primary"), b("📦 Orders", "primary")],
      [b("👤 Account", "primary"), b("💬 Support", "primary"), b("🏠 Home")],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Pick an option or type…",
  };
}

/** A tap on a quick-bar button: the word, whatever emoji / case surrounds it. */
export const QUICK_BAR_RE = /^[^\p{L}\p{N}]*(shop|wallet|orders|account|support|home)[^\p{L}\p{N}]*$/iu;
