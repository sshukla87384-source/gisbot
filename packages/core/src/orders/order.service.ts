import { loadConfig } from "@gis/config";
import { prisma, type OrderStatus } from "@gis/database";
import { CoreError, decryptSecret, effectiveHours } from "@gis/shared";

export interface OrderListItem {
  /** True when this order exists only to hold a warranty/goodwill replacement. */
  isReplacement?: boolean;
  id: string;
  orderNumber: string;
  status: OrderStatus;
  totalPaidMinor: number;
  currency: string;
  createdAt: Date;
  /** Name of the first product in the order — shown BEFORE the order number so
   *  customers recognise what they bought instead of a bare "GIS-…" code. */
  productName: string;
  /** Number of distinct lines in the order (the label adds "+N more"). */
  itemCount: number;
  /** Units of the first line, so "Netflix ×3" reads right. */
  firstQty: number;
}

/** "Netflix 1 Month ×2 +1 more" — the product-first label for an order. */
export function orderProductLabel(o: { productName: string; itemCount: number; firstQty?: number }, max = 34): string {
  let name = o.productName.trim() || "Order";
  if (name.length > max) name = name.slice(0, max - 1).trimEnd() + "…";
  const qty = o.firstQty && o.firstQty > 1 ? ` ×${o.firstQty}` : "";
  const more = o.itemCount > 1 ? ` +${o.itemCount - 1} more` : "";
  return `${name}${qty}${more}`;
}

export async function listOrders(userId: string, page: number, pageSize = 6): Promise<{
  items: OrderListItem[];
  page: number;
  pages: number;
}> {
  const total = await prisma.order.count({ where: { userId } });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const rows = await prisma.order.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * pageSize,
    take: pageSize,
    include: {
      items: { select: { productNameSnap: true, variantNameSnap: true, quantity: true }, orderBy: { id: "asc" } },
    },
  });
  return {
    items: rows.map((o) => ({
      id: o.id,
      ...(() => {
        const g = groupOrderLines(o.items);
        return { productName: firstItemName(g), itemCount: g.length, firstQty: g[0]?.quantity ?? 1 };
      })(),
      orderNumber: o.orderNumber,
      status: o.status,
      totalPaidMinor: o.subtotalMinor - o.discountMinor,
      currency: o.currency,
      createdAt: o.createdAt,
      // A replacement order is free by design; without this it showed as a
      // mysterious "$0.00" in the list with nothing to explain it.
      isReplacement: o.replacementOfOrderId !== null,
    })),
    page,
    pages,
  };
}

/**
 * Collapse order items into product lines. Keys and accounts are stored one
 * OrderItem PER UNIT, so "3 × Netflix" is three rows — counting rows made it
 * read "Netflix +2 more" as if three different products had been bought.
 */
export function groupOrderLines<T extends { productNameSnap: string; variantNameSnap?: string; quantity?: number }>(
  items: T[],
): Array<{ productNameSnap: string; variantNameSnap: string; quantity: number }> {
  const out: Array<{ productNameSnap: string; variantNameSnap: string; quantity: number }> = [];
  const at = new Map<string, number>();
  for (const it of items) {
    const v = it.variantNameSnap ?? "";
    const k = `${it.productNameSnap}\u0000${v}`;
    const idx = at.get(k);
    if (idx === undefined) { at.set(k, out.length); out.push({ productNameSnap: it.productNameSnap, variantNameSnap: v, quantity: it.quantity ?? 1 }); }
    else out[idx]!.quantity += it.quantity ?? 1;
  }
  return out;
}

/** "Product · Variant" for the first line; variant dropped when it repeats the name or is a default. */
export function firstItemName(items: Array<{ productNameSnap: string; variantNameSnap: string }>): string {
  const it = items[0];
  if (!it) return "Order";
  const v = it.variantNameSnap.trim();
  const p = it.productNameSnap.trim();
  if (!v || /^(default|standard|-)$/i.test(v) || p.toLowerCase().includes(v.toLowerCase())) return p || "Order";
  return `${p} · ${v}`;
}

export interface VaultItem {
  orderItemId: string;
  productName: string;
  variantName: string;
  fulfilledAt: Date;
  /** "Unit 2 of 5" — position among identical units of the same product. */
  unitNumber?: number;
  unitTotal?: number;
  /** Last 4 characters of the delivered value, so one unit can be told from another. */
  tail?: string | null;
  replaced?: boolean;
  replacedAt?: Date | null;
  replacedByItemId?: string | null;
  isReplacementFor?: string | null;
  warranty?: boolean;
  warrantyDaysLeft?: number | null;
  /** Precise cover left. `warrantyDaysLeft` is this rounded up to whole days. */
  warrantyHoursLeft?: number | null;
  /** When what was delivered stops working. Null = no expiry we know of. */
  expiresAt?: Date | null;
}

/** License vault — everything ever delivered to this user (Bot UX doc §7). */
export async function listVault(userId: string, page: number, pageSize = 6): Promise<{
  items: VaultItem[];
  page: number;
  pages: number;
}> {
  const where = { order: { userId }, fulfilledAt: { not: null }, deliveryPayloadEncrypted: { not: null } };
  const total = await prisma.orderItem.count({ where });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const rows = await prisma.orderItem.findMany({
    where,
    orderBy: { fulfilledAt: "desc" },
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
  return {
    items: rows.map((r) => ({
      orderItemId: r.id,
      productName: r.productNameSnap,
      variantName: r.variantNameSnap,
      fulfilledAt: r.fulfilledAt as Date,
    })),
    page,
    pages,
  };
}

/**
 * Every delivered UNIT of an order, individually.
 *
 * The data model already stores one OrderItem per unit (quantity 5 = 5 rows), but
 * this returned only the product name — so five keys rendered as five identical
 * rows and the customer could not tell them apart, let alone say which one was
 * broken. Each row now carries its unit number and the last 4 characters of the
 * delivered value, plus its replacement state.
 */
export async function listOrderItems(userId: string, orderId: string): Promise<VaultItem[]> {
  const rows = await prisma.orderItem.findMany({
    where: { orderId, order: { userId }, fulfilledAt: { not: null }, deliveryPayloadEncrypted: { not: null } },
    // Stable order, so "Unit 2" means the same unit on every render. fulfilledAt
    // alone is not stable: a batch delivered in one transaction shares a timestamp.
    orderBy: [{ fulfilledAt: "asc" }, { id: "asc" }],
    select: {
      id: true, productNameSnap: true, variantNameSnap: true, fulfilledAt: true,
      deliveryPayloadEncrypted: true, replacedAt: true, replacedByItemId: true,
      replaces: { select: { id: true, productNameSnap: true } },
      variant: { select: { product: { select: { warranty: true, warrantyDays: true, warrantyHours: true } } } },
      warrantyStartAt: true, expiresAt: true,
    },
  });
  const key = loadConfig().ENCRYPTION_MASTER_KEY;
  // Number units per product+variant, so "Unit 2 of 5" is meaningful on a mixed order.
  const seen = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.productNameSnap}|${r.variantNameSnap}`;
    totals.set(k, (totals.get(k) ?? 0) + 1);
  }
  return rows.map((r) => {
    const k = `${r.productNameSnap}|${r.variantNameSnap}`;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    let tail: string | null = null;
    try {
      const p = JSON.parse(decryptSecret(r.deliveryPayloadEncrypted as string, key)) as { key?: string; username?: string };
      const label = (p.key ? (p.key.split(/\r?\n/)[0] ?? "") : (p.username ?? "")).trim();
      tail = label.length > 4 ? label.slice(-4) : label || null;
    } catch {
      tail = null; // undecryptable payload must not break the whole order view
    }
    const prod = r.variant.product;
    const start = r.warrantyStartAt ?? r.fulfilledAt;
    const windowHours = effectiveHours(prod.warrantyHours, prod.warrantyDays);
    let warrantyHoursLeft: number | null = null;
    if (prod.warranty && windowHours && start) {
      warrantyHoursLeft = Math.max(0, Math.ceil(windowHours - (Date.now() - start.getTime()) / 3_600_000));
    }
    const warrantyDaysLeft = warrantyHoursLeft === null ? null : Math.ceil(warrantyHoursLeft / 24);
    return {
      orderItemId: r.id,
      productName: r.productNameSnap,
      variantName: r.variantNameSnap,
      fulfilledAt: r.fulfilledAt as Date,
      unitNumber: n,
      unitTotal: totals.get(k) ?? 1,
      tail,
      replaced: r.replacedAt !== null,
      replacedAt: r.replacedAt,
      replacedByItemId: r.replacedByItemId,
      /** Set when THIS unit is itself a replacement for an earlier one. */
      isReplacementFor: r.replaces?.id ?? null,
      warranty: prod.warranty,
      warrantyDaysLeft,
      warrantyHoursLeft,
      expiresAt: r.expiresAt,
    };
  });
}

export interface RevealedDelivery {
  productName: string;
  variantName: string;
  payload: { kind: string; key?: string; username?: string; password?: string; twofa?: string; expiresAt?: string };
  /** True when this unit has been superseded — the value no longer works. */
  replaced?: boolean;
  orderItemId?: string;
}

/**
 * Re-reveal a delivered secret to its owner. Ownership enforced in the query;
 * every reveal is audit-logged (Security doc §4).
 */
/**
 * The header facts for one order: its number, what it came to, and in what
 * currency. `subtotal - discount` is used rather than wallet+total+bnpl because
 * it is the one figure that is the same on every rail — a BNPL order carries
 * its money in bnplMinor and leaves totalMinor at 0, which is how Pay Later
 * orders came to be shown as zero elsewhere.
 */
export async function getOrderSummary(
  userId: string,
  orderId: string,
): Promise<{ orderNumber: string; totalMinor: number; currency: string; productName: string; itemCount: number; firstQty: number } | null> {
  const o = await prisma.order.findFirst({
    where: { id: orderId, userId },
    select: {
      orderNumber: true, subtotalMinor: true, discountMinor: true, currency: true,
      items: { select: { productNameSnap: true, variantNameSnap: true, quantity: true }, orderBy: { id: "asc" } },
    },
  });
  if (!o) return null;
  return {
    orderNumber: o.orderNumber, totalMinor: Math.max(0, o.subtotalMinor - o.discountMinor), currency: o.currency,
    ...(() => {
      const g = groupOrderLines(o.items);
      return { productName: firstItemName(g), itemCount: g.length, firstQty: g[0]?.quantity ?? 1 };
    })(),
  };
}

export async function revealOrderDeliveries(userId: string, orderId: string): Promise<RevealedDelivery[]> {
  const items = await prisma.orderItem.findMany({
    where: { orderId, order: { userId }, fulfilledAt: { not: null }, deliveryPayloadEncrypted: { not: null } },
    orderBy: [{ fulfilledAt: "asc" }, { id: "asc" }],
  });
  const key = loadConfig().ENCRYPTION_MASTER_KEY;
  // `replaced` is carried through so a retired key is LABELLED rather than mixed
  // in silently. For orders over 10 units this is the only way the customer sees
  // their keys, so handing back a dead one unmarked was the worst version of the
  // confusion this rewrite exists to remove.
  return items.map((i) => ({
    productName: i.productNameSnap,
    variantName: i.variantNameSnap,
    payload: JSON.parse(decryptSecret(i.deliveryPayloadEncrypted as string, key)) as RevealedDelivery["payload"],
    replaced: i.replacedAt !== null,
    orderItemId: i.id,
  }));
}

export async function revealDelivery(userId: string, orderItemId: string): Promise<RevealedDelivery> {
  const item = await prisma.orderItem.findFirst({
    where: { id: orderItemId, order: { userId } },
  });
  if (!item || !item.deliveryPayloadEncrypted) throw new CoreError("ORDER_NOT_FOUND");

  const payload = JSON.parse(
    decryptSecret(item.deliveryPayloadEncrypted, loadConfig().ENCRYPTION_MASTER_KEY),
  ) as RevealedDelivery["payload"];

  await prisma.auditLog.create({
    data: {
      actorId: userId,
      actorType: "USER",
      action: "delivery.reveal",
      entityType: "OrderItem",
      entityId: orderItemId,
    },
  });

  return { productName: item.productNameSnap, variantName: item.variantNameSnap, payload };
}


/** Everything /track shows for one order — statuses and names only, never a delivered value. */
export async function getOrderTracking(userId: string, orderNumber: string) {
  return prisma.order.findFirst({
    where: { orderNumber, userId },
    select: {
      orderNumber: true, status: true, createdAt: true, paidAt: true, currency: true, subtotalMinor: true, discountMinor: true, walletUsedMinor: true, bnplMinor: true,
      items: { select: { productNameSnap: true, variantNameSnap: true, quantity: true, fulfilledAt: true, expiresAt: true }, orderBy: { id: "asc" } },
      payments: { select: { provider: true, status: true }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
}
