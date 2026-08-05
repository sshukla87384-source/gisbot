import { prisma } from "@gis/database";
import { enqueueTelegramMessage, type OutboxButton } from "./queues.js";
import { loadConfig } from "@gis/config";
import type { Currency } from "@gis/database";

/**
 * "Notify me" subscriptions — back-in-stock and price-drop alerts.
 *
 * Anti-spam: one notification per subscription. Being told is what the customer
 * asked for; being told five times because you restocked in small batches is not.
 * After notifying, the row is removed so they must opt in again.
 */

export type WatchKind = "RESTOCK" | "PRICE_DROP";

export async function watchProduct(
  userId: string,
  productId: string,
  type: WatchKind,
  basePriceMinor?: number,
  currency?: Currency,
): Promise<{ ok: boolean; already: boolean }> {
  const existing = await prisma.productWatch.findUnique({ where: { userId_productId_type: { userId, productId, type } } });
  if (existing) return { ok: true, already: true };
  await prisma.productWatch.create({
    data: { userId, productId, type, basePriceMinor: basePriceMinor ?? null, currency: currency ?? null },
  });
  return { ok: true, already: false };
}

export async function unwatchProduct(userId: string, productId: string, type: WatchKind): Promise<boolean> {
  const r = await prisma.productWatch.deleteMany({ where: { userId, productId, type } });
  return r.count > 0;
}

export async function isWatching(userId: string, productId: string, type: WatchKind): Promise<boolean> {
  return (await prisma.productWatch.findUnique({ where: { userId_productId_type: { userId, productId, type } }, select: { id: true } })) !== null;
}

export async function watchCount(productId: string, type: WatchKind): Promise<number> {
  return prisma.productWatch.count({ where: { productId, type } });
}

/** Products with the most people waiting — tells you what to restock first. */
export async function topWatched(type: WatchKind = "RESTOCK", limit = 10): Promise<Array<{ productId: string; name: string; count: number }>> {
  const grouped = await prisma.productWatch.groupBy({ by: ["productId"], where: { type }, _count: { _all: true }, orderBy: { _count: { productId: "desc" } }, take: limit });
  if (grouped.length === 0) return [];
  const names = new Map(
    (await prisma.product.findMany({ where: { id: { in: grouped.map((g) => g.productId) } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]),
  );
  return grouped.map((g) => ({ productId: g.productId, name: names.get(g.productId) ?? "(deleted)", count: g._count._all }));
}

async function fanOut(productId: string, type: WatchKind, text: string, buttons?: OutboxButton[]): Promise<number> {
  const rows = await prisma.productWatch.findMany({
    where: { productId, type },
    include: { user: { select: { telegramId: true, notifiable: true } } },
  });
  let sent = 0;
  for (const r of rows) {
    if (r.user.telegramId && r.user.notifiable) {
      await enqueueTelegramMessage(r.user.telegramId, text, buttons ? { buttons } : {}).catch(() => undefined);
      sent++;
    }
  }
  // One notification per opt-in: clear the list so a second small restock
  // cannot spam the same people again.
  await prisma.productWatch.deleteMany({ where: { productId, type } });
  return sent;
}

/** Called when stock arrives. */
export async function notifyRestock(productId: string): Promise<number> {
  const p = await prisma.product.findUnique({ where: { id: productId }, select: { name: true, slug: true, iconEmoji: true, status: true } });
  if (!p || p.status !== "ACTIVE") return 0;
  const cfg = loadConfig();
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const url = cfg.BOT_USERNAME ? `https://t.me/${cfg.BOT_USERNAME}?start=p_${p.slug}` : undefined;
  const text = [
    "🔔 <b>BACK IN STOCK!</b>",
    "",
    `${p.iconEmoji ? `${p.iconEmoji} ` : ""}<b>${esc(p.name)}</b> is available again.`,
    "",
    "⚡ You asked to be told — you're hearing it first.",
    "🏃 These go fast, so grab it while it's here!",
  ].join("\n");
  return fanOut(productId, "RESTOCK", text, url ? [{ text: "⚡ Buy it now", url, style: "success" }] : undefined);
}

/** Called when a price drops. Only notifies people who watched at a higher price. */
export async function notifyPriceDrop(productId: string, newMinor: number, currency: Currency): Promise<number> {
  const p = await prisma.product.findUnique({ where: { id: productId }, select: { name: true, slug: true, iconEmoji: true, status: true } });
  if (!p || p.status !== "ACTIVE") return 0;
  const cfg = loadConfig();
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const sym = currency === "INR" ? "₹" : "$";
  const url = cfg.BOT_USERNAME ? `https://t.me/${cfg.BOT_USERNAME}?start=p_${p.slug}` : undefined;

  const rows = await prisma.productWatch.findMany({
    where: { productId, type: "PRICE_DROP" },
    include: { user: { select: { telegramId: true, notifiable: true } } },
  });
  let sent = 0;
  const hit: string[] = [];
  for (const r of rows) {
    const base = r.basePriceMinor;
    // Only tell them if it actually dropped below what they were watching.
    if (base !== null && base !== undefined && newMinor >= base) continue;
    if (!r.user.telegramId || !r.user.notifiable) continue;
    const saved = base ? base - newMinor : 0;
    await enqueueTelegramMessage(
      r.user.telegramId,
      [
        "📉 <b>PRICE DROPPED!</b>",
        "",
        `${p.iconEmoji ? `${p.iconEmoji} ` : ""}<b>${esc(p.name)}</b>`,
        base ? `❌ <s>${sym}${(base / 100).toFixed(2)}</s>  ➡️  ✅ <b>${sym}${(newMinor / 100).toFixed(2)}</b>` : `✅ Now <b>${sym}${(newMinor / 100).toFixed(2)}</b>`,
        saved > 0 ? `💰 You save <b>${sym}${(saved / 100).toFixed(2)}</b>` : "",
        "",
        "🔔 You asked to be told when this got cheaper.",
      ].filter(Boolean).join("\n"),
      url ? { buttons: [{ text: `⚡ Buy at ${sym}${(newMinor / 100).toFixed(2)}`, url, style: "success" }] } : {},
    ).catch(() => undefined);
    hit.push(r.id);
    sent++;
  }
  if (hit.length > 0) await prisma.productWatch.deleteMany({ where: { id: { in: hit } } });
  return sent;
}

export interface WatchRow { productId: string; name: string; type: WatchKind; basePriceMinor: number | null; currency: string | null; at: Date }

/** Everything this customer is watching, so they can review and manage it. */
export async function listWatches(userId: string): Promise<WatchRow[]> {
  const rows = await prisma.productWatch.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 30 });
  if (rows.length === 0) return [];
  const names = new Map(
    (await prisma.product.findMany({ where: { id: { in: rows.map((r) => r.productId) } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]),
  );
  return rows.map((r) => ({
    productId: r.productId,
    name: names.get(r.productId) ?? "(removed)",
    type: r.type as WatchKind,
    basePriceMinor: r.basePriceMinor,
    currency: r.currency,
    at: r.createdAt,
  }));
}
