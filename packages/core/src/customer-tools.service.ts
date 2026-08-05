import { prisma } from "@gis/database";
import { cached } from "./redis.js";
import { effectivePriceMinor, isSaleActive } from "./pricing.js";
import type { Currency } from "@gis/database";

/* ── Buy again ────────────────────────────────────────────────────────────── */

export interface ReorderLine { variantId: string; productName: string; variantName: string; quantity: number }

/** The variants from a past order, so the customer can repeat it in one tap. */
export async function reorderLines(userId: string, orderId: string): Promise<ReorderLine[]> {
  const items = await prisma.orderItem.findMany({
    where: { orderId, order: { userId } },
    select: { variantId: true, productNameSnap: true, variantNameSnap: true, quantity: true },
  });
  const merged = new Map<string, ReorderLine>();
  for (const it of items) {
    const cur = merged.get(it.variantId);
    if (cur) cur.quantity += it.quantity;
    else merged.set(it.variantId, { variantId: it.variantId, productName: it.productNameSnap, variantName: it.variantNameSnap, quantity: it.quantity });
  }
  // Only offer variants that still exist and are on sale-able products.
  const ids = [...merged.keys()];
  if (ids.length === 0) return [];
  const live = await prisma.productVariant.findMany({
    where: { id: { in: ids }, isActive: true, deletedAt: null, product: { status: "ACTIVE", deletedAt: null } },
    select: { id: true },
  });
  const liveIds = new Set(live.map((v) => v.id));
  return [...merged.values()].filter((l) => liveIds.has(l.variantId));
}

/* ── Today's deals ────────────────────────────────────────────────────────── */

export interface DealItem { id: string; name: string; iconEmoji: string | null; fromPriceMinor: number | null; wasMinor: number | null; tag: "SALE" | "RESTOCK" | "NEW" }

/** On sale, freshly restocked and newly added — one screen, cached briefly. */
export async function todaysDeals(currency: Currency, limit = 12): Promise<DealItem[]> {
  return cached(`deals:${currency}:${limit}`, 120, async () => {
    const since = new Date(Date.now() - 3 * 86_400_000);
    const products = await prisma.product.findMany({
      where: {
        status: "ACTIVE",
        deletedAt: null,
        OR: [{ salePercentBp: { not: null } }, { announcedAt: { gte: since } }, { createdAt: { gte: since } }],
      },
      orderBy: [{ salePercentBp: "desc" }, { createdAt: "desc" }],
      take: limit,
      include: { variants: { where: { isActive: true, deletedAt: null }, include: { prices: { where: { currency, tier: { name: "RETAIL" } } } } } },
    });
    const out: DealItem[] = [];
    for (const p of products) {
      const base = p.variants.flatMap((v) => v.prices.map((x) => x.amountMinor));
      if (base.length === 0) continue;
      const cheapest = Math.min(...base);
      const onSale = isSaleActive(p);
      out.push({
        id: p.id,
        name: p.name,
        iconEmoji: p.iconEmoji,
        fromPriceMinor: effectivePriceMinor(cheapest, p),
        wasMinor: onSale ? cheapest : null,
        tag: onSale ? "SALE" : p.createdAt >= since ? "NEW" : "RESTOCK",
      });
    }
    return out;
  });
}

/* ── Search my keys ───────────────────────────────────────────────────────── */

export interface MyKeyRow { orderItemId: string; productName: string; variantName: string; orderNumber: string; at: Date }

/** Search the customer's OWN delivered items by product name. */
export async function searchMyKeys(userId: string, query: string, limit = 12): Promise<MyKeyRow[]> {
  const q = query.trim();
  const rows = await prisma.orderItem.findMany({
    where: {
      order: { userId },
      fulfilledAt: { not: null },
      deliveryPayloadEncrypted: { not: null },
      ...(q ? { productNameSnap: { contains: q, mode: "insensitive" } } : {}),
    },
    orderBy: { fulfilledAt: "desc" },
    take: limit,
    select: { id: true, productNameSnap: true, variantNameSnap: true, fulfilledAt: true, order: { select: { orderNumber: true } } },
  });
  return rows.map((r) => ({
    orderItemId: r.id,
    productName: r.productNameSnap,
    variantName: r.variantNameSnap,
    orderNumber: r.order.orderNumber,
    at: r.fulfilledAt as Date,
  }));
}
