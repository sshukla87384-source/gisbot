import { prisma } from "@gis/database";
import { getCustomEmojiRegistry } from "./admin.service.js";

/**
 * Premium emoji everywhere, without rewriting every screen.
 *
 * The shop owns a set of premium (custom) emoji: the ones registered in
 * 🎨 Custom Emoji, plus — unless switched off — the ones already used in its
 * own product names and descriptions (an admin who pasted a description with a
 * premium ✔️ has, in effect, chosen that ✔️). Every outgoing HTML message is
 * passed through `premiumizeHtml`, which swaps each plain emoji for its premium
 * version, and inline-keyboard buttons that start with such an emoji get it as
 * their icon. Applied in one place (the Bot API transformer in the bot and the
 * worker), so every page — shop, wallet, orders, broadcasts, deliveries — gets
 * it with no per-screen work. Telegram rejecting a premium emoji (bot owner
 * without Premium, a pack it cannot use) falls back to the untouched message.
 */

export interface AutoEmojiConfig {
  /** Swap plain emoji for premium ones across the bot. */
  enabled: boolean;
  /** Also use premium emoji found in product names/descriptions. */
  learn: boolean;
}

const CFG_KEY = "emoji.auto";

export async function getAutoEmojiConfig(): Promise<AutoEmojiConfig> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: CFG_KEY } });
    const v = row?.value as Partial<AutoEmojiConfig> | null | undefined;
    return { enabled: v?.enabled !== false, learn: v?.learn !== false };
  } catch {
    return { enabled: true, learn: true };
  }
}

export async function setAutoEmojiConfig(patch: Partial<AutoEmojiConfig>): Promise<AutoEmojiConfig> {
  const cur = await getAutoEmojiConfig();
  const next = { ...cur, ...patch };
  const value = { enabled: next.enabled, learn: next.learn };
  await prisma.setting.upsert({ where: { key: CFG_KEY }, create: { key: CFG_KEY, value }, update: { value } });
  cache = null;
  return next;
}

/** Glyph key: the emoji without variation selectors, so ✔ and ✔️ match. */
export const emojiKey = (glyph: string): string => glyph.replace(/️/g, "");

const TAG_RE = /<tg-emoji\s+emoji-id="(\d{5,25})"\s*>([\s\S]*?)<\/tg-emoji>/gi;

let cache: { at: number; cfg: AutoEmojiConfig; map: Map<string, string> } | null = null;

/**
 * glyph → custom emoji id. Registered entries win over learned ones. Cached
 * two minutes: it is consulted on every outgoing message.
 */
export async function premiumGlyphMap(): Promise<{ cfg: AutoEmojiConfig; map: Map<string, string> }> {
  if (cache && Date.now() - cache.at < 120_000) return { cfg: cache.cfg, map: cache.map };
  const cfg = await getAutoEmojiConfig();
  const map = new Map<string, string>();
  if (cfg.enabled) {
    if (cfg.learn) {
      try {
        const rows = await prisma.product.findMany({
          where: {
            deletedAt: null,
            OR: [{ nameHtml: { contains: "tg-emoji" } }, { descriptionHtml: { contains: "tg-emoji" } }, { description: { contains: "tg-emoji" } }],
          },
          select: { nameHtml: true, descriptionHtml: true, description: true },
          orderBy: { updatedAt: "desc" },
          take: 400,
        });
        for (const r of rows) {
          for (const src of [r.nameHtml, r.descriptionHtml, r.description]) {
            if (!src) continue;
            for (const m of src.matchAll(TAG_RE)) {
              const glyph = (m[2] ?? "").replace(/<[^>]*>/g, "").trim();
              const key = emojiKey(glyph);
              // Only a single emoji is a safe stand-in; text inside a tag is not.
              if (!key || !isSingleEmoji(key) || map.has(key)) continue;
              map.set(key, m[1]!);
            }
          }
        }
      } catch { /* learning is best-effort */ }
    }
    try {
      const reg = await getCustomEmojiRegistry();
      for (const entry of Object.values(reg)) {
        const key = emojiKey(entry.glyph ?? "");
        if (key && entry.id && isSingleEmoji(key)) map.set(key, entry.id);
      }
    } catch { /* registry unavailable — learned only */ }
  }
  cache = { at: Date.now(), cfg, map };
  return { cfg, map };
}

/** Drop the cache after the registry or the switches change. */
export function invalidatePremiumGlyphMap(): void {
  cache = null;
}

const EMOJI_SEQ = /(?:[\u{1F1E6}-\u{1F1FF}]{2}|[0-9#*]️?⃣|\p{Extended_Pictographic}️?(?:[\u{1F3FB}-\u{1F3FF}])?(?:‍\p{Extended_Pictographic}️?(?:[\u{1F3FB}-\u{1F3FF}])?)*)/gu;

function isSingleEmoji(s: string): boolean {
  const m = s.match(EMOJI_SEQ);
  return !!m && m.length === 1 && m[0].replace(/️/g, "") === s;
}

/** The emoji the bot's own buttons and screens use most — the coverage report in 🎨 Custom Emoji. */
export const BOT_UI_GLYPHS = [
  "◀️", "▶️", "🏠", "🛍", "🛒", "🗂", "📦", "💰", "💳", "🎁", "🔗", "📤", "⚡", "✅", "❌", "🎫", "💬", "👤", "🌐", "💱",
  "🔥", "🎯", "📋", "🔄", "🧾", "➕", "✏️", "🗑", "⭐", "🪙", "🇮🇳", "📊", "🔔", "🏆", "👥", "🧑‍💻", "🎡", "💎", "🔑", "🛟",
];

/** Telegram caps a message's entities; stay well inside it. */
const MAX_CUSTOM_EMOJI = 50;

/**
 * Swap plain emoji for premium ones in a Telegram-HTML string. Text inside
 * <code>/<pre>/<a> and existing <tg-emoji> is left alone (Telegram does not
 * allow a custom emoji there); tags themselves are never touched.
 */
export function premiumizeHtml(html: string, map: Map<string, string>): string {
  if (!html || map.size === 0) return html;
  const existing = (html.match(/<tg-emoji\b/gi) ?? []).length;
  let budget = MAX_CUSTOM_EMOJI - existing;
  if (budget <= 0) return html;
  const parts = html.split(/(<[^<>]+>)/);
  const skip: string[] = [];
  let out = "";
  for (const part of parts) {
    if (part.startsWith("<") && part.endsWith(">")) {
      const m = /^<(\/?)([a-z-]+)/i.exec(part);
      const name = (m?.[2] ?? "").toLowerCase();
      if (name === "code" || name === "pre" || name === "a" || name === "tg-emoji") {
        if (m?.[1] === "/") { const i = skip.lastIndexOf(name); if (i >= 0) skip.splice(i, 1); }
        else skip.push(name);
      }
      out += part;
      continue;
    }
    if (skip.length > 0 || budget <= 0) { out += part; continue; }
    out += part.replace(EMOJI_SEQ, (glyph) => {
      if (budget <= 0) return glyph;
      const id = map.get(emojiKey(glyph));
      if (!id) return glyph;
      budget--;
      return `<tg-emoji emoji-id="${id}">${glyph}</tg-emoji>`;
    });
  }
  return out;
}

type Btn = Record<string, unknown> & { text?: string };

/**
 * Give inline buttons that START with a premium-mapped emoji that emoji as
 * their icon (Bot API icon_custom_emoji_id), removing the plain glyph from the
 * label so it is not shown twice. Copy buttons and buttons that already have
 * an icon are left alone.
 */
export function premiumizeKeyboard<T>(markup: T, map: Map<string, string>): T {
  const kb = (markup as { inline_keyboard?: Btn[][] } | undefined)?.inline_keyboard;
  if (!Array.isArray(kb) || map.size === 0) return markup;
  let changed = false;
  const rows = kb.map((row) => row.map((b) => {
    if (!b || typeof b.text !== "string" || b.icon_custom_emoji_id || b.copy_text) return b;
    const label = b.text.trim();
    // The emoji a label starts with ("🎁 Refer"), else the one it ends with
    // ("Next ▶️") — either becomes the premium icon, shown before the text.
    const head = label.match(new RegExp(`^${EMOJI_SEQ.source}`, "u"));
    const tail = head ? null : label.match(new RegExp(`${EMOJI_SEQ.source}$`, "u"));
    const glyph = head?.[0] ?? tail?.[0];
    if (!glyph) return b;
    const id = map.get(emojiKey(glyph));
    if (!id) return b;
    const rest = (head ? label.slice(glyph.length) : label.slice(0, label.length - glyph.length)).trim();
    if (!rest) return b; // an emoji-only label keeps its glyph (a label cannot be empty)
    changed = true;
    return { ...b, text: rest, icon_custom_emoji_id: id };
  }));
  return changed ? ({ ...(markup as object), inline_keyboard: rows } as T) : markup;
}

type ApiCall = (method: string, payload: unknown, signal?: AbortSignal) => Promise<{ ok: boolean; error_code?: number; description?: string }>;

const TEXT_METHODS = new Set(["sendMessage", "editMessageText"]);
const CAPTION_METHODS = new Set(["sendPhoto", "sendDocument", "sendVideo", "sendAnimation", "sendAudio", "editMessageCaption"]);
const MARKUP_METHODS = new Set([...TEXT_METHODS, ...CAPTION_METHODS, "editMessageReplyMarkup"]);

/**
 * A grammY API transformer (bot.api.config.use / new Api().config.use) that
 * premiumizes every outgoing message. On a 400 caused by what it added, the
 * call is repeated exactly as the caller made it — never worse than before.
 */
export function premiumEmojiTransformer(opts: { buttons: boolean }) {
  return async (prev: ApiCall, method: string, payload: unknown, signal?: AbortSignal) => {
    if (!MARKUP_METHODS.has(method) || !payload || typeof payload !== "object") return prev(method, payload, signal);
    let state: { cfg: AutoEmojiConfig; map: Map<string, string> };
    try { state = await premiumGlyphMap(); } catch { return prev(method, payload, signal); }
    if (!state.cfg.enabled || state.map.size === 0) return prev(method, payload, signal);
    const p = payload as Record<string, unknown>;
    const next: Record<string, unknown> = { ...p };
    if (p.parse_mode === "HTML") {
      if (TEXT_METHODS.has(method) && typeof p.text === "string") next.text = premiumizeHtml(p.text, state.map);
      if (CAPTION_METHODS.has(method) && typeof p.caption === "string") next.caption = premiumizeHtml(p.caption, state.map);
    }
    if (opts.buttons && p.reply_markup) next.reply_markup = premiumizeKeyboard(p.reply_markup, state.map);
    const changed = next.text !== p.text || next.caption !== p.caption || next.reply_markup !== p.reply_markup;
    if (!changed) return prev(method, payload, signal);
    const res = await prev(method, next, signal);
    if (!res.ok && res.error_code === 400) return prev(method, payload, signal);
    return res;
  };
}
