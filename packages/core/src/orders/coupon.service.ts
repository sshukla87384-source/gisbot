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
    NEW_ONLY: "This coupon is for new accounts only.",
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
  newUserOnly: boolean;
  usageLimit: number | null; perUserLimit: number; usedCount: number;
  isActive: boolean; startsAt: Date | null; expiresAt: Date | null; deletedAt: Date | null;
  /** USER scope: the one account this code belongs to. */
  allowedUserId: string | null;
  /** CATEGORY scope targets. */
  categoryIds: string[];
  /** PRODUCT scope targets, flattened from the CouponProducts relation. */
  productIds: string[];
}

/** What a scoped coupon needs to know about the cart it is being applied to. */
export interface CouponCartLine {
  productId: string;
  categoryId: string;
  lineTotalMinor: number;
}

/**
 * Flatten a Coupon row (optionally loaded with its scoped products) into the
 * shape `evaluate` works with. The relation is the ONLY place PRODUCT-scope
 * targets live, so a caller that forgets to include it gets an empty target
 * list — and an empty target list can never match, which is the safe direction.
 */
function toCouponRow(c: unknown): CouponRow | null {
  if (!c) return null;
  const rel = (c as { products?: Array<{ id: string }> }).products;
  const products = Array.isArray(rel) ? rel : [];
  return { ...(c as CouponRow), productIds: products.map((p) => p.id) };
}

/** A coupon marked "new accounts only" covers an account younger than this. */
const NEW_USER_MAX_DAYS_DEFAULT = 7;
const NEW_USER_DAYS_KEY = "coupon.new_user_days";

async function newUserMaxDays(): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: NEW_USER_DAYS_KEY } }).catch(() => null);
  const v = row?.value as { days?: number } | number | null | undefined;
  const n = typeof v === "number" ? v : typeof v?.days === "number" ? v.days : NEW_USER_MAX_DAYS_DEFAULT;
  return Number.isFinite(n) && n > 0 ? n : NEW_USER_MAX_DAYS_DEFAULT;
}

/**
 * `db` is the caller's client. Inside a checkout this MUST be the transaction:
 * reading usage counts through the global client meant two concurrent checkouts
 * each saw zero prior uses, so usageLimit and perUserLimit were both bypassed
 * and a single-use coupon could be redeemed any number of times.
 */
async function evaluate(
  c: CouponRow | null,
  userId: string,
  currency: Currency,
  subtotalMinor: number,
  db: Pick<typeof prisma, "couponUsage" | "user"> = prisma,
  lines?: CouponCartLine[],
): Promise<CouponResult> {
  if (!c || !c.isActive || c.deletedAt) return { ok: false, reason: "INVALID" };
  const now = new Date();
  if (c.startsAt && c.startsAt > now) return { ok: false, reason: "NOT_STARTED" };
  if (c.expiresAt && c.expiresAt < now) return { ok: false, reason: "EXPIRED" };
  if (subtotalMinor <= 0) return { ok: false, reason: "EMPTY_CART" };
  if (subtotalMinor < c.minCartMinor) return { ok: false, reason: "MIN_CART" };
  // Scope decides WHICH part of the cart this code is allowed to discount. Every
  // non-GLOBAL scope used to be rejected outright, so PRODUCT/CATEGORY/USER
  // codes an admin created simply never worked.
  //
  // The discount base is the matching lines only — a "₹100 off Netflix" code
  // must not take ₹100 off a cart that happens to also contain Netflix, and a
  // percentage code must not discount the ineligible half of the basket. The
  // minimum-cart check above stays against the WHOLE cart, which is what
  // "minimum cart" means.
  let eligibleMinor = subtotalMinor;
  if (c.scope === "USER") {
    if (!c.allowedUserId || c.allowedUserId !== userId) return { ok: false, reason: "NOT_APPLICABLE" };
  } else if (c.scope === "PRODUCT" || c.scope === "CATEGORY") {
    // No line detail means nothing can be matched, and matching nothing must
    // never fall back to discounting everything.
    if (!lines) return { ok: false, reason: "NOT_APPLICABLE" };
    const targets = new Set(c.scope === "PRODUCT" ? c.productIds : c.categoryIds);
    if (targets.size === 0) return { ok: false, reason: "NOT_APPLICABLE" };
    eligibleMinor = lines
      .filter((l) => targets.has(c.scope === "PRODUCT" ? l.productId : l.categoryId))
      .reduce((s, l) => s + l.lineTotalMinor, 0);
    if (eligibleMinor <= 0) return { ok: false, reason: "NOT_APPLICABLE" };
  } else if (c.scope !== "GLOBAL") {
    return { ok: false, reason: "NOT_APPLICABLE" };
  }
  if (c.usageLimit !== null && c.usedCount >= c.usageLimit) return { ok: false, reason: "USED_UP" };
  const mine = await db.couponUsage.count({ where: { couponId: c.id, userId } });
  if (mine >= c.perUserLimit) return { ok: false, reason: "ALREADY_USED" };
  if (c.firstPurchaseOnly || c.newUserOnly) {
    const u = await db.user.findUnique({ where: { id: userId }, select: { firstPurchaseAt: true, createdAt: true } });
    if (c.firstPurchaseOnly && u?.firstPurchaseAt) return { ok: false, reason: "FIRST_ONLY" };
    // `newUserOnly` is about ACCOUNT AGE, not about having bought before — a
    // welcome code can be for an account opened this week whether or not they
    // already ordered. It was carried on the row and never once looked at.
    if (c.newUserOnly) {
      if (!u) return { ok: false, reason: "NEW_ONLY" };
      const maxAgeMs = (await newUserMaxDays()) * 86_400_000;
      if (Date.now() - u.createdAt.getTime() > maxAgeMs) return { ok: false, reason: "NEW_ONLY" };
    }
  }
  let discount = 0;
  if (c.type === "PERCENTAGE") {
    discount = Math.floor((eligibleMinor * (c.valuePct ?? 0)) / 10000);
    if (c.maxDiscountMinor) discount = Math.min(discount, c.maxDiscountMinor);
  } else {
    // A FIXED coupon with NO currency is meaningless: "100 off" in what? It used
    // to apply to any cart, so a ₹100-off code took $100 off a dollar cart.
    // Treat a missing currency exactly like a mismatched one.
    if (!c.currency || c.currency !== currency) return { ok: false, reason: "CURRENCY" };
    discount = c.valueMinor ?? 0;
  }
  discount = Math.min(discount, eligibleMinor);
  if (discount <= 0) return { ok: false, reason: "NO_DISCOUNT" };
  return { ok: true, code: c.code, discountMinor: discount };
}

async function cartSnapshot(userId: string, currency: Currency): Promise<{ subtotalMinor: number; lines: CouponCartLine[] }> {
  const view = await getCartView(userId, currency);
  return {
    subtotalMinor: view.subtotalMinor,
    lines: view.lines.map((l) => ({ productId: l.productId, categoryId: l.categoryId, lineTotalMinor: l.lineTotalMinor ?? 0 })),
  };
}

/** Apply a coupon code to the user's cart (validates first). */
export async function applyCouponToCart(userId: string, code: string, currency: Currency): Promise<CouponResult> {
  const clean = code.trim().toUpperCase();
  const c = toCouponRow(await prisma.coupon.findUnique({
    where: { code: clean },
    include: { products: { select: { id: true } } },
  }));
  const cart = await cartSnapshot(userId, currency);
  const res = await evaluate(c, userId, currency, cart.subtotalMinor, prisma, cart.lines);
  if (!res.ok || !c) return res;
  await prisma.cart.upsert({ where: { userId }, create: { userId, couponId: c.id }, update: { couponId: c.id } });
  return res;
}

export async function removeCouponFromCart(userId: string): Promise<void> {
  await prisma.cart.update({ where: { userId }, data: { couponId: null } }).catch(() => undefined);
}

/** Current cart coupon + its discount for display (re-validated against the live subtotal). */
export async function getCartCoupon(userId: string, currency: Currency): Promise<{ code: string; discountMinor: number } | null> {
  const cart = await prisma.cart.findUnique({
    where: { userId },
    include: { coupon: { include: { products: { select: { id: true } } } } },
  });
  if (!cart?.coupon) return null;
  const snap = await cartSnapshot(userId, currency);
  const res = await evaluate(toCouponRow(cart.coupon), userId, currency, snap.subtotalMinor, prisma, snap.lines);
  if (!res.ok) return null;
  return { code: cart.coupon.code, discountMinor: res.discountMinor ?? 0 };
}

/** Inside a checkout transaction: resolve the cart coupon against the priced subtotal. No writes. */
export async function resolveCartCouponTx(tx: Tx, userId: string, currency: Currency, subtotalMinor: number, lines?: CouponCartLine[]): Promise<{ couponId: string; discountMinor: number } | null> {
  const cart = await tx.cart.findUnique({
    where: { userId },
    // The scoped products come with the coupon: a PRODUCT-scope code has no
    // other record of what it applies to.
    include: { coupon: { include: { products: { select: { id: true } } } } },
  });
  if (!cart?.coupon) return null;
  // Lock the coupon row for the rest of the transaction, so a concurrent
  // checkout serialises behind us instead of reading a stale usedCount.
  const locked = await tx.$queryRaw<Array<{ usedCount: number; usageLimit: number | null }>>`
    SELECT "usedCount", "usageLimit" FROM "Coupon" WHERE "id" = ${cart.coupon.id} FOR UPDATE`;
  const live = locked[0];
  if (live && live.usageLimit !== null && live.usedCount >= live.usageLimit) return null;
  const base = toCouponRow(cart.coupon) as CouponRow;
  const row: CouponRow = { ...base, usedCount: live?.usedCount ?? cart.coupon.usedCount };
  // Pass `tx` so per-user limits are counted inside this transaction.
  const res = await evaluate(row, userId, currency, subtotalMinor, tx as unknown as Pick<typeof prisma, "couponUsage" | "user">, lines);
  if (!res.ok || !res.discountMinor) return null;
  return { couponId: cart.coupon.id, discountMinor: res.discountMinor };
}

/** Record a coupon redemption on a created order and clear it from the cart. */
export async function recordCouponUseTx(tx: Tx, couponId: string, userId: string, orderId: string, discountMinor: number): Promise<void> {
  await tx.coupon.update({ where: { id: couponId }, data: { usedCount: { increment: 1 } } });
  await tx.couponUsage.create({ data: { couponId, userId, orderId, discountMinor } });
  await tx.cart.update({ where: { userId }, data: { couponId: null } }).catch(() => undefined);
}

/**
 * Hand a coupon back when the order that burned it dies unpaid.
 *
 * The deferred-payment rails (gateway, Stars, UPI, Binance) record the
 * redemption when the order is CREATED, not when it is paid — they have to, or
 * two pending orders could each claim the last use of a single-use code. But
 * nothing ever gave it back: a customer who opened a checkout and walked away,
 * or whose 15-minute window expired, had their one-per-customer code spent on
 * an order that never existed, and `usedCount` crept up until a limited coupon
 * reported USED_UP with nothing to show for it.
 *
 * Idempotent: CouponUsage.orderId is unique, so it is the ledger — a second
 * call finds no row and touches nothing. `usedCount` is floored at zero so a
 * counter that has already drifted can never go negative and hand out
 * unlimited redemptions.
 *
 * Call this in the SAME transaction that moves the order out of
 * PENDING_PAYMENT, so the release and the cancellation stand or fall together.
 */
export async function releaseCouponForOrderTx(tx: Tx, orderId: string): Promise<boolean> {
  const usage = await tx.couponUsage.findUnique({ where: { orderId }, select: { id: true, couponId: true } });
  if (!usage) return false;
  await tx.couponUsage.delete({ where: { id: usage.id } });
  await tx.coupon.updateMany({ where: { id: usage.couponId, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } });
  return true;
}
