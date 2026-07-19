/**
 * Centralized emoji registry.
 * Each name has a Unicode fallback and an optional Telegram custom_emoji_id.
 * IDs are loaded from config (env CUSTOM_EMOJI_JSON = {"wallet":"5..","cart":"5.."})
 * — never hardcoded. In HTML messages, e("name") renders a premium custom emoji
 * entity when an ID exists, otherwise the Unicode fallback (works for everyone).
 */
import { loadConfig } from "@gis/config";

const FALLBACK: Record<string, string> = {
  wallet: "💰", cart: "🛒", success: "✅", error: "❌", vip: "👑", coin: "🪙",
  sparkle: "✨", loading: "⏳", fire: "🔥", gift: "🎁", box: "📦", rocket: "🚀",
  star: "⭐", diamond: "💎", chart: "📈", home: "🏠", support: "🎫", lang: "🌐",
  money: "💵", shop: "🛍", profile: "👤", referral: "👥", bolt: "⚡", clock: "🕐",
};

let idMap: Record<string, string> | null = null;
function ids(): Record<string, string> {
  if (idMap) return idMap;
  const raw = loadConfig().CUSTOM_EMOJI_JSON;
  try {
    idMap = raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    idMap = {};
  }
  return idMap;
}

/** Premium emoji: custom entity if configured, else Unicode fallback. */
export function e(name: string): string {
  const fb = FALLBACK[name] ?? "";
  const id = ids()[name];
  return id ? `<tg-emoji emoji-id="${id}">${fb}</tg-emoji>` : fb;
}

/** Raw Unicode fallback (for contexts that can't render entities, e.g. buttons). */
export function eu(name: string): string {
  return FALLBACK[name] ?? "";
}
