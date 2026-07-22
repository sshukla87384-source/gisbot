import { prisma, type Currency, type Prisma } from "@gis/database";
import { getCartView } from "../cart/cart.service.js";

export interface CouponResult {
  ok: boolean;
  reason?: string;
  code?: string;
  discountMinor?: number;
}

type Tx = Prisma.TransactionClient;

export function couponReason(reason: string): string {
  const m: Record<string, string> = {
    INVALID: "That coupon code isn't valid.",
    EXPIRED: "This coupon has expired.",
    NOT_STARTED: "This coupon isn't active yet.",
    NOT_APPLICABLE: "This coupon can't be used on your cart.",
    MIN_CART: "Your cart is below this coupon's minimum.",
    USED_UP: "This coupon has reached its usage limit.",
    ALREADY_USED: "You've already used this coupon.",
    FIRST_ONLY: "This coupon is for first purchases only.",
    CURRENCY: "This coupon is for a different currency.",
    NO_DISCOUNT: "This coupon gives no discount on your cart.",
    EMPTY_CART: "Your cart is empty.",
  };
  return m[reason] ?? "This coupon can't be applied.";
}

interface CouponRow {
  id: string; code: string; type: string; scope: string;
  valueMinor: number | null; valuePct: number | null; maxDiscountMinor: number | null;
  currency: Currency | null; minCartMinor: number; firstPurchaseOnly: boolean;
  usageLimit: number | null; perUserLimit: number; usedCount: number;
  isActive: boolean; startsAt: Date | null; expiresAt: Date | null; deletedAt: Date | null;
}

async function evaluate(c: CouponRow | null, userId: string, currency: Currency, subtotalMinor: number): Promise<CouponResult> {
  if (!c || !c.isActive || c.deletedAt) return { ok: false, reason: "INVALID" };
  const now = new Date();
  if (c.startsAt && c.startsAt > now) return { ok: false, reason: "NOT_STARTED" };
  if (c.expiresAt && c.expiresAt < now) return { ok: false, reason: "EXPIRED" };
  if (c.scope !== "GLOBAL") return { ok: false, reason: "NOT_APPLICABLE" };
  if (subtotalMinor <= 0) return { ok: false, reason: "EMPTY_CART" };
  if (subtotalMinor < c.minCartMinor) return { ok: false, reason: "MIN_CART" };
  if (c.usageLimit !== null && c.usedCount >= c.usageLimit) return { ok: false, reason: "USED_UP" };
  const mine = await prisma.couponUsage.count({ where: { couponId: c.id, userId } });
  if (mine >= c.perUserLimit) return { ok: false, reason: "ALREADY_USED" };
  if (c.firstPurchaseOnly) {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { firstPurchaseAt: true } });
    if (u?.firstPurchaseAt) return { ok: false, reason: "FIRST_ONLY" };
  }
  let discount = 0;
  if (c.type === "PERCENTAGE") {
    discount = Math.floor((subtotalMinor * (c.valuePct ?? 0)) / 10000);
    if (c.maxDiscountMinor) discount = Math.min(discount, c.maxDiscountMinor);
  } else {
    if (c.currency && c.currency !== currency) return { ok: false, reason: "CURRENCY" };
    discount = c.valueMinor ?? 0;
  }
  discount = Math.min(discount, subtotalMinor);
  if (discount <= 0) return { ok: false, reason: "NO_DISCOUNT" };
  return { ok: true, code: c.code, discountMinor: discount };
}

async function cartSubtotal(userId: string, currency: Currency): Promise<number> {
  const view = await getCartView(userId, currency);
  return view.subtotalMinor;
}

/** Apply a coupon code to the user's cart (validates first). */
export async function applyCouponToCart(userId: string, code: string, currency: Currency): Promise<CouponResult> {
  const clean = code.trim().toUpperCase();
  const c = (await prisma.coupon.findUnique({ where: { code: clean } })) as CouponRow | null;
  const sub = await cartSubtotal(userId, currency);
  const res = await evaluate(c, userId, currency, sub);
  if (!res.ok || !c) return res;
  await prisma.cart.upsert({ where: { userId }, create: { userId, couponId: c.id }, update: { couponId: c.id } });
  return res;
}

export async function removeCouponFromCart(userId: string): Promise<void> {
  await prisma.cart.update({ where: { userId }, data: { couponId: null } }).catch(() => undefined);
}

/** Current cart coupon + its discount for display (re-validated against the live subtotal). */
export async function getCartCoupon(userId: string, currency: Currency): Promise<{ code: string; discountMinor: number } | null> {
  const cart = await prisma.cart.findUnique({ where: { userId }, include: { coupon: true } });
  if (!cart?.coupon) return null;
  const sub = await cartSubtotal(userId, currency);
  const res = await evaluate(cart.coupon as unknown as CouponRow, userId, currency, sub);
  if (!res.ok) return null;
  return { code: cart.coupon.code, discountMinor: res.discountMinor ?? 0 };
}

/** Inside a checkout transaction: resolve the cart coupon against the priced subtotal. No writes. */
export async function resolveCartCouponTx(tx: Tx, userId: string, currency: Currency, subtotalMinor: number): Promise<{ couponId: string; discountMinor: number } | null> {
  const cart = await tx.cart.findUnique({ where: { userId }, include: { coupon: true } });
  if (!cart?.coupon) return null;
  const res = await evaluate(cart.coupon as unknown as CouponRow, userId, currency, subtotalMinor);
  if (!res.ok || !res.discountMinor) return null;
  return { couponId: cart.coupon.id, discountMinor: res.discountMinor };
}

/** Record a coupon redemption on a created order and clear it from the cart. */
export async function recordCouponUseTx(tx: Tx, couponId: string, userId: string, orderId: string, discountMinor: number): Promise<void> {
  await tx.coupon.update({ where: { id: couponId }, data: { usedCount: { increment: 1 } } });
  await tx.couponUsage.create({ data: { couponId, userId, orderId, discountMinor } });
  await tx.cart.update({ where: { userId }, data: { couponId: null } }).catch(() => undefined);
}
