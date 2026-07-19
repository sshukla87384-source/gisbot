/**
 * Centralized styled-button builder using the native Bot API button style
 * property ("primary" | "success" | "danger") — added in a recent Bot API and
 * present in @grammyjs/types. Colors:
 *   primary = blue (navigation)   success = green (buy/confirm)   danger = red (destructive)
 * icon_custom_emoji_id renders a custom emoji ICON on the button when provided.
 * A config flag lets you disable styles instantly if ever needed (safe fallback).
 */
import { loadConfig } from "@gis/config";
import type { InlineKeyboardButton } from "grammy/types";

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
