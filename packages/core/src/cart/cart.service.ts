import { prisma, type Currency } from "@gis/database";
import { CoreError } from "@gis/shared";
import { priceInCurrency } from "../pricing.js";

export interface CartLine {
  itemId: string;
  variantId: string;
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
}

async function getOrCreateCart(userId: string) {
  return prisma.cart.upsert({ where: { userId }, create: { userId }, update: {} });
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
  await prisma.cartItem.upsert({
    where: { cartId_variantId: { cartId: cart.id, variantId } },
    create: { cartId: cart.id, variantId, quantity },
    update: { quantity: { increment: quantity } },
  });
}

export async function changeQty(userId: string, itemId: string, delta: number): Promise<void> {
  const item = await prisma.cartItem.findFirst({
    where: { id: itemId, cart: { userId } },
  });
  if (!item) return;
  const next = item.quantity + delta;
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
  if (cart) await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
}

export async function getCartView(userId: string, currency: Currency): Promise<CartView> {
  const cart = await prisma.cart.findUnique({
    where: { userId },
    include: {
      items: {
        orderBy: { addedAt: "asc" },
        include: {
          variant: {
            include: {
              product: { select: { name: true, status: true, type: true, deletedAt: true } },
              prices: { where: { tier: { name: "RETAIL" } } },
            },
          },
        },
      },
    },
  });

  const lines: CartLine[] = (cart?.items ?? []).map((item) => {
    const price = priceInCurrency(item.variant.prices, currency);
    const available =
      item.variant.isActive &&
      item.variant.deletedAt === null &&
      item.variant.product.status === "ACTIVE" &&
      item.variant.product.deletedAt === null &&
      price !== null;
    return {
      itemId: item.id,
      variantId: item.variantId,
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
  };
}
