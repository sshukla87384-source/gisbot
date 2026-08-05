import { prisma } from "@gis/database";
import type { Currency } from "@gis/database";
import { convertMinor, priceUsdFromInr } from "./fx.js";
import { enqueueTelegramMessage } from "./queues.js";

/**
 * Daily statement for API users (resellers).
 *
 * An honest scope note, because it decides everything below: we do NOT know
 * what a reseller charges their own customers, so we cannot report their actual
 * profit. Claiming to would be making a number up.
 *
 * What we do know exactly:
 *   • what they spent with us
 *   • our public price for the same goods
 *   • the gap between the two — their real, earned buying advantage
 *
 * So the report leads with spend and the special-pricing benefit (fact), and
 * presents margin as "if you resell at our public price" (clearly labelled as
 * a benchmark, not their books).
 */

export interface ResellerDay {
  userId: string;
  telegramId: bigint | null;
  currency: Currency;
  orders: number;
  units: number;
  /** What they paid us, in their own currency. */
  spentMinor: number;
  /** Our public price for the same items, same currency. */
  publicValueMinor: number;
  /** publicValueMinor − spentMinor: what their pricing saved them today. */
  benefitMinor: number;
  /** Margin if they resell at our public price. A benchmark, not their books. */
  benchmarkMarginBp: number | null;
  /** Products with a custom price for them, and how much below public it is. */
  deals: Array<{ name: string; yourMinor: number; publicMinor: number; offBp: number }>;
  topProducts: Array<{ name: string; units: number; spentMinor: number }>;
}

/** Public retail price of a product in a currency, surcharge-aware for INR. */
async function publicPriceOf(productId: string, currency: Currency): Promise<number | null> {
  const v = await prisma.productVariant.findFirst({
    where: { productId, isActive: true, deletedAt: null },
    orderBy: { sortOrder: "asc" },
    select: { prices: { where: { tier: { name: "RETAIL" } }, select: { amountMinor: true, currency: true } } },
  });
  if (!v) return null;
  const exact = v.prices.find((p) => p.currency === currency);
  if (exact) return exact.amountMinor;
  const other = v.prices[0];
  if (!other) return null;
  // Cross-currency: use the PRICE conversion, so the comparison is against what
  // a normal customer would actually be charged, surcharge included.
  if (currency === "USD" && other.currency === "INR") return priceUsdFromInr(other.amountMinor);
  return convertMinor(other.amountMinor, other.currency as Currency, currency);
}

/** One reseller's day. Returns null when they bought nothing — no empty spam. */
export async function resellerDay(userId: string, hours = 24): Promise<ResellerDay | null> {
  const since = new Date(Date.now() - hours * 3_600_000);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { telegramId: true, currency: true },
  });
  if (!user) return null;
  const currency = user.currency as Currency;

  const items = await prisma.orderItem.findMany({
    where: {
      fulfilledAt: { gte: since },
      order: { userId, status: { in: ["COMPLETED", "PAID", "PENDING_FULFILLMENT", "PARTIALLY_REFUNDED"] } },
    },
    select: {
      quantity: true,
      totalMinor: true,
      productNameSnap: true,
      orderId: true,
      order: { select: { currency: true } },
      variant: { select: { productId: true } },
    },
    take: 5_000,
  });
  if (items.length === 0) return null;

  const orderIds = new Set<string>();
  let spent = 0;
  let units = 0;
  let publicValue = 0;
  const byProduct = new Map<string, { name: string; units: number; spentMinor: number }>();
  const publicCache = new Map<string, number | null>();

  for (const it of items) {
    orderIds.add(it.orderId);
    const paid = convertMinor(it.totalMinor, it.order.currency as Currency, currency);
    spent += paid;
    units += it.quantity;

    const pid = it.variant.productId;
    if (!publicCache.has(pid)) publicCache.set(pid, await publicPriceOf(pid, currency));
    const pub = publicCache.get(pid) ?? null;
    // No public price to compare against → count their own price, so the
    // benefit figure can never be inflated by a missing comparison.
    publicValue += pub === null ? paid : pub * Math.max(1, it.quantity);

    const row = byProduct.get(pid) ?? { name: it.productNameSnap, units: 0, spentMinor: 0 };
    row.units += it.quantity;
    row.spentMinor += paid;
    byProduct.set(pid, row);
  }

  // Their standing special prices, whether or not they bought them today.
  const overrides = await prisma.userPrice.findMany({
    where: { userId, channel: { in: ["BOTH", "API"] } },
    select: { productId: true, amountMinor: true, currency: true },
    take: 50,
  });
  const deals: ResellerDay["deals"] = [];
  for (const o of overrides) {
    const pub = await publicPriceOf(o.productId, currency);
    if (pub === null || pub <= 0) continue;
    const yours = convertMinor(o.amountMinor, o.currency as Currency, currency);
    if (yours >= pub) continue; // not actually a discount
    const p = await prisma.product.findUnique({ where: { id: o.productId }, select: { name: true } });
    deals.push({ name: p?.name ?? "Product", yourMinor: yours, publicMinor: pub, offBp: Math.round(((pub - yours) / pub) * 10_000) });
  }
  deals.sort((a, b) => b.offBp - a.offBp);

  return {
    userId,
    telegramId: user.telegramId,
    currency,
    orders: orderIds.size,
    units,
    spentMinor: spent,
    publicValueMinor: publicValue,
    benefitMinor: publicValue - spent,
    benchmarkMarginBp: publicValue > 0 ? Math.round(((publicValue - spent) / publicValue) * 10_000) : null,
    deals: deals.slice(0, 8),
    topProducts: [...byProduct.values()].sort((a, b) => b.spentMinor - a.spentMinor).slice(0, 5),
  };
}

function money(minor: number, currency: Currency): string {
  const v = (minor / 100).toFixed(2);
  return currency === "INR" ? `₹${v}` : `$${v}`;
}

export function renderResellerDay(d: ResellerDay): string {
  const pct = (bp: number | null): string => (bp === null ? "—" : `${(bp / 100).toFixed(1)}%`);
  return [
    "📊 <b>Your daily statement</b>",
    "<i>Last 24 hours</i>",
    "",
    `🧾 Orders: <b>${d.orders}</b>   ·   📦 Units: <b>${d.units}</b>`,
    `💸 You spent: <b>${money(d.spentMinor, d.currency)}</b>`,
    `🏷 Same goods at our public price: <b>${money(d.publicValueMinor, d.currency)}</b>`,
    "",
    ...(d.benefitMinor > 0
      ? [
          `🎁 <b>Your pricing saved you ${money(d.benefitMinor, d.currency)} today.</b>`,
          `📈 If you resell at our public price, that's a <b>${pct(d.benchmarkMarginBp)}</b> margin.`,
          "",
          "<i>We can't see what you charge your own customers, so the margin above is a benchmark against our public price — not your actual books.</i>",
        ]
      : ["<i>No special-pricing benefit on today's orders — you paid our public rate.</i>"]),
    ...(d.topProducts.length > 0
      ? ["", "<b>Your top products today</b>", ...d.topProducts.map((p) => `• ${p.name.slice(0, 26)} — ${p.units}× · ${money(p.spentMinor, d.currency)}`)]
      : []),
    ...(d.deals.length > 0
      ? [
          "",
          `💎 <b>Your special rates</b> (${d.deals.length})`,
          ...d.deals.slice(0, 5).map((x) => `• ${x.name.slice(0, 24)} — <b>${money(x.yourMinor, d.currency)}</b> vs ${money(x.publicMinor, d.currency)} public <i>(${pct(x.offBp)} off)</i>`),
        ]
      : []),
    "",
    "🔑 Full figures any time via <code>GET /api/v1/developer/stats</code>.",
  ].join("\n");
}

/**
 * Send every active API user their statement. Called once a day by cron.
 * Anyone who bought nothing is skipped — a daily "you did nothing" message is
 * how you get muted.
 */
export async function sendResellerStatements(): Promise<{ sent: number; skipped: number }> {
  const keys = await prisma.apiKey.findMany({
    where: { revokedAt: null, ownerUserId: { not: null } },
    select: { ownerUserId: true },
  });
  const userIds = [...new Set(keys.map((k) => k.ownerUserId).filter((x): x is string => Boolean(x)))];

  let sent = 0;
  let skipped = 0;
  for (const userId of userIds) {
    const d = await resellerDay(userId).catch(() => null);
    if (!d || !d.telegramId) { skipped++; continue; }
    await enqueueTelegramMessage(d.telegramId, renderResellerDay(d), {
      buttons: [
        { text: "🔑 My API keys", callbackData: "api:list", style: "primary" },
        { text: "🛍 Shop", callbackData: "shp:home:1", style: "success" },
      ],
    }).catch(() => undefined);
    sent++;
  }
  return { sent, skipped };
}
