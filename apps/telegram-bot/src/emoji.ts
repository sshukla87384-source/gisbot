/**
 * Centralized emoji registry.
 * Each name has a Unicode fallback and an optional Telegram custom_emoji_id.
 * IDs are loaded from config (env CUSTOM_EMOJI_JSON = {"wallet":"5..","cart":"5.."})
 * — never hardcoded. In HTML messages, e("name") renders a premium custom emoji
 * entity when an ID exists, otherwise the Unicode fallback (works for everyone).
 */
import { loadConfig } from "@gis/config";
import { CUSTOM_EMOJI_IDS } from "./config/customEmojis.js";

const FALLBACK: Record<string, string> = {
  wallet: "💰", cart: "🛒", success: "✅", error: "❌", vip: "👑", coin: "🪙",
  sparkle: "✨", loading: "⏳", fire: "🔥", gift: "🎁", box: "📦", rocket: "🚀",
  star: "⭐", diamond: "💎", chart: "📈", home: "🏠", support: "🎫", lang: "🌐",
  money: "💵", shop: "🛍", profile: "👤", referral: "👥", bolt: "⚡", clock: "🕐",
  // Crypto terminal — add premium coin logos under these names in 🎨 Custom Emoji.
  crypto: "🌐", deposit: "📥", usdt: "💲", usdc: "🔵", bnb: "🟡", tron: "🔴", polygon: "🟣",
  ton: "💎", sol: "🟣", ltc: "⚪", btc: "🟠", eth: "🔷", pay: "💳",
};

/**
 * Which registry names a payment network may be themed with, most specific
 * first: the network code itself ("usdttrc20"), then the chain ("tron"), then
 * the asset ("usdt"). An admin who adds ONE "usdt" logo gets it on every USDT
 * network; adding "tron" as well overrides it there.
 */
const NETWORK_KEYS: Record<string, string[]> = {
  usdtbsc: ["usdtbsc", "bnb", "usdt"],
  usdttrc20: ["usdttrc20", "tron", "usdt"],
  usdtmatic: ["usdtmatic", "polygon", "usdt"],
  usdterc20: ["usdterc20", "eth", "usdt"],
  usdtarb: ["usdtarb", "arb", "usdt"],
  usdtsol: ["usdtsol", "sol", "usdt"],
  usdtton: ["usdtton", "ton", "usdt"],
  usdc: ["usdc", "eth"], usdcsol: ["usdcsol", "sol", "usdc"], usdcbsc: ["usdcbsc", "bnb", "usdc"], usdcmatic: ["usdcmatic", "polygon", "usdc"],
  ton: ["ton"], sol: ["sol"], ltc: ["ltc"], btc: ["btc"], eth: ["eth"], bnbbsc: ["bnbbsc", "bnb"], trx: ["trx", "tron"], doge: ["doge"], xrp: ["xrp"],
};

let idMap: Record<string, string> | null = null;
function ids(): Record<string, string> {
  if (idMap) return idMap;
  const fromFile = Object.fromEntries(Object.entries(CUSTOM_EMOJI_IDS).filter(([, v]) => v && v.trim() !== ""));
  let fromEnv: Record<string, string> = {};
  try {
    const raw = loadConfig().CUSTOM_EMOJI_JSON;
    if (raw) fromEnv = JSON.parse(raw) as Record<string, string>;
  } catch {
    fromEnv = {};
  }
  idMap = { ...fromFile, ...fromEnv }; // env overrides the file
  return idMap;
}

/** Admin-registered custom emoji (loaded from DB at startup, refreshed on change). */
let dynamic: Record<string, { id: string; glyph: string }> = {};
export function setDynamicEmojis(map: Record<string, { id: string; glyph: string }>): void {
  dynamic = map ?? {};
}
export function listDynamicEmojis(): Record<string, { id: string; glyph: string }> {
  return dynamic;
}

/** Premium emoji: admin-registered entity → configured entity → Unicode fallback. */
export function e(name: string): string {
  const d = dynamic[name];
  if (d) return `<tg-emoji emoji-id="${d.id}">${d.glyph}</tg-emoji>`;
  const fb = FALLBACK[name] ?? "";
  const id = ids()[name];
  return id ? `<tg-emoji emoji-id="${id}">${fb}</tg-emoji>` : fb;
}

/** The custom emoji id registered under a name, if any (for button icons). */
export function iconId(name: string): string | undefined {
  return dynamic[name]?.id ?? ids()[name];
}

/** Button icon for a payment network, by the most specific registered name. */
export function networkIconId(code: string): string | undefined {
  for (const k of NETWORK_KEYS[code] ?? [code]) {
    const id = iconId(k);
    if (id) return id;
  }
  return undefined;
}

/** Inline (tg-emoji) version of the same lookup, with the network's own glyph as fallback. */
export function networkEmoji(code: string, fallback: string): string {
  for (const k of NETWORK_KEYS[code] ?? [code]) {
    const d = dynamic[k];
    if (d) return `<tg-emoji emoji-id="${d.id}">${fallback}</tg-emoji>`;
    const id = ids()[k];
    if (id) return `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>`;
  }
  return fallback;
}

/** Raw Unicode fallback (for contexts that can't render entities, e.g. buttons). */
export function eu(name: string): string {
  return FALLBACK[name] ?? "";
}
