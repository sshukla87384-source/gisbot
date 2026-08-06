import { prisma } from "@gis/database";
import type { Currency } from "@gis/database";
import { convertMinor, priceInrFromUsd, priceUsdFromInr } from "./fx.js";
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

/**
 * Public retail prices for many VARIANTS at once.
 *
 * Two bugs are fixed by keying on the variant rather than the product: the old
 * version benchmarked every purchase against the product's FIRST variant, so a
 * reseller buying the 12-month tier was compared to the 1-month public price and
 * their real discount showed as a negative benefit. And it was one query per
 * product plus two per override — ~130 sequential round trips per reseller.
 */
async function publicPriceMap(variantIds: string[], currency: Currency): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (variantIds.length === 0) return out;
  const rows = await prisma.variantPrice.findMany({
    where: { variantId: { in: variantIds }, tier: { name: "RETAIL" } },
    select: { variantId: true, amountMinor: true, currency: true },
  });
  const byVariant = new Map<string, Array<{ amountMinor: number; currency: string }>>();
  for (const r of rows) {
    const list = byVariant.get(r.variantId) ?? [];
    list.push({ amountMinor: r.amountMinor, currency: r.currency });
    byVariant.set(r.variantId, list);
  }
  for (const [vid, list] of byVariant) {
    const exact = list.find((p) => p.currency === currency);
    if (exact) { out.set(vid, exact.amountMinor); continue; }
    const other = list[0];
    if (!other) continue;
    // Cross-currency: use the PRICE conversion in BOTH directions, so the
    // benchmark is what a normal customer would actually be charged — surcharge
    // included. Plain convertMinor omitted it one way round.
    out.set(
      vid,
      currency === "USD" && other.currency === "INR"
        ? priceUsdFromInr(other.amountMinor)
        : currency === "INR" && other.currency === "USD"
          ? priceInrFromUsd(other.amountMinor)
          : convertMinor(other.amountMinor, other.currency as Currency, currency),
    );
  }
  return out;
}

/** Cheapest active variant per product — used for standing special rates, which are per PRODUCT. */
async function productBenchmark(productIds: string[], currency: Currency): Promise<Map<string, { priceMinor: number; name: string }>> {
  const out = new Map<string, { priceMinor: number; name: string }>();
  if (productIds.length === 0) return out;
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, name: true, variants: { where: { isActive: true, deletedAt: null }, select: { id: true } } },
  });
  const allVariantIds = products.flatMap((p) => p.variants.map((v) => v.id));
  const prices = await publicPriceMap(allVariantIds, currency);
  for (const p of products) {
    const vals = p.variants.map((v) => prices.get(v.id)).filter((n): n is number => typeof n === "number" && n > 0);
    if (vals.length === 0) continue;
    out.set(p.id, { priceMinor: Math.min(...vals), name: p.name });
  }
  return out;
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
      // A warranty replacement is not a purchase: zero spend but a full public
      // price, so it fabricated "savings" the reseller never earned.
      order: { userId, status: { in: ["COMPLETED", "PAID", "PENDING_FULFILLMENT", "PARTIALLY_REFUNDED"] }, replacementOfOrderId: null },
    },
    select: {
      quantity: true,
      totalMinor: true,
      productNameSnap: true,
      orderId: true,
      variantId: true,
      order: { select: { currency: true } },
      variant: { select: { productId: true } },
    },
    take: 5_000,
  });
  if (items.length === 0) return null;

  // Their standing special prices, whether or not they bought them today.
  const overrides = await prisma.userPrice.findMany({
    where: { userId, channel: { in: ["BOTH", "API"] } },
    select: { productId: true, amountMinor: true, currency: true },
    take: 50,
  });

  // Two batched lookups instead of ~130 sequential ones.
  const [variantPrices, productPrices] = await Promise.all([
    publicPriceMap([...new Set(items.map((i) => i.variantId))], currency),
    productBenchmark([...new Set(overrides.map((o) => o.productId))], currency),
  ]);

  const orderIds = new Set<string>();
  let spent = 0;
  let units = 0;
  let publicValue = 0;
  const byProduct = new Map<string, { name: string; units: number; spentMinor: number }>();

  for (const it of items) {
    orderIds.add(it.orderId);
    const paid = convertMinor(it.totalMinor, it.order.currency as Currency, currency);
    spent += paid;
    units += it.quantity;

    // Benchmarked against the VARIANT they actually bought, not the product's
    // first variant — that compared a 12-month purchase to a 1-month price.
    const pub = variantPrices.get(it.variantId) ?? null;
    // No public price to compare against → count their own price, so the
    // benefit figure can never be inflated by a missing comparison.
    publicValue += pub === null ? paid : pub * Math.max(1, it.quantity);

    const pid = it.variant.productId;
    const row = byProduct.get(pid) ?? { name: it.productNameSnap, units: 0, spentMinor: 0 };
    row.units += it.quantity;
    row.spentMinor += paid;
    byProduct.set(pid, row);
  }

  const deals: ResellerDay["deals"] = [];
  for (const o of overrides) {
    const bench = productPrices.get(o.productId);
    if (!bench || bench.priceMinor <= 0) continue;
    const yours = convertMinor(o.amountMinor, o.currency as Currency, currency);
    if (yours >= bench.priceMinor) continue; // not actually a discount
    deals.push({
      name: bench.name,
      yourMinor: yours,
      publicMinor: bench.priceMinor,
      offBp: Math.round(((bench.priceMinor - yours) / bench.priceMinor) * 10_000),
    });
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
export async function sendResellerStatements(): Promise<{ sent: number; skipped: number; failed: number }> {
  const keys = await prisma.apiKey.findMany({
    where: { revokedAt: null, ownerUserId: { not: null } },
    select: { ownerUserId: true },
  });
  const userIds = [...new Set(keys.map((k) => k.ownerUserId).filter((x): x is string => Boolean(x)))];

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const userId of userIds) {
    // Distinguish "bought nothing" from "the report threw" — the old catch
    // reported a real failure as a skip, so a broken statement was invisible.
    let d: ResellerDay | null = null;
    try {
      d = await resellerDay(userId);
    } catch (e) {
      failed++;
      // eslint-disable-next-line no-console
      console.error("reseller statement failed", { userId, error: String(e).slice(0, 200) });
      continue;
    }
    if (!d || !d.telegramId) { skipped++; continue; }
    await enqueueTelegramMessage(d.telegramId, renderResellerDay(d), {
      buttons: [
        { text: "🔑 My API keys", callbackData: "api:list", style: "primary" },
        { text: "🛍 Shop", callbackData: "shp:home:1", style: "success" },
      ],
    }).catch(() => undefined);
    sent++;
  }
  return { sent, skipped, failed };
}
