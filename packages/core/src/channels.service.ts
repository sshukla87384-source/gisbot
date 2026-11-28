import { loadConfig } from "@gis/config";
import { prisma } from "@gis/database";
import { formatMinor, type CurrencyCode } from "@gis/shared";
import { enqueueTelegramMessage } from "./queues.js";
import { getRedis } from "./redis.js";
import { groupOrderLines } from "./orders/order.service.js";
import { productEmojiHtml } from "./broadcast.service.js";

/**
 * Channels & groups the shop is linked to:
 *
 *   mustJoin  — the customer has to be a member of EVERY one of these before
 *               the bot does anything for them (checked live, re-checked
 *               every couple of minutes, so leaving locks them out again).
 *   orderFeed — every paid order is announced here ("🛒 New order …").
 *
 * The bot itself enforces the gate (apps/telegram-bot); this file only holds
 * the list and posts the feed.
 */

export interface LinkedChat {
  /** Telegram chat id, e.g. "-1001234567890". */
  chatId: string;
  title: string;
  /** Join link shown to customers (t.me/username or an invite link). */
  link: string | null;
  type: "channel" | "group" | "supergroup" | string;
}

export interface ChannelsConfig {
  /** Enforce mustJoin. The list can be kept while the gate is switched off. */
  forceJoin: boolean;
  mustJoin: LinkedChat[];
  orderFeed: LinkedChat[];
  /** Show the amount in the order feed. */
  feedShowPrice: boolean;
  /** The order-feed chats must be joined too (on by default). */
  feedMustJoin: boolean;
  /** Emoji used in the order-feed post, per slot (premium <tg-emoji> or a plain emoji). */
  feedEmoji: Partial<Record<FeedEmojiSlot, string>>;
}

/** The places in an order-feed post that carry an emoji (admin: 📢 Channels → 🎨 Feed emoji). */
export const FEED_EMOJI_SLOTS = {
  bot: { def: "🛒", label: "Header — order in the bot" },
  web: { def: "🌐", label: "Header — website order" },
  api: { def: "🔌", label: "Header — API order" },
  item: { def: "📦", label: "Product (when it has no emoji)" },
  price: { def: "💰", label: "Amount" },
  buyer: { def: "👤", label: "Buyer" },
  via: { def: "📲", label: "Ordered via" },
  instant: { def: "⚡", label: "Delivered instantly" },
  manual: { def: "🕐", label: "Delivered by the team" },
} as const;
export type FeedEmojiSlot = keyof typeof FEED_EMOJI_SLOTS;

/** Only a premium emoji tag or a short plain emoji is stored — never arbitrary HTML. */
export function cleanFeedEmoji(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  const m = t.match(/^<tg-emoji emoji-id="(\d{5,25})">([^<>&]{1,16})<\/tg-emoji>$/);
  if (m) return `<tg-emoji emoji-id="${m[1]}">${m[2]}</tg-emoji>`;
  if (t && t.length <= 16 && !/[<>&]/.test(t) && /\p{Extended_Pictographic}/u.test(t)) return t;
  return null;
}

function cleanFeedEmojiMap(x: unknown): Partial<Record<FeedEmojiSlot, string>> {
  const out: Partial<Record<FeedEmojiSlot, string>> = {};
  if (!x || typeof x !== "object") return out;
  for (const k of Object.keys(FEED_EMOJI_SLOTS) as FeedEmojiSlot[]) {
    const v = cleanFeedEmoji((x as Record<string, unknown>)[k]);
    if (v) out[k] = v;
  }
  return out;
}

const KEY = "channels.cfg";
const DEFAULT: ChannelsConfig = { forceJoin: true, mustJoin: [], orderFeed: [], feedShowPrice: true, feedMustJoin: true, feedEmoji: {} };
let cache: { at: number; v: ChannelsConfig } | null = null;

function cleanList(x: unknown): LinkedChat[] {
  if (!Array.isArray(x)) return [];
  return x
    .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object")
    .map((c) => ({
      chatId: String(c.chatId ?? ""),
      title: String(c.title ?? "").slice(0, 120),
      link: typeof c.link === "string" && c.link ? c.link : null,
      type: String(c.type ?? "channel"),
    }))
    .filter((c) => /^-?\d+$/.test(c.chatId));
}

export async function getChannelsConfig(): Promise<ChannelsConfig> {
  if (cache && Date.now() - cache.at < 15_000) return cache.v;
  let v = DEFAULT;
  try {
    const row = await prisma.setting.findUnique({ where: { key: KEY } });
    const r = row?.value as Partial<ChannelsConfig> | null | undefined;
    if (r && typeof r === "object") {
      v = {
        forceJoin: r.forceJoin !== false,
        mustJoin: cleanList(r.mustJoin),
        orderFeed: cleanList(r.orderFeed),
        feedShowPrice: r.feedShowPrice !== false,
        feedMustJoin: r.feedMustJoin !== false,
        feedEmoji: cleanFeedEmojiMap(r.feedEmoji),
      };
    }
  } catch { /* defaults */ }
  cache = { at: Date.now(), v };
  return v;
}

export async function setChannelsConfig(patch: Partial<ChannelsConfig>): Promise<ChannelsConfig> {
  const next = { ...(await getChannelsConfig()), ...patch };
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: next as never }, update: { value: next as never } });
  cache = { at: Date.now(), v: next };
  return next;
}

export type LinkedChatKind = "mustJoin" | "orderFeed";

export async function addLinkedChat(kind: LinkedChatKind, chat: LinkedChat): Promise<ChannelsConfig> {
  const cfg = await getChannelsConfig();
  const list = cfg[kind].filter((c) => c.chatId !== chat.chatId);
  list.push(chat);
  return setChannelsConfig({ [kind]: list.slice(0, 10) } as Partial<ChannelsConfig>);
}

export async function removeLinkedChat(kind: LinkedChatKind, chatId: string): Promise<ChannelsConfig> {
  const cfg = await getChannelsConfig();
  return setChannelsConfig({ [kind]: cfg[kind].filter((c) => c.chatId !== chatId) } as Partial<ChannelsConfig>);
}

/**
 * The chats a customer must have joined, when the gate is on: the must-join
 * list plus — unless switched off — the order-feed channels / groups.
 */
export async function activeMustJoin(): Promise<LinkedChat[]> {
  const cfg = await getChannelsConfig();
  if (!cfg.forceJoin) return [];
  const all = cfg.feedMustJoin ? [...cfg.mustJoin, ...cfg.orderFeed] : cfg.mustJoin;
  const seen = new Set<string>();
  // A chat with no join link cannot be joined from the bot — enforcing it
  // would lock every customer out, so it is skipped until it has one.
  return all.filter((c) => Boolean(c.link) && (seen.has(c.chatId) ? false : (seen.add(c.chatId), true)));
}

// ── Order feed ───────────────────────────────────────────────────────────────

/** "Satyam" → "Sa***m": the feed is public, the buyer stays anonymous. */
function maskName(n: string): string {
  const s = n.replace(/^@/, "").trim();
  if (!s) return "Customer";
  if (s.length <= 2) return `${s[0]}*`;
  return `${s.slice(0, 2)}***${s.slice(-1)}`;
}

export interface FeedOrder {
  channel: string;
  currency: string;
  valueMinor: number;
  buyer: string;
  lines: Array<{ icon: string | null; name: string; variant: string; qty: number }>;
  more: number;
  instant: boolean;
}

/** The feed post itself — shared by the real post and the admin's 👁 Preview. */
export function buildFeedText(o: FeedOrder, cfg: Pick<ChannelsConfig, "feedShowPrice" | "feedEmoji">): string {
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const e = (k: FeedEmojiSlot): string => cfg.feedEmoji[k] ?? FEED_EMOJI_SLOTS[k].def;
  const kind = o.channel === "API" ? "api" : o.channel === "WEB" ? "web" : "bot";
  const head = kind === "api" ? `${e("api")} <b>New API order!</b>` : kind === "web" ? `${e("web")} <b>New website order!</b>` : `${e("bot")} <b>New order!</b>`;
  const via = kind === "api" ? "<b>API order</b> (reseller)" : kind === "web" ? "Website" : "Telegram bot";
  const items = o.lines.map((l) => `${l.icon || e("item")} <b>${esc(l.name)}</b>${l.variant ? ` · ${esc(l.variant)}` : ""} <b>×${l.qty}</b>`);
  if (o.more > 0) items.push(`<i>… +${o.more} more</i>`);
  return [
    head,
    "",
    ...items,
    "",
    ...(cfg.feedShowPrice ? [`${e("price")} <b>Total:</b> ${formatMinor(o.valueMinor, o.currency as CurrencyCode)}`] : []),
    `${e("buyer")} <b>${kind === "api" ? "Reseller" : "Buyer"}:</b> ${esc(o.buyer)}`,
    `${e("via")} <b>Via:</b> ${via}`,
    "",
    o.instant ? `${e("instant")} <i>Delivered instantly</i>` : `${e("manual")} <i>Being delivered by our team</i>`,
  ].join("\n");
}

/** A sample post per kind, for the admin's preview. */
export function sampleFeedTexts(cfg: Pick<ChannelsConfig, "feedShowPrice" | "feedEmoji">): string[] {
  const base = { currency: "USD", valueMinor: 1299, more: 0 };
  return [
    buildFeedText({ ...base, channel: "DIRECT", buyer: "Sa***m", instant: true, lines: [{ icon: null, name: "Netflix Premium 1 Month", variant: "", qty: 1 }] }, cfg),
    buildFeedText({ ...base, channel: "WEB", buyer: "Ra***l", instant: true, lines: [{ icon: null, name: "Spotify Premium", variant: "12 months", qty: 2 }] }, cfg),
    buildFeedText({ ...base, channel: "API", buyer: "Re***r", instant: false, lines: [{ icon: null, name: "ChatGPT Plus", variant: "", qty: 5 }] }, cfg),
  ];
}

/**
 * Post one paid order to every order-feed chat. Once per order, whichever
 * payment rail confirmed it (they all pass through notifyOrderToAdmins).
 */
export async function postOrderToFeed(orderId: string): Promise<void> {
  const cfg = await getChannelsConfig();
  if (cfg.orderFeed.length === 0) return;
  const first = await getRedis().set(`feed:order:${orderId}`, "1", "EX", 7 * 86400, "NX").catch(() => "OK");
  if (first !== "OK") return;
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      currency: true, subtotalMinor: true, discountMinor: true, createdAt: true, channel: true,
      user: { select: { firstName: true, telegramHandle: true, email: true } },
      items: { select: { productNameSnap: true, variantNameSnap: true, quantity: true, variant: { select: { product: { select: { iconEmoji: true, nameHtml: true, name: true, fulfillmentMode: true, supplierId: true } } } } } },
    },
  });
  if (!o || o.items.length === 0) return;
  const groups = groupOrderLines(o.items);
  // The product's own (premium) emoji where it has one.
  const iconOf = new Map<string, string>();
  for (const i of o.items) {
    if (iconOf.has(i.productNameSnap)) continue;
    const pr = i.variant.product;
    const ic = productEmojiHtml(pr.iconEmoji, pr.nameHtml, pr.name);
    if (ic) iconOf.set(i.productNameSnap, ic);
  }
  const instant = o.items.every((i) => i.variant.product.fulfillmentMode === "AUTOMATIC" || i.variant.product.supplierId !== null);
  const text = buildFeedText({
    channel: o.channel,
    currency: o.currency,
    valueMinor: Math.max(0, o.subtotalMinor - o.discountMinor),
    buyer: maskName(o.user.firstName ?? o.user.telegramHandle ?? o.user.email?.split("@")[0] ?? ""),
    lines: groups.slice(0, 6).map((g) => ({
      icon: iconOf.get(g.productNameSnap) ?? null,
      name: g.productNameSnap.replace(/^\s*\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*\s*/u, ""),
      variant: g.variantNameSnap.trim().toLowerCase() === "standard" ? "" : g.variantNameSnap,
      qty: g.quantity,
    })),
    more: Math.max(0, groups.length - 6),
    instant,
  }, cfg);
  const bot = loadConfig().BOT_USERNAME;
  const site = await import("./admin.service.js").then((m) => m.getShopWebsiteLink()).catch(() => null);
  const buttons = [
    ...(bot ? [{ text: "🛍 Order in the bot", url: `https://t.me/${bot.replace(/^@/, "")}` }] : []),
    ...(site ? [{ text: "🌐 Order on the website", url: site }] : []),
  ];
  for (const c of cfg.orderFeed) {
    await enqueueTelegramMessage(c.chatId, text, { buttons }).catch(() => undefined);
  }
}
