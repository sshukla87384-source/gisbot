import { loadConfig } from "@gis/config";
import { prisma } from "@gis/database";
import { enqueueTelegramMessage, type OutboxButton } from "./queues.js";
import { effectivePriceMinor, isSaleActive } from "./pricing.js";
import { getProductView } from "./catalog/catalog.service.js";
import { getFlashHeadline } from "./admin.service.js";

export type BroadcastSegment = "all" | "customers" | "resellers";
export type BroadcastRecurrence = "none" | "daily" | "weekly";

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderText(title: string, body: string): string {
  return title ? `<b>${escape(title)}</b>\n\n${escape(body)}` : escape(body);
}

async function targetTelegramIds(segment: BroadcastSegment): Promise<bigint[]> {
  const where: Record<string, unknown> = { notifiable: true, telegramId: { not: null }, status: "ACTIVE" };
  if (segment === "resellers") where.roles = { some: { role: { name: "RESELLER" } } };
  const users = await prisma.user.findMany({ where, select: { telegramId: true } });
  return users.map((u) => u.telegramId).filter((id): id is bigint => id !== null);
}

/** Fan a broadcast row out to its audience through the throttled outbox queue. */
async function deliver(broadcast: {
  id: string;
  title: string;
  body: string;
  imageUrl: string | null;
  buttonText: string | null;
  buttonUrl: string | null;
  pin: boolean;
  segmentQuery: unknown;
}): Promise<number> {
  const sq = broadcast.segmentQuery as { segment?: BroadcastSegment; html?: boolean; style?: string } | null;
  const segment = (sq?.segment ?? "all") as BroadcastSegment;
  const ids = await targetTelegramIds(segment);
  const text = sq?.html ? broadcast.body : renderText(broadcast.title, broadcast.body);
  const btnStyle = (sq?.style === "primary" || sq?.style === "danger" || sq?.style === "success" ? sq.style : "success") as "primary" | "success" | "danger";
  const buttons: OutboxButton[] | undefined =
    broadcast.buttonText && broadcast.buttonUrl ? [{ text: broadcast.buttonText, url: broadcast.buttonUrl, style: btnStyle }] : undefined;
  let sent = 0;
  for (const id of ids) {
    await enqueueTelegramMessage(id, text, { photo: broadcast.imageUrl ?? undefined, buttons, pin: broadcast.pin });
    sent++;
  }
  await prisma.broadcast.update({
    where: { id: broadcast.id },
    data: { totalTargets: ids.length, sentCount: sent },
  });
  return sent;
}

export interface BroadcastInput {
  title: string;
  body: string;
  segment: BroadcastSegment;
  imageUrl?: string;
  buttonText?: string;
  buttonUrl?: string;
  buttonStyle?: string;
  pin?: boolean;
  bodyIsHtml?: boolean;
  createdById: string;
}

/** Send a broadcast immediately to bot users. */
export async function sendBroadcast(opts: BroadcastInput): Promise<{ broadcastId: string; targets: number }> {
  const broadcast = await prisma.broadcast.create({
    data: {
      title: opts.title,
      body: opts.body,
      imageUrl: opts.imageUrl ?? null,
      buttonText: opts.buttonText ?? null,
      buttonUrl: opts.buttonUrl ?? null,
      pin: opts.pin ?? false,
      segmentQuery: { segment: opts.segment, html: opts.bodyIsHtml ?? false, style: opts.buttonStyle ?? "success" } as never,
      status: "RUNNING",
      createdById: opts.createdById,
      startedAt: new Date(),
    },
  });
  const sent = await deliver(broadcast);
  await prisma.broadcast.update({
    where: { id: broadcast.id },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  return { broadcastId: broadcast.id, targets: sent };
}

/** Schedule a broadcast to auto-send at a future time; optionally auto-repeat. */
export async function scheduleBroadcast(
  opts: BroadcastInput & { scheduledAt: Date; recurrence?: BroadcastRecurrence },
): Promise<{ broadcastId: string; scheduledAt: Date; recurrence: BroadcastRecurrence }> {
  const recurrence = opts.recurrence ?? "none";
  const broadcast = await prisma.broadcast.create({
    data: {
      title: opts.title,
      body: opts.body,
      imageUrl: opts.imageUrl ?? null,
      buttonText: opts.buttonText ?? null,
      buttonUrl: opts.buttonUrl ?? null,
      pin: opts.pin ?? false,
      segmentQuery: { segment: opts.segment, html: opts.bodyIsHtml ?? false, style: opts.buttonStyle ?? "success" } as never,
      status: "SCHEDULED",
      scheduledAt: opts.scheduledAt,
      recurrence,
      createdById: opts.createdById,
    },
  });
  return { broadcastId: broadcast.id, scheduledAt: opts.scheduledAt, recurrence };
}

function nextOccurrence(from: Date, recurrence: BroadcastRecurrence): Date {
  const next = new Date(from);
  const bump = () => {
    if (recurrence === "daily") next.setUTCDate(next.getUTCDate() + 1);
    else next.setUTCDate(next.getUTCDate() + 7);
  };
  bump();
  while (next.getTime() <= Date.now()) bump();
  return next;
}

/** Cron entrypoint: deliver every SCHEDULED broadcast whose time has arrived. */
export async function dispatchDueBroadcasts(): Promise<number> {
  const now = new Date();
  const due = await prisma.broadcast.findMany({
    where: { status: "SCHEDULED", scheduledAt: { lte: now } },
    take: 20,
  });
  let dispatched = 0;
  for (const b of due) {
    const claimed = await prisma.broadcast.updateMany({
      where: { id: b.id, status: "SCHEDULED" },
      data: { status: "RUNNING", startedAt: now },
    });
    if (claimed.count === 0) continue;
    await deliver(b);
    const recurrence = (b.recurrence ?? "none") as BroadcastRecurrence;
    if (recurrence === "none") {
      await prisma.broadcast.update({ where: { id: b.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    } else {
      await prisma.broadcast.update({
        where: { id: b.id },
        data: { status: "SCHEDULED", scheduledAt: nextOccurrence(b.scheduledAt ?? now, recurrence) },
      });
    }
    dispatched++;
  }
  return dispatched;
}

/** Cancel a scheduled (or recurring) broadcast so it stops firing. */
export async function cancelBroadcast(id: string): Promise<void> {
  await prisma.broadcast.updateMany({
    where: { id, status: { in: ["SCHEDULED", "PAUSED"] } },
    data: { status: "CANCELLED" },
  });
}

function fmtMinor(amountMinor: number, currency: string): string {
  const symbol = currency === "INR" ? "₹" : currency === "USD" ? "$" : "";
  return `${symbol}${(amountMinor / 100).toFixed(2)}`;
}

/**
 * Announce a product to all bot users: image + name + starting price + a Buy
 * button that deep-links the bot to the product. Optionally pins the post.
 * Idempotent per product unless force is set (records announcedAt).
 */
export async function announceProduct(
  productId: string,
  opts: { createdById: string; pin?: boolean; force?: boolean } = { createdById: "system" },
): Promise<{ announced: boolean; broadcastId?: string; targets?: number }> {
  const p = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      variants: { where: { isActive: true, deletedAt: null }, include: { prices: { where: { tier: { name: "RETAIL" } } } } },
    },
  });
  if (!p || p.status !== "ACTIVE" || p.deletedAt) return { announced: false };
  if (p.announcedAt && !opts.force) return { announced: false };

  const cfg = loadConfig();
  const onSale = isSaleActive(p);
  // Cheapest INR price (fallback to any currency) for the teaser line.
  const allPrices = p.variants.flatMap((v) => v.prices);
  const inr = allPrices.filter((pr) => pr.currency === "INR");
  const pick = (inr.length > 0 ? inr : allPrices).map((pr) => ({
    currency: pr.currency,
    minor: effectivePriceMinor(pr.amountMinor, p),
  }));
  const cheapest = pick.length > 0 ? pick.reduce((a, b) => (b.minor < a.minor ? b : a)) : null;

  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const icon = p.iconEmoji ? `${p.iconEmoji} ` : "🆕 ";
  const nameDisp = p.nameHtml ?? `<b>${esc(p.name)}</b>`;
  const descDisp = p.descriptionHtml ?? (p.description ? esc(p.description) : "");
  const lines = [
    `${icon}${nameDisp}`,
    onSale ? "🔥 <b>Flash sale — just added!</b>" : "🆕 <b>Just added & in stock!</b>",
  ];
  if (cheapest) lines.push("", `💵 <b>${onSale ? "Sale price " : "Price "}from ${fmtMinor(cheapest.minor, cheapest.currency)}</b>`);

  const buttonText = onSale ? "🛒 Buy now — 🔥 Deal" : "🛒 Buy now";
  const buttonUrl = cfg.BOT_USERNAME ? `https://t.me/${cfg.BOT_USERNAME}?start=p_${p.slug}` : undefined;

  const res = await sendBroadcast({
    title: "",
    body: lines.join("\n"),
    bodyIsHtml: true,
    segment: "all",
    imageUrl: p.imageUrl ?? undefined,
    buttonText: buttonUrl ? buttonText : undefined,
    buttonUrl,
    pin: opts.pin ?? false,
    createdById: opts.createdById,
  });
  await prisma.product.update({ where: { id: p.id }, data: { announcedAt: new Date() } });
  return { announced: true, broadcastId: res.broadcastId, targets: res.targets };
}

function saleTimeLeft(until: Date | null): string {
  if (!until) return "";
  let ms = until.getTime() - Date.now();
  if (ms <= 0) return "";
  const d = Math.floor(ms / 86_400_000); ms -= d * 86_400_000;
  const h = Math.floor(ms / 3_600_000); ms -= h * 3_600_000;
  const m = Math.floor(ms / 60_000);
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

/**
 * Instantly broadcast a flash-sale announcement for a product to all users:
 * 🔥 X% OFF, sale price, countdown, and a ⚡ Buy Now deep-link button.
 */
export async function announceFlashSale(
  productId: string,
  opts: { createdById: string; pin?: boolean } = { createdById: "system" },
): Promise<{ announced: boolean; targets?: number }> {
  const p = await prisma.product.findUnique({
    where: { id: productId },
    include: { variants: { where: { isActive: true, deletedAt: null }, include: { prices: { where: { tier: { name: "RETAIL" } } } } } },
  });
  if (!p || p.status !== "ACTIVE" || p.deletedAt) return { announced: false };
  if (!isSaleActive(p)) return { announced: false };

  const cfg = loadConfig();
  const pct = Math.round((p.salePercentBp ?? 0) / 100);
  const all = p.variants.flatMap((v) => v.prices);
  const inr = all.filter((pr) => pr.currency === "INR");
  const picks = (inr.length > 0 ? inr : all).map((pr) => ({
    currency: pr.currency, was: pr.amountMinor, now: effectivePriceMinor(pr.amountMinor, p),
  }));
  const cheapest = picks.length > 0 ? picks.reduce((a, b) => (b.now < a.now ? b : a)) : null;
  const left = saleTimeLeft(p.saleEndsAt);

  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const icon = p.iconEmoji ? `${p.iconEmoji} ` : "";
  const nameDisp = p.nameHtml ?? `<b>${esc(p.name)}</b>`;
  const descDisp = p.descriptionHtml ?? (p.description ? esc(p.description) : "");
  const hook = (await getFlashHeadline().catch(() => "")).trim() || "⚡🔥 <b>HURRY — FLASH SALE IS LIVE!</b> 🔥⚡";
  const lines = [
    hook,
    "━━━━━━━━━━━━━━━━━━━━",
    `${icon}${nameDisp}`,
    ...(descDisp ? [descDisp] : []),
    "",
    `🏷 <b>${pct}% OFF</b>${left ? `   ·   ⏳ <b>${left}</b>` : ""}`,
    cheapest ? `💸 <s>${fmtMinor(cheapest.was, cheapest.currency)}</s> ➜ <b>${fmtMinor(cheapest.now, cheapest.currency)}</b>` : "",
    "",
    "🚀 <b>Best deal of the day — don't miss it!</b>",
    "⌛ Once the timer ends, the price goes back up.",
  ].filter((l) => l !== "");

  const buttonUrl = cfg.BOT_USERNAME ? `https://t.me/${cfg.BOT_USERNAME}?start=p_${p.slug}` : undefined;
  const res = await sendBroadcast({
    title: "",
    body: lines.join("\n"),
    bodyIsHtml: true,
    segment: "all",
    imageUrl: p.imageUrl ?? undefined,
    buttonText: buttonUrl ? "🛒 Grab the deal 🔥" : undefined,
    buttonUrl,
    pin: opts.pin ?? false,
    createdById: opts.createdById,
  });
  return { announced: true, targets: res.targets };
}

/**
 * Announce a restock to all users: "🔥 RESTOCKED — <product> · N added",
 * with image + price + a ⚡ Buy Now deep-link. Only for ACTIVE products.
 */
export async function announceRestock(
  productId: string,
  qtyAdded: number,
  opts: { createdById: string } = { createdById: "system" },
): Promise<{ announced: boolean; targets?: number }> {
  const p = await prisma.product.findUnique({
    where: { id: productId },
    include: { variants: { where: { isActive: true, deletedAt: null }, include: { prices: { where: { tier: { name: "RETAIL" } } } } } },
  });
  if (!p || p.status !== "ACTIVE" || p.deletedAt || qtyAdded <= 0) return { announced: false };

  const cfg = loadConfig();
  // Live current stock + cheapest price (USD-first, matching the store's primary currency).
  const view = await getProductView(productId, "USD").catch(() => null);
  const UNLIMITED = 1_000_000;
  const currentStock = view ? view.variants.reduce((sum, v) => sum + (v.stock >= UNLIMITED ? 0 : v.stock), 0) : qtyAdded;
  const pricedMinors = view ? view.variants.map((v) => v.priceMinor).filter((n): n is number => n !== null) : [];
  const cheapestMinor = pricedMinors.length > 0 ? Math.min(...pricedMinors) : null;

  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const iconTxt = p.iconEmoji ? `${p.iconEmoji} ` : "";
  const nameDisp = p.nameHtml ?? `<b>${esc(p.name)}</b>`;
  const usdt = cheapestMinor !== null ? (Number.isInteger(cheapestMinor / 100) ? (cheapestMinor / 100).toFixed(1) : (cheapestMinor / 100).toFixed(2)) : "";
  const body = `📣 <b>${qtyAdded} new stock added for</b> ${iconTxt}${nameDisp}`;
  const btnLabel = `${iconTxt}${p.name} - ${usdt} USDT (Stock: ${currentStock})`.slice(0, 64);

  const buttonUrl = cfg.BOT_USERNAME ? `https://t.me/${cfg.BOT_USERNAME}?start=p_${p.slug}` : undefined;
  const res = await sendBroadcast({
    title: "",
    body,
    bodyIsHtml: true,
    segment: "all",
    imageUrl: p.imageUrl ?? undefined,
    buttonText: buttonUrl ? btnLabel : undefined,
    buttonUrl,
    buttonStyle: "success",
    createdById: opts.createdById,
  });
  return { announced: true, targets: res.targets };
}

/**
 * Price-change alert. A drop is framed as urgency ("price crashed"), a rise as
 * scarcity ("low supply") — both with the exact before/after and a buy button.
 */
export async function announcePriceChange(
  productId: string,
  oldMinor: number,
  newMinor: number,
  currency: "USD" | "INR" = "USD",
): Promise<{ announced: boolean; targets?: number }> {
  if (oldMinor <= 0 || newMinor <= 0 || oldMinor === newMinor) return { announced: false };
  const p = await prisma.product.findUnique({ where: { id: productId } });
  if (!p || p.status !== "ACTIVE" || p.deletedAt) return { announced: false };

  const cfg = loadConfig();
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const icon = p.iconEmoji ? `${p.iconEmoji} ` : "";
  const nameDisp = p.nameHtml ?? `<b>${esc(p.name)}</b>`;
  const sym = currency === "INR" ? "₹" : "$";
  const money = (m: number) => `${sym}${(m / 100).toFixed(2)}`;
  const dropped = newMinor < oldMinor;
  const pct = Math.round((Math.abs(newMinor - oldMinor) / oldMinor) * 100);

  const stock = await getProductView(productId, currency).catch(() => null);
  const UNLIMITED = 1_000_000;
  const units = stock ? stock.variants.reduce((n, v) => n + (v.stock >= UNLIMITED ? 0 : v.stock), 0) : 0;

  const body = dropped
    ? [
        "🚨💥 <b>PRICE CRASHED!</b> 💥🚨",
        "",
        `${icon}${nameDisp}`,
        "",
        `❌ <s>${money(oldMinor)}</s>   ➡️   ✅ <b>${money(newMinor)}</b>`,
        `📉 <b>${pct}% OFF</b> — you save <b>${money(oldMinor - newMinor)}</b>`,
        units > 0 ? `📦 Only <b>${units}</b> left in stock` : "",
        "",
        "⏰ <b>HURRY — GRAB IT NOW</b> before it is gone! 🏃‍♂️💨",
      ].filter(Boolean).join("\n")
    : [
        "📢⚠️ <b>PRICE UPDATE</b> ⚠️📢",
        "",
        `${icon}${nameDisp}`,
        "",
        `${money(oldMinor)}   ➡️   <b>${money(newMinor)}</b>  📈 +${pct}%`,
        "",
        "🔻 <b>Due to low supply</b>, the price had to be increased.",
        units > 0 ? `📦 Remaining stock: <b>${units}</b>` : "",
        "",
        "🙏 Thank you for understanding — secure yours before it rises again.",
      ].filter(Boolean).join("\n");

  const buttonUrl = cfg.BOT_USERNAME ? `https://t.me/${cfg.BOT_USERNAME}?start=p_${p.slug}` : undefined;
  const res = await sendBroadcast({
    title: "",
    body,
    bodyIsHtml: true,
    segment: "all",
    createdById: "system",
    buttonText: buttonUrl ? (dropped ? `⚡ Grab at ${money(newMinor)}` : `🛒 Buy — ${money(newMinor)}`) : undefined,
    buttonUrl,
    buttonStyle: dropped ? "success" : "primary",
  });
  return { announced: true, targets: res.targets };
}

/**
 * Broadcast the whole live catalogue as a stock list:
 *   <emoji> Name
 *   🎁 N in stock · PRICE
 */
export async function announceCatalogue(
  opts: { segment?: BroadcastSegment; currency?: "USD" | "INR"; inStockOnly?: boolean } = {},
): Promise<{ targets: number; products: number }> {
  const currency = opts.currency ?? "USD";
  const cfg = loadConfig();
  const products = await prisma.product.findMany({
    where: { status: "ACTIVE", deletedAt: null },
    orderBy: [{ pinRank: "desc" }, { sortOrder: "asc" }, { createdAt: "desc" }],
    include: { variants: { where: { isActive: true, deletedAt: null }, include: { prices: { where: { currency, tier: { name: "RETAIL" } } } } } },
  });
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const sym = currency === "INR" ? "₹" : "$";
  const UNLIMITED = 1_000_000;

  const rows: string[] = [];
  let shown = 0;
  for (const p of products) {
    const view = await getProductView(p.id, currency).catch(() => null);
    const unlimited = view ? view.variants.some((v) => v.stock >= UNLIMITED) : false;
    const units = view ? view.variants.reduce((n, v) => n + (v.stock >= UNLIMITED ? 0 : v.stock), 0) : 0;
    if (opts.inStockOnly && !unlimited && units <= 0) continue;
    const priced = (view?.variants ?? []).map((v) => v.priceMinor).filter((n): n is number => n !== null);
    const price = priced.length > 0 ? `${sym}${(Math.min(...priced) / 100).toFixed(2)}` : "—";
    const icon = p.iconEmoji ? `${p.iconEmoji} ` : "";
    const nameDisp = p.nameHtml ?? `<b>${esc(p.name)}</b>`;
    const stockTxt = unlimited ? "∞" : String(units);
    rows.push(`${icon}${nameDisp}\n🎁 <b>${stockTxt}</b> in stock · <b>${price}</b>`);
    shown++;
  }

  const header = ["🗂 <b>FULL STOCK LIST</b>", `🏪 ${esc(cfg.STORE_NAME)}`, "", `📦 <b>${shown}</b> products available right now`, "━━━━━━━━━━━━━━━━━━", ""];
  const footer = ["", "━━━━━━━━━━━━━━━━━━", "⚡ Instant delivery · 💳 Pay from wallet", "👇 Tap below to open the shop"];
  const buttonUrl = cfg.BOT_USERNAME ? `https://t.me/${cfg.BOT_USERNAME}?start=menu` : undefined;

  // Telegram caps a message at 4096 chars — send in chunks that stay under it.
  const chunks: string[] = [];
  let cur: string[] = [];
  let len = 0;
  for (const r of rows) {
    if (len + r.length > 3200 && cur.length > 0) { chunks.push(cur.join("\n\n")); cur = []; len = 0; }
    cur.push(r);
    len += r.length + 2;
  }
  if (cur.length > 0) chunks.push(cur.join("\n\n"));
  if (chunks.length === 0) chunks.push("<i>No products in stock right now.</i>");

  let targets = 0;
  for (let i = 0; i < chunks.length; i++) {
    const first = i === 0;
    const last = i === chunks.length - 1;
    const body = [...(first ? header : [`🗂 <b>STOCK LIST</b> — part ${i + 1}/${chunks.length}`, ""]), chunks[i] ?? "", ...(last ? footer : [])].join("\n");
    const res = await sendBroadcast({
      title: "",
      body,
      bodyIsHtml: true,
      segment: opts.segment ?? "all",
      createdById: "system",
      buttonText: last && buttonUrl ? "🛍 Open the shop" : undefined,
      buttonUrl: last ? buttonUrl : undefined,
      buttonStyle: "success",
    });
    targets = res.targets;
  }
  return { targets, products: shown };
}
