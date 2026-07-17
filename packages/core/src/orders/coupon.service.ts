import { prisma, type Currency } from "@gis/database";
import { CoreError } from "@gis/shared";
import { priceCart, type Tx } from "./assign.js";

/**
 * Coupon engine. Validation + discount computation are pure and side-effect free
 * (evaluateCoupon), so they can run inside any checkout transaction; recording a
 * redemption is a separate, explicit step (recordCouponUse). The bot uses
 * previewCoupon to show the discount before the customer pays.
 *
 * CATEGORY-scope coupons are not enforceable yet (the Coupon model has no
 * category link), so they behave like GLOBAL coupons.
 */

export interface AppliedCoupon {
  couponId: string;
  code: string;
  discountMinor: number;
}

export async function evaluateCoupon(
  tx: Tx,
  params: { code: string; userId: string; subtotalMinor: number; currency: Currency; productIds: string[] },
): Promise<AppliedCoupon> {
  const code = params.code.trim();
  if (!code) throw new CoreError("VALIDATION_FAILED", "Enter a coupon code.");

  const coupon = await tx.coupon.findFirst({
    where: { code: { equals: code, mode: "insensitive" } },
    include: { products: { select: { id: true } } },
  });
  if (!coupon || !coupon.isActive) throw new CoreError("VALIDATION_FAILED", "Invalid or inactive coupon code.");

  const now = new Date();
  if (coupon.startsAt && now < coupon.startsAt) throw new CoreError("VALIDATION_FAILED", "This coupon isn't active yet.");
  if (coupon.expiresAt && now > coupon.expiresAt) throw new CoreError("VALIDATION_FAILED", "This coupon has expired.");
  if (params.subtotalMinor < coupon.minCartMinor) {
    throw new CoreError("VALIDATION_FAILED", "Your order doesn't meet the minimum for this coupon.");
  }
  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
    throw new CoreError("VALIDATION_FAILED", "This coupon has reached its usage limit.");
  }

  const userUses = await tx.couponUsage.count({ where: { couponId: coupon.id, userId: params.userId } });
  if (userUses >= coupon.perUserLimit) throw new CoreError("VALIDATION_FAILED", "You've already used this coupon.");

  if (coupon.firstPurchaseOnly || coupon.newUserOnly) {
    const user = await tx.user.findUniqueOrThrow({ where: { id: params.userId } });
    if (user.firstPurchaseAt !== null) throw new CoreError("VALIDATION_FAILED", "This coupon is for your first purchase only.");
  }

  if (coupon.scope === "USER" && coupon.allowedUserId !== params.userId) {
    throw new CoreError("VALIDATION_FAILED", "This coupon isn't valid for your account.");
  }
  if (coupon.scope === "PRODUCT") {
    const eligible = new Set(coupon.products.map((p) => p.id));
    if (!params.productIds.some((id) => eligible.has(id))) {
      throw new CoreError("VALIDATION_FAILED", "This coupon doesn't apply to the items in your order.");
    }
  }

  let discountMinor = 0;
  if (coupon.type === "FIXED") {
    if (coupon.currency && coupon.currency !== params.currency) {
      throw new CoreError("VALIDATION_FAILED", `This coupon is valid only for ${coupon.currency} orders.`);
    }
    discountMinor = Math.min(coupon.valueMinor ?? 0, params.subtotalMinor);
  } else {
    const raw = Math.floor((params.subtotalMinor * (coupon.valuePct ?? 0)) / 10_000);
    discountMinor = coupon.maxDiscountMinor ? Math.min(raw, coupon.maxDiscountMinor) : raw;
    discountMinor = Math.min(discountMinor, params.subtotalMinor);
  }
  if (discountMinor <= 0) throw new CoreError("VALIDATION_FAILED", "This coupon has no effect on your order.");

  return { couponId: coupon.id, code: coupon.code, discountMinor };
}

/** Record a redemption inside the checkout transaction (usedCount + per-user log). */
export async function recordCouponUse(
  tx: Tx,
  params: { couponId: string; userId: string; orderId: string; discountMinor: number },
): Promise<void> {
  await tx.coupon.update({ where: { id: params.couponId }, data: { usedCount: { increment: 1 } } });
  await tx.couponUsage.create({
    data: {
      couponId: params.couponId,
      userId: params.userId,
      orderId: params.orderId,
      discountMinor: params.discountMinor,
    },
  });
}

export interface CouponPreview {
  code: string;
  discountMinor: number;
  currency: Currency;
  subtotalMinor: number;
  payableMinor: number;
}

/** Validate a coupon against the user's current cart and return the resulting discount. */
export async function previewCoupon(userId: string, code: string): Promise<CouponPreview> {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    const lines = await priceCart(tx, userId, user.currency);
    const subtotalMinor = lines.reduce((s, l) => s + l.unitPriceMinor * l.quantity, 0);
    const productIds = [...new Set(lines.map((l) => l.productId))];
    const applied = await evaluateCoupon(tx, { code, userId, subtotalMinor, currency: user.currency, productIds });
    return {
      code: applied.code,
      discountMinor: applied.discountMinor,
      currency: user.currency,
      subtotalMinor,
      payableMinor: subtotalMinor - applied.discountMinor,
    };
  });
}
