import { loadConfig } from "@gis/config";
import { prisma } from "@gis/database";
import { enqueueTelegramMessage, type OutboxButton } from "./queues.js";
import { effectivePriceMinor, isSaleActive } from "./pricing.js";

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
  const segment = ((broadcast.segmentQuery as { segment?: BroadcastSegment })?.segment ?? "all") as BroadcastSegment;
  const ids = await targetTelegramIds(segment);
  const text = renderText(broadcast.title, broadcast.body);
  const buttons: OutboxButton[] | undefined =
    broadcast.buttonText && broadcast.buttonUrl ? [{ text: broadcast.buttonText, url: broadcast.buttonUrl }] : undefined;
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
  pin?: boolean;
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
      segmentQuery: { segment: opts.segment } as never,
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
      segmentQuery: { segment: opts.segment } as never,
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

  const icon = p.iconEmoji ? `${p.iconEmoji} ` : "🆕 ";
  const title = `${icon}${p.name}`;
  const lines = ["🆕 Just added & in stock!", "", p.description ?? "Grab it now."];
  if (cheapest) lines.push(`\n${onSale ? "🔥 Flash sale — " : ""}from ${fmtMinor(cheapest.minor, cheapest.currency)}`);

  const buttonText = onSale ? "⚡ Buy Now — 🔥 Deal" : "⚡ Buy Now";
  const buttonUrl = cfg.BOT_USERNAME ? `https://t.me/${cfg.BOT_USERNAME}?start=p_${p.slug}` : undefined;

  const res = await sendBroadcast({
    title,
    body: lines.join("\n"),
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

  const icon = p.iconEmoji ? `${p.iconEmoji} ` : "";
  const title = `🔥 FLASH SALE — ${icon}${p.name}`;
  const body = [
    `${pct}% OFF${left ? ` · ⏳ ${left}` : ""}!`,
    cheapest ? `${fmtMinor(cheapest.was, cheapest.currency)} ➜ ${fmtMinor(cheapest.now, cheapest.currency)}` : "",
    "",
    "Grab it before the timer runs out! ⚡",
  ].filter((l) => l !== "").join("\n");

  const buttonUrl = cfg.BOT_USERNAME ? `https://t.me/${cfg.BOT_USERNAME}?start=p_${p.slug}` : undefined;
  const res = await sendBroadcast({
    title,
    body,
    segment: "all",
    imageUrl: p.imageUrl ?? undefined,
    buttonText: buttonUrl ? "⚡ Grab the deal" : undefined,
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
  const all = p.variants.flatMap((v) => v.prices);
  const inr = all.filter((pr) => pr.currency === "INR");
  const picks = (inr.length > 0 ? inr : all).map((pr) => ({ currency: pr.currency, minor: effectivePriceMinor(pr.amountMinor, p) }));
  const cheapest = picks.length > 0 ? picks.reduce((a, b) => (b.minor < a.minor ? b : a)) : null;

  const icon = p.iconEmoji ? `${p.iconEmoji} ` : "📦 ";
  const title = `🔥 RESTOCKED — ${icon}${p.name}`;
  const lines = [`📦 ${qtyAdded} added — now in stock!`];
  if (cheapest) lines.push(`💎 from ${fmtMinor(cheapest.minor, cheapest.currency)}`);
  lines.push("", "⚡ Instant delivery • Grab it now!");

  const buttonUrl = cfg.BOT_USERNAME ? `https://t.me/${cfg.BOT_USERNAME}?start=p_${p.slug}` : undefined;
  const res = await sendBroadcast({
    title,
    body: lines.join("\n"),
    segment: "all",
    imageUrl: p.imageUrl ?? undefined,
    buttonText: buttonUrl ? "⚡ Buy Now" : undefined,
    buttonUrl,
    createdById: opts.createdById,
  });
  return { announced: true, targets: res.targets };
}
