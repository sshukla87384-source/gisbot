import { loadConfig } from "@gis/config";
import { prisma, type OrderStatus } from "@gis/database";
import { CoreError, decryptSecret } from "@gis/shared";

export interface OrderListItem {
  /** True when this order exists only to hold a warranty/goodwill replacement. */
  isReplacement?: boolean;
  id: string;
  orderNumber: string;
  status: OrderStatus;
  totalPaidMinor: number;
  currency: string;
  createdAt: Date;
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
  });
  return {
    items: rows.map((o) => ({
      id: o.id,
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
      variant: { select: { product: { select: { warranty: true, warrantyDays: true } } } },
      warrantyStartAt: true,
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
    let warrantyDaysLeft: number | null = null;
    if (prod.warranty && prod.warrantyDays && start) {
      warrantyDaysLeft = Math.max(0, Math.ceil(prod.warrantyDays - (Date.now() - start.getTime()) / 86_400_000));
    }
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
    };
  });
}

export interface RevealedDelivery {
  productName: string;
  variantName: string;
  payload: { kind: string; key?: string; username?: string; password?: string; expiresAt?: string };
  /** True when this unit has been superseded — the value no longer works. */
  replaced?: boolean;
}

/**
 * Re-reveal a delivered secret to its owner. Ownership enforced in the query;
 * every reveal is audit-logged (Security doc §4).
 */
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
