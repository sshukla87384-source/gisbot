import { loadConfig } from "@gis/config";
import { prisma, type OrderStatus } from "@gis/database";
import { CoreError, decryptSecret } from "@gis/shared";

export interface OrderListItem {
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

export async function listOrderItems(userId: string, orderId: string): Promise<VaultItem[]> {
  const rows = await prisma.orderItem.findMany({
    where: { orderId, order: { userId }, fulfilledAt: { not: null }, deliveryPayloadEncrypted: { not: null } },
    orderBy: { fulfilledAt: "desc" },
  });
  return rows.map((r) => ({
    orderItemId: r.id, productName: r.productNameSnap, variantName: r.variantNameSnap, fulfilledAt: r.fulfilledAt as Date,
  }));
}

export interface RevealedDelivery {
  productName: string;
  variantName: string;
  payload: { kind: string; key?: string; username?: string; password?: string; expiresAt?: string };
}

/**
 * Re-reveal a delivered secret to its owner. Ownership enforced in the query;
 * every reveal is audit-logged (Security doc §4).
 */
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
