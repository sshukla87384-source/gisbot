import { prisma } from "@gis/database";

/**
 * How long a checkout / delivery transaction may run. Every unit of a key or
 * account product is its own order line with its own stock row, so a 700-unit
 * order does thousands of writes — the old flat 15 s budget aborted it half
 * way. 15 s plus ~0.12 s a unit, capped at 5 minutes.
 */
export function txTimeoutForUnits(units: number, base = 15_000): number {
  return Math.min(300_000, base + Math.max(0, Math.round(units || 0)) * 120);
}

/** Units in a customer's cart (what a checkout is about to create). */
export async function cartUnitsFor(userId: string): Promise<number> {
  const r = await prisma.cartItem.aggregate({ where: { cart: { userId } }, _sum: { quantity: true } }).catch(() => null);
  return r?._sum.quantity ?? 0;
}

/** Lines on an existing order (what a payment confirmation is about to deliver). */
export async function orderUnitsFor(orderId: string): Promise<number> {
  return prisma.orderItem.count({ where: { orderId } }).catch(() => 0);
}
