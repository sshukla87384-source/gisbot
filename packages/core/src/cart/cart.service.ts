import { convertMinor } from "../fx.js";
import { prisma, type Currency } from "@gis/database";
import { CoreError } from "@gis/shared";
import { effectivePriceMinor } from "../pricing.js";
import { stockMapFor, UNLIMITED_STOCK } from "../catalog/catalog.service.js";

export interface CartLine {
  itemId: string;
  variantId: string;
  /** Carried so a PRODUCT/CATEGORY-scoped coupon can tell which lines it covers. */
  productId: string;
  categoryId: string;
  productName: string;
  variantName: string;
  quantity: number;
  unitPriceMinor: number | null; // null = no price row in this currency
  lineTotalMinor: number | null;
  available: boolean;
}

export interface CartView {
  lines: CartLine[];
  subtotalMinor: number;
  currency: Currency;
  allAvailable: boolean;
  /** true when at least one line uses this customer's personal price. */
  hasCustomPrice: boolean;
}

async function getOrCreateCart(userId: string) {
  return prisma.cart.upsert({ where: { userId }, create: { userId }, update: {} });
}

/** Units a customer can actually buy of one variant right now (UNLIMITED_STOCK when not counted). */
async function unitsAvailable(variantId: string): Promise<number> {
  const v = await prisma.productVariant.findUnique({
    where: { id: variantId },
    select: { product: { select: { id: true, type: true, supplierId: true, supplierStock: true, reusableSecretEnc: true, reusableStock: true, fulfillmentMode: true, manualStock: true } } },
  });
  if (!v) return 0;
  const p = v.product;
  const map = await stockMapFor([{
    id: p.id, type: p.type, supplierId: p.supplierId, supplierStock: p.supplierStock,
    reusable: p.reusableSecretEnc !== null, reusableStock: p.reusableStock,
    manual: p.fulfillmentMode === "MANUAL", manualStock: p.manualStock, variantIds: [variantId],
  }]);
  return map.get(variantId) ?? UNLIMITED_STOCK;
}

export async function addToCart(userId: string, variantId: string, quantity = 1): Promise<void> {
  const variant = await prisma.productVariant.findFirst({
    where: { id: variantId, isActive: true, deletedAt: null },
    include: { product: { select: { status: true, deletedAt: true } } },
  });
  if (!variant || variant.product.status !== "ACTIVE" || variant.product.deletedAt !== null) {
    throw new CoreError("VARIANT_NOT_FOUND");
  }
  const cart = await getOrCreateCart(userId);
  // Never more in the cart than can be delivered: a cart of 10 when 3 keys
  // were left took the money for 10 and parked 7 as "awaiting stock".
  const units = await unitsAvailable(variantId);
  if (units <= 0) throw new CoreError("OUT_OF_STOCK");
  const existing = await prisma.cartItem.findUnique({ where: { cartId_variantId: { cartId: cart.id, variantId } }, select: { quantity: true } });
  const target = Math.min((existing?.quantity ?? 0) + Math.max(1, quantity), units);
  if (existing && target <= existing.quantity) throw new CoreError("OUT_OF_STOCK", `Only ${units} available — all of them are already in your cart.`);
  await prisma.cartItem.upsert({
    where: { cartId_variantId: { cartId: cart.id, variantId } },
    create: { cartId: cart.id, variantId, quantity: target },
    update: { quantity: target },
  });
}

export async function changeQty(userId: string, itemId: string, delta: number): Promise<void> {
  const item = await prisma.cartItem.findFirst({
    where: { id: itemId, cart: { userId } },
  });
  if (!item) return;
  const next = item.quantity + delta;
  if (delta > 0) {
    const units = await unitsAvailable(item.variantId);
    if (next > units) throw new CoreError("OUT_OF_STOCK", `Only ${Math.max(0, units)} available.`);
  }
  if (next <= 0) {
    await prisma.cartItem.delete({ where: { id: item.id } });
  } else {
    await prisma.cartItem.update({ where: { id: item.id }, data: { quantity: next } });
  }
}

export async function removeItem(userId: string, itemId: string): Promise<void> {
  await prisma.cartItem.deleteMany({ where: { id: itemId, cart: { userId } } });
}

export async function clearCart(userId: string): Promise<void> {
  const cart = await prisma.cart.findUnique({ where: { userId } });
  if (!cart) return;
  await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
  // A coupon belongs to the cart it was applied to; an empty cart has none.
  if (cart.couponId) await prisma.cart.update({ where: { id: cart.id }, data: { couponId: null } }).catch(() => undefined);
}

/**
 * `channel` picks which per-user price overrides apply, exactly as `priceCart`
 * does on the checkout side. It defaults to DIRECT so every existing bot caller
 * keeps the prices it always showed; an API caller passes "API" and gets the
 * prices it will actually be charged, instead of the bot's.
 */
export async function getCartView(userId: string, currency: Currency, channel: "DIRECT" | "API" = "DIRECT"): Promise<CartView> {
  const cart = await prisma.cart.findUnique({
    where: { userId },
    include: {
      items: {
        orderBy: { addedAt: "asc" },
        include: {
          variant: {
            include: {
              product: true,
              prices: { where: { currency, tier: { name: "RETAIL" } } },
            },
          },
        },
      },
    },
  });

  // Per-user custom price overrides (the channel-specific one beats BOTH),
  // applied to the shown/charged price.
  const productIds = (cart?.items ?? []).map((i) => i.variant.productId);
  const overrides = await prisma.userPrice.findMany({ where: { userId, productId: { in: productIds }, channel: { in: [channel, "BOTH"] } } });
  const overrideByProduct = new Map<string, number>();
  for (const o of overrides) {
    const amt = o.currency === currency ? o.amountMinor : convertMinor(o.amountMinor, o.currency as Currency, currency);
    const cur = overrideByProduct.get(o.productId);
    if (cur === undefined || o.channel === channel) overrideByProduct.set(o.productId, amt);
  }

  const lines: CartLine[] = (cart?.items ?? []).map((item) => {
    const base = item.variant.prices[0]?.amountMinor ?? null;
    const override = overrideByProduct.get(item.variant.productId);
    const price = base === null ? null : (override ?? effectivePriceMinor(base, item.variant.product, new Date(), item.quantity));
    const available =
      item.variant.isActive &&
      item.variant.deletedAt === null &&
      item.variant.product.status === "ACTIVE" &&
      item.variant.product.deletedAt === null &&
      price !== null;
    return {
      itemId: item.id,
      variantId: item.variantId,
      productId: item.variant.productId,
      categoryId: item.variant.product.categoryId,
      productName: item.variant.product.name,
      variantName: item.variant.name,
      quantity: item.quantity,
      unitPriceMinor: price,
      lineTotalMinor: price === null ? null : price * item.quantity,
      available,
    };
  });

  return {
    lines,
    subtotalMinor: lines.reduce((sum, l) => sum + (l.lineTotalMinor ?? 0), 0),
    currency,
    allAvailable: lines.length > 0 && lines.every((l) => l.available),
    hasCustomPrice: (cart?.items ?? []).some((it) => overrideByProduct.has(it.variant.productId)),
  };
}
