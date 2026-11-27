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
}

const KEY = "channels.cfg";
const DEFAULT: ChannelsConfig = { forceJoin: true, mustJoin: [], orderFeed: [], feedShowPrice: true, feedMustJoin: true };
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
      currency: true, subtotalMinor: true, discountMinor: true, createdAt: true,
      user: { select: { firstName: true, telegramHandle: true } },
      items: { select: { productNameSnap: true, variantNameSnap: true, quantity: true, variant: { select: { product: { select: { iconEmoji: true, nameHtml: true, name: true } } } } } },
    },
  });
  if (!o || o.items.length === 0) return;
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const groups = groupOrderLines(o.items);
  // The product's own (premium) emoji where it has one, else 📦.
  const iconOf = new Map<string, string>();
  for (const i of o.items) {
    if (iconOf.has(i.productNameSnap)) continue;
    const pr = i.variant.product;
    iconOf.set(i.productNameSnap, productEmojiHtml(pr.iconEmoji, pr.nameHtml, pr.name) || "📦");
  }
  const lines = groups.slice(0, 6).map((g) => {
    const vn = g.variantNameSnap.trim().toLowerCase() === "standard" ? "" : ` · ${esc(g.variantNameSnap)}`;
    const name = g.productNameSnap.replace(/^\s*\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*\s*/u, "");
    return `${iconOf.get(g.productNameSnap) ?? "📦"} <b>${esc(name)}</b>${vn} ×${g.quantity}`;
  });
  if (groups.length > 6) lines.push(`… +${groups.length - 6} more`);
  const value = Math.max(0, o.subtotalMinor - o.discountMinor);
  const text = [
    "🛒 <b>New order!</b>",
    "",
    ...lines,
    ...(cfg.feedShowPrice ? [`💰 ${formatMinor(value, o.currency as CurrencyCode)}`] : []),
    `👤 ${esc(maskName(o.user.firstName ?? o.user.telegramHandle ?? ""))}`,
    "",
    "<i>⚡ Delivered instantly by our bot</i>",
  ].join("\n");
  const bot = loadConfig().BOT_USERNAME;
  const buttons = bot ? [{ text: "🛍 Order now", url: `https://t.me/${bot.replace(/^@/, "")}` }] : [];
  for (const c of cfg.orderFeed) {
    await enqueueTelegramMessage(c.chatId, text, { buttons }).catch(() => undefined);
  }
}
