import { createHash } from "node:crypto";
import { loadConfig } from "@gis/config";
import { prisma } from "@gis/database";
import { effectiveHours, encryptSecret, decryptSecret, hoursToDays, normalizeLicenseKey, sha256Hex } from "@gis/shared";
import { enqueueTelegramMessage } from "./queues.js";
import { adjustWallet } from "./wallet/wallet.service.js";
import { announceRestock } from "./broadcast.service.js";
import { invalidate, cached } from "./redis.js";
import { usdtRate, priceInrFromUsd, priceUsdFromInr } from "./fx.js";
import { splitCredential, sanitizeCredentialLine, repairAccountPair } from "./orders/assign.js";
import { clearPaymentPrompts } from "./orders/pay-prompt.service.js";

/** Compact dashboard figures for the in-bot admin panel. */
export async function getAdminStats(): Promise<{
  users: number;
  activeProducts: number;
  ordersToday: number;
  paidToday: number;
  pendingPayments: number;
  lowStockVariants: number;
}> {
  return cached("admin:stats", 20, async () => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const [users, activeProducts, ordersToday, paidToday, pendingPayments] = await Promise.all([
    prisma.user.count(),
    prisma.product.count({ where: { status: "ACTIVE", deletedAt: null } }),
    prisma.order.count({ where: { createdAt: { gte: startOfDay } } }),
    prisma.order.count({ where: { paidAt: { gte: startOfDay } } }),
    prisma.order.count({ where: { status: "PENDING_PAYMENT" } }),
  ]);
  const low = await prisma.$queryRaw<Array<{ c: bigint }>>`
    SELECT COUNT(*)::bigint AS c FROM (
      SELECT v."id"
      FROM "ProductVariant" v JOIN "Product" p ON p."id" = v."productId"
      LEFT JOIN "LicenseKey" k ON k."variantId" = v."id" AND k."status" = 'AVAILABLE' AND k."deletedAt" IS NULL
      WHERE v."deletedAt" IS NULL AND v."isActive" = true AND p."status" = 'ACTIVE'
        AND p."type" IN ('LICENSE_KEY','DIGITAL_ACCOUNT')
      GROUP BY v."id", v."lowStockThreshold"
      HAVING COUNT(k."id") <= v."lowStockThreshold"
    ) t`;
  return {
    users,
    activeProducts,
    ordersToday,
    paidToday,
    pendingPayments,
    lowStockVariants: Number(low[0]?.c ?? 0n),
  };
  });
}

export interface OrderBrief {
  id: string;
  orderNumber: string;
  status: string;
  totalMinor: number;
  currency: string;
  binanceAmount: string | null;
  createdAt: Date;
  itemCount: number;
}

export async function listPendingPaymentOrders(limit = 10): Promise<OrderBrief[]> {
  const rows = await prisma.order.findMany({
    where: { status: "PENDING_PAYMENT" },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { _count: { select: { items: true } } },
  });
  return rows.map((o) => ({
    id: o.id, orderNumber: o.orderNumber, status: o.status, totalMinor: o.totalMinor,
    currency: o.currency, binanceAmount: o.binanceAmount, createdAt: o.createdAt, itemCount: o._count.items,
  }));
}

export async function listRecentOrders(limit = 10): Promise<OrderBrief[]> {
  const rows = await prisma.order.findMany({
    orderBy: { createdAt: "desc" }, take: limit, include: { _count: { select: { items: true } } },
  });
  return rows.map((o) => ({
    id: o.id, orderNumber: o.orderNumber, status: o.status, totalMinor: o.totalMinor,
    currency: o.currency, binanceAmount: o.binanceAmount, createdAt: o.createdAt, itemCount: o._count.items,
  }));
}

export async function getAdminOrder(orderId: string): Promise<
  | (OrderBrief & { items: Array<{ id: string; name: string; variant: string; qty: number; type: string; fulfilled: boolean }>; userLabel: string })
  | null
> {
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: { include: { variant: { include: { product: { select: { type: true } } } } } },
      user: { select: { firstName: true, telegramHandle: true, telegramId: true } },
    },
  });
  if (!o) return null;
  return {
    id: o.id, orderNumber: o.orderNumber, status: o.status, totalMinor: o.totalMinor, currency: o.currency,
    binanceAmount: o.binanceAmount, createdAt: o.createdAt, itemCount: o.items.length,
    items: o.items.map((i) => ({ id: i.id, name: i.productNameSnap, variant: i.variantNameSnap, qty: i.quantity, type: i.variant.product.type, fulfilled: i.fulfilledAt !== null })),
    userLabel: o.user.telegramHandle ? `@${o.user.telegramHandle}` : (o.user.firstName ?? String(o.user.telegramId ?? "user")),
  };
}

export interface AdminRevealedItem {
  orderItemId: string;
  productName: string;
  variantName: string;
  fulfilledAt: Date | null;
  /** Superseded by a replacement — the value no longer works. */
  replaced: boolean;
  payload: { kind?: string; key?: string; username?: string; password?: string; twofa?: string; expiresAt?: string; text?: string };
}

/**
 * Everything actually delivered on one order, in the clear, for an admin.
 *
 * Support cannot answer "what link did I get?" from a masked last-4, and the
 * only people who could see a delivered value were the customer and whoever
 * typed it in by hand. Every call is audit-logged with the admin's id, exactly
 * as the customer's own reveal is — an admin reading a customer's credentials
 * is a real event and has to leave a trace.
 */
export async function adminRevealOrder(
  orderId: string,
  /** Who looked — a Telegram id or handle. Recorded on the audit entry. */
  actorLabel = "bot-admin",
): Promise<{ orderNumber: string; userLabel: string; items: AdminRevealedItem[] } | null> {
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: { orderBy: [{ fulfilledAt: "asc" }, { id: "asc" }] },
      user: { select: { firstName: true, telegramHandle: true, telegramId: true } },
    },
  });
  if (!o) return null;
  const masterKey = loadConfig().ENCRYPTION_MASTER_KEY;
  const items: AdminRevealedItem[] = [];
  for (const i of o.items) {
    if (!i.deliveryPayloadEncrypted) continue;
    let payload: AdminRevealedItem["payload"] = {};
    // One unreadable payload (rotated key, corrupt row) must not blank the
    // whole screen — show the item and say it cannot be read.
    try { payload = JSON.parse(decryptSecret(i.deliveryPayloadEncrypted, masterKey)); } catch { payload = { text: "⚠️ could not be decrypted" }; }
    items.push({
      orderItemId: i.id,
      productName: i.productNameSnap,
      variantName: i.variantNameSnap,
      fulfilledAt: i.fulfilledAt,
      replaced: i.replacedAt !== null,
      payload,
    });
  }
  // actorId is a foreign key to User; a Telegram id is not one, and passing it
  // would make every audit insert fail silently. The label goes in `after`.
  await prisma.auditLog.create({
    data: {
      actorType: "ADMIN", action: "delivery.reveal.admin",
      entityType: "Order", entityId: orderId, after: { items: items.length, by: actorLabel },
    },
  }).catch(() => undefined);
  return {
    orderNumber: o.orderNumber,
    userLabel: o.user.telegramHandle ? `@${o.user.telegramHandle}` : (o.user.firstName ?? String(o.user.telegramId ?? "user")),
    items,
  };
}

/** Every order one customer has ever placed, newest first — for the admin. */
export async function listUserOrders(userId: string, page = 1, pageSize = 8): Promise<{ items: OrderSearchHit[]; page: number; pages: number; total: number }> {
  const where = { userId };
  const total = await prisma.order.count({ where });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, page), pages);
  const rows = await prisma.order.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: (p - 1) * pageSize,
    take: pageSize,
    include: {
      items: { select: { productNameSnap: true } },
      user: { select: { firstName: true, telegramHandle: true, telegramId: true } },
    },
  });
  return {
    items: rows.map((o) => ({
      id: o.id, orderNumber: o.orderNumber, status: o.status, totalMinor: o.totalMinor,
      currency: o.currency, createdAt: o.createdAt, itemCount: o.items.length,
      userLabel: o.user.telegramHandle ? `@${o.user.telegramHandle}` : (o.user.firstName ?? String(o.user.telegramId ?? "user")),
      firstItem: o.items[0]?.productNameSnap ?? "",
    })),
    page: p, pages, total,
  };
}

export interface OrderSearchHit {
  id: string;
  orderNumber: string;
  status: string;
  totalMinor: number;
  currency: string;
  createdAt: Date;
  itemCount: number;
  userLabel: string;
  firstItem: string;
}

/**
 * Find orders by whatever the admin happens to have: order number (full or the
 * tail), @handle, Telegram id, or a product name. One box, because in practice
 * an admin is holding one of those four and should not have to pick a mode.
 */
export async function searchOrders(query: string, limit = 10): Promise<OrderSearchHit[]> {
  const q = query.trim().replace(/^#/, "");
  if (q.length < 2) return [];
  const handle = q.replace(/^@/, "");
  const digits = /^\d{5,}$/.test(q) ? q : null;
  const rows = await prisma.order.findMany({
    where: {
      OR: [
        { orderNumber: { contains: q, mode: "insensitive" } },
        { user: { telegramHandle: { contains: handle, mode: "insensitive" } } },
        ...(digits ? [{ user: { telegramId: BigInt(digits) } }] : []),
        { items: { some: { productNameSnap: { contains: q, mode: "insensitive" } } } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 25),
    include: {
      items: { select: { productNameSnap: true } },
      user: { select: { firstName: true, telegramHandle: true, telegramId: true } },
    },
  });
  return rows.map((o) => ({
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    totalMinor: o.totalMinor,
    currency: o.currency,
    createdAt: o.createdAt,
    itemCount: o.items.length,
    userLabel: o.user.telegramHandle ? `@${o.user.telegramHandle}` : (o.user.firstName ?? String(o.user.telegramId ?? "user")),
    firstItem: o.items[0]?.productNameSnap ?? "",
  }));
}

export async function adminCancelOrder(orderId: string): Promise<void> {
  await prisma.order.updateMany({
    where: { id: orderId, status: { in: ["PENDING_PAYMENT"] } },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });
  // Nothing left to pay — take the instruction card out of the customer's chat.
  await clearPaymentPrompts(orderId).catch(() => undefined);
}

/** Reject a pending manual order and notify the buyer. */
export async function rejectManualOrder(orderId: string): Promise<{ ok: boolean; orderNumber?: string }> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { user: { select: { telegramId: true } } },
  });
  if (!order || order.status !== "PENDING_PAYMENT") return { ok: false };
  await prisma.order.update({ where: { id: orderId }, data: { status: "CANCELLED", cancelledAt: new Date() } });
  await clearPaymentPrompts(orderId).catch(() => undefined);
  if (order.user.telegramId !== null) {
    await enqueueTelegramMessage(
      order.user.telegramId,
      `❌ Payment for order <b>${order.orderNumber}</b> could not be verified and was rejected. If you did pay, contact 🎫 Support with your reference.`,
    );
  }
  return { ok: true, orderNumber: order.orderNumber };
}

/** Admin: credit (+) or debit (-) a user's wallet. Identify by telegram id or @handle. */
export async function adjustUserWallet(
  identifier: string,
  amountMinor: number,
  actorId?: string,
): Promise<{ ok: boolean; label?: string; newBalanceMinor?: bigint; currency?: string; reason?: string }> {
  const id = identifier.trim().replace(/^@/, "");
  const user = /^\d+$/.test(id)
    ? await prisma.user.findUnique({ where: { telegramId: BigInt(id) } })
    : await prisma.user.findFirst({ where: { telegramHandle: id } });
  if (!user) return { ok: false, reason: "USER_NOT_FOUND" };
  const newBalanceMinor = await adjustWallet({
    userId: user.id,
    amountMinor: BigInt(amountMinor),
    type: "ADJUSTMENT",
    note: "admin adjustment (bot)",
    actorId,
  });
  const w = await prisma.wallet.findUnique({ where: { userId: user.id } });
  const currency = w?.currency ?? user.currency;
  if (user.telegramId !== null) {
    const sign = amountMinor >= 0 ? "credited" : "debited";
    await enqueueTelegramMessage(
      user.telegramId,
      `💳 Your wallet was ${sign} by an admin. New balance: <b>${(Number(newBalanceMinor) / 100).toFixed(2)} ${currency}</b>.`,
    );
  }
  return {
    ok: true,
    label: user.telegramHandle ? `@${user.telegramHandle}` : (user.firstName ?? String(user.telegramId)),
    newBalanceMinor,
    currency,
  };
}

export interface ProductBrief { id: string; reusable?: boolean; reusableStock?: number | null; manualStock?: number | null; name: string; nameHtml: string | null; status: string; iconEmoji: string | null; onSalePct: number | null; pinRank: number; fulfillmentMode: string; slug: string; type: string; allowPwChange: boolean; supplierId: string | null; warranty: boolean; warrantyDays: number | null; warrantyHours: number | null; bulkMinQty?: number | null; bulkPercentBp?: number | null }

type PRow = { id: string; name: string; nameHtml: string | null; status: string; iconEmoji: string | null; salePercentBp: number | null; pinRank: number; fulfillmentMode: string; slug: string; type: string; allowPasswordChange: boolean; supplierId: string | null; warranty: boolean; warrantyDays: number | null; warrantyHours: number | null; bulkMinQty?: number | null; bulkPercentBp?: number | null };
function toBrief(p: PRow): ProductBrief {
  return { id: p.id, reusable: Boolean((p as unknown as { reusableSecretEnc?: string | null }).reusableSecretEnc), reusableStock: (p as unknown as { reusableStock?: number | null }).reusableStock ?? null, manualStock: (p as unknown as { manualStock?: number | null }).manualStock ?? null, name: p.name, nameHtml: p.nameHtml, status: p.status, iconEmoji: p.iconEmoji, onSalePct: p.salePercentBp, pinRank: p.pinRank, fulfillmentMode: p.fulfillmentMode, slug: p.slug, type: p.type, allowPwChange: p.allowPasswordChange, supplierId: p.supplierId, warranty: p.warranty, warrantyDays: p.warrantyDays, warrantyHours: p.warrantyHours, bulkMinQty: p.bulkMinQty ?? null, bulkPercentBp: p.bulkPercentBp ?? null };
}

export async function getProductBriefById(id: string): Promise<ProductBrief | null> {
  const p = await prisma.product.findUnique({ where: { id } });
  if (!p || p.deletedAt) return null;
  return toBrief(p as unknown as PRow);
}

export async function listProductsBrief(limit = 20): Promise<ProductBrief[]> {
  const rows = await prisma.product.findMany({
    where: { deletedAt: null }, orderBy: [{ pinRank: "desc" }, { status: "asc" }, { createdAt: "desc" }], take: limit,
  });
  return rows.map(toBrief);
}

/** Paginated product list for the admin panel (shows ALL products across pages). */
export async function listProductsPage(page = 1, pageSize = 20, search?: string): Promise<{ items: ProductBrief[]; page: number; pages: number; total: number }> {
  const where = { deletedAt: null, ...(search && search.trim() ? { name: { contains: search.trim(), mode: "insensitive" as const } } : {}) };
  const total = await prisma.product.count({ where });
  const rows = await prisma.product.findMany({ where, orderBy: [{ pinRank: "desc" }, { status: "asc" }, { createdAt: "desc" }], skip: (Math.max(1, page) - 1) * pageSize, take: pageSize });
  return { items: rows.map(toBrief), page: Math.max(1, page), pages: Math.max(1, Math.ceil(total / pageSize)), total };
}

/** Pin a product to the top / a chosen priority. Higher rank = higher in the list; 0 = unpinned. */
export async function setProductPinRank(productId: string, pinRank: number): Promise<void> {
  await prisma.product.update({ where: { id: productId }, data: { pinRank: Math.max(0, Math.round(pinRank)) } });
  await invalidate("cat:*");
}

export async function adminDeleteProduct(id: string): Promise<void> {
  await prisma.product.update({ where: { id }, data: { deletedAt: new Date(), status: "ARCHIVED" } });
}

export async function setProductName(productId: string, name: string, nameHtml: string | null = null): Promise<void> {
  await prisma.product.update({ where: { id: productId }, data: { name: name.slice(0, 200), nameHtml: nameHtml?.slice(0, 500) ?? null } });
  await invalidate("cat:*");
}

export async function setProductDescription(productId: string, description: string, descriptionHtml: string | null = null): Promise<void> {
  await prisma.product.update({ where: { id: productId }, data: { description: description.slice(0, 4000), descriptionHtml: descriptionHtml?.slice(0, 8000) ?? null } });
  await invalidate("cat:*");
}

/** Per-product delivery instructions (shown with the key on delivery). Empty clears it. */
export async function setProductActivationGuide(productId: string, guide: string): Promise<void> {
  const g = guide.trim().slice(0, 2000);
  await prisma.product.update({ where: { id: productId }, data: { activationGuide: g || null } });
  await invalidate("cat:*");
}

// ───────────── Customisable button labels ─────────────

export const BUTTON_LABEL_KEYS = ["shop", "categories", "orders", "wallet", "account", "support", "referral", "currency", "language", "developer"] as const;
export type ButtonLabelKey = (typeof BUTTON_LABEL_KEYS)[number];

export interface ButtonOverride { label?: string; icon?: string }

/** Admin overrides for main-menu buttons: custom label and/or premium-emoji icon (empty when unset). */
/** Cached: this is read on every main-menu render but only changes when an admin edits a label. */
export async function getButtonConfig(): Promise<Partial<Record<ButtonLabelKey, ButtonOverride>>> {
  return cached("btncfg:all", 300, async () => {
    const row = await prisma.setting.findUnique({ where: { key: "ui.button_labels" } });
    return (row?.value as Partial<Record<ButtonLabelKey, ButtonOverride>> | undefined) ?? {};
  }).catch(async () => {
    const row = await prisma.setting.findUnique({ where: { key: "ui.button_labels" } });
    return (row?.value as Partial<Record<ButtonLabelKey, ButtonOverride>> | undefined) ?? {};
  });
}

/** Set a button's label and/or premium-emoji icon. Pass empty label + null icon to reset to default. */
export async function setButton(key: ButtonLabelKey, label: string, icon: string | null): Promise<void> {
  const current = await getButtonConfig();
  const next = { ...current };
  const l = label.trim().slice(0, 40);
  if (!l && !icon) delete next[key];
  else next[key] = { ...(l ? { label: l } : {}), ...(icon ? { icon } : {}) };
  await prisma.setting.upsert({
    where: { key: "ui.button_labels" },
    create: { key: "ui.button_labels", value: next as object },
    update: { value: next as object },
  });
  // getButtonConfig is cached for 5 min — drop it so the edit shows immediately.
  await invalidate("btncfg:*").catch(() => undefined);
}

export async function setProductImage(productId: string, imageUrl: string): Promise<void> {
  await prisma.product.update({ where: { id: productId }, data: { imageUrl } });
}

export async function setProductFulfillmentMode(productId: string, mode: "AUTOMATIC" | "MANUAL"): Promise<void> {
  await prisma.product.update({ where: { id: productId }, data: { fulfillmentMode: mode } });
  await invalidate("cat:*");
}

export async function setProductPasswordChange(productId: string, allow: boolean): Promise<void> {
  await prisma.product.update({ where: { id: productId }, data: { allowPasswordChange: allow } });
  await invalidate("cat:*");
}

/** Turn the replacement warranty on/off for a product. */
export async function setProductWarranty(productId: string, on: boolean): Promise<void> {
  await prisma.product.update({ where: { id: productId }, data: { warranty: on } });
  await invalidate("cat:*");
}

/**
 * Replacement window in HOURS (null/0 = unlimited while warranty is on).
 *
 * `warrantyDays` is written alongside — rounded UP — because the public API and
 * older readers still publish that field. Rounding down would tell a reseller
 * a 6-hour window is zero days, i.e. no warranty at all.
 */
export async function setProductWarrantyHours(productId: string, hours: number | null): Promise<void> {
  const h = hours && hours > 0 ? hours : null;
  await prisma.product.update({
    where: { id: productId },
    data: { warrantyHours: h, warrantyDays: hoursToDays(h) },
  });
  await invalidate("cat:*");
}

/** Validity of what a variant delivers, in HOURS (null/0 = no expiry of ours). */
export async function setVariantValidityHours(variantId: string, hours: number | null): Promise<void> {
  const h = hours && hours > 0 ? hours : null;
  await prisma.productVariant.update({
    where: { id: variantId },
    data: { durationHours: h, durationDays: hoursToDays(h) },
  });
  await invalidate("cat:*");
}

/** Set a product\'s custom Buy button label and/or colour (success|primary|danger). */
export async function setProductButton(productId: string, text: string | null, style: string | null): Promise<void> {
  await prisma.product.update({ where: { id: productId }, data: { ...(text !== null ? { buyButtonText: text.slice(0, 40) || null } : {}), ...(style !== null ? { buttonStyle: style || null } : {}) } });
  await invalidate("cat:*");
}

export async function setProductStatus(productId: string, status: "ACTIVE" | "PAUSED" | "DRAFT" | "ARCHIVED"): Promise<void> {
  await prisma.product.update({ where: { id: productId }, data: { status } });
}

export async function setFlashSale(productId: string, percent: number, endsAt: Date | null): Promise<void> {
  const bp = Math.min(Math.max(Math.round(percent * 100), 0), 9000);
  await prisma.product.update({
    where: { id: productId },
    data: { salePercentBp: bp, saleStartsAt: new Date(), saleEndsAt: endsAt },
  });
}

export async function clearFlashSale(productId: string): Promise<void> {
  await prisma.product.update({
    where: { id: productId },
    data: { salePercentBp: null, saleStartsAt: null, saleEndsAt: null },
  });
  await invalidate("cat:*");
}

/**
 * Drop the sale price of every product that has sold out.
 *
 * A discount is a reason to buy now; on an empty shelf it is just a promise the
 * shop cannot keep, and when stock is added back the old percentage would come
 * along with it — the operator restocks at a price they never re-approved.
 * Run from the worker every few minutes, because stock reaches zero through
 * checkout, replacement and expiry alike, not through one code path.
 */
/**
 * Drop every TEMPORARY customer-specific price on products that have sold out.
 *
 * A special rate is agreed against a particular batch — "this lot, this price".
 * When the shelf empties and is refilled at whatever the price is by then, the
 * old private rate should not quietly follow the customer into the new stock;
 * they go back to the public price like everyone else. An override the admin
 * marked PERMANENT is exactly the opposite intention, so it is left alone.
 *
 * Runs inside the same sweep as the sale reset, over the same product list.
 */
async function dropTemporaryUserPrices(): Promise<number> {
  // Start from the overrides, not from the sale: a customer price can sit on any
  // product, most of which are not discounted at all.
  const held = await prisma.userPrice.findMany({
    where: { permanent: false },
    select: { productId: true },
    distinct: ["productId"],
  });
  if (held.length === 0) return 0;
  const products = await prisma.product.findMany({
    where: { id: { in: held.map((h) => h.productId) }, deletedAt: null },
    select: {
      id: true, type: true, supplierId: true, supplierStock: true,
      reusableSecretEnc: true, reusableStock: true, fulfillmentMode: true, manualStock: true,
      variants: { where: { isActive: true, deletedAt: null }, select: { id: true } },
    },
  });
  if (products.length === 0) return 0;
  const { stockMapFor } = await import("./catalog/catalog.service.js");
  const stock = await stockMapFor(
    products.map((p) => ({
      id: p.id, type: p.type, supplierId: p.supplierId, supplierStock: p.supplierStock,
      reusable: p.reusableSecretEnc !== null, reusableStock: p.reusableStock,
      manual: p.fulfillmentMode === "MANUAL", manualStock: p.manualStock,
      variantIds: p.variants.map((v) => v.id),
    })),
  );
  const soldOutProductIds = products
    .filter((p) => p.variants.reduce((n, v) => n + (stock.get(v.id) ?? 0), 0) === 0)
    .map((p) => p.id);
  if (soldOutProductIds.length === 0) return 0;
  const doomed = await prisma.userPrice.findMany({
    where: { productId: { in: soldOutProductIds }, permanent: false },
    select: { id: true, userId: true, productId: true },
  });
  if (doomed.length === 0) return 0;
  await prisma.userPrice.deleteMany({ where: { id: { in: doomed.map((d) => d.id) } } });
  await prisma.auditLog.create({
    data: {
      actorType: "SYSTEM", action: "userprice.reset_sold_out",
      entityType: "Product", entityId: soldOutProductIds[0] ?? null,
      after: { removed: doomed.length, products: soldOutProductIds.length },
    },
  }).catch(() => undefined);
  await invalidate("cat:*");
  return doomed.length;
}

export async function resetSalesForSoldOut(): Promise<number> {
  const onSale = await prisma.product.findMany({
    where: { salePercentBp: { not: null }, status: "ACTIVE", deletedAt: null },
    select: {
      id: true, name: true, type: true, supplierId: true, supplierStock: true, saleEndsAt: true,
      reusableSecretEnc: true, reusableStock: true, fulfillmentMode: true, manualStock: true,
      variants: { where: { isActive: true, deletedAt: null }, select: { id: true } },
    },
  });
  if (onSale.length === 0) return 0;
  const { stockMapFor } = await import("./catalog/catalog.service.js");
  const stock = await stockMapFor(
    onSale.map((p) => ({
      id: p.id, type: p.type, supplierId: p.supplierId, supplierStock: p.supplierStock,
      reusable: p.reusableSecretEnc !== null, reusableStock: p.reusableStock,
      manual: p.fulfillmentMode === "MANUAL", manualStock: p.manualStock,
      variantIds: p.variants.map((v) => v.id),
    })),
  );
  const now = new Date();
  let cleared = 0;
  for (const p of onSale) {
    const soldOut = p.variants.reduce((n, v) => n + (stock.get(v.id) ?? 0), 0) === 0;
    // A finished sale was only ever hidden at read time (isSaleActive compares
    // the window), so the row kept its stale percentage and the admin screen kept
    // offering "🔥 End sale" for a sale that had ended hours ago. Clear it for real.
    const expired = p.saleEndsAt !== null && p.saleEndsAt <= now;
    if (!soldOut && !expired) continue;
    await clearFlashSale(p.id);
    cleared++;
    await prisma.auditLog.create({
      data: {
        actorType: "SYSTEM", action: soldOut ? "product.sale.reset_sold_out" : "product.sale.reset_expired",
        entityType: "Product", entityId: p.id, after: { name: p.name },
      },
    }).catch(() => undefined);
  }
  if (cleared > 0) await invalidate("cat:*");
  return cleared;
}

/**
 * One sweep, two jobs: reset sale prices on sold-out (or finished) products,
 * and drop temporary customer-specific prices on sold-out products. Both exist
 * so a restock never resurrects a price nobody re-approved.
 */
export async function resetPricesForSoldOut(): Promise<{ sales: number; customPrices: number }> {
  const sales = await resetSalesForSoldOut();
  const customPrices = await dropTemporaryUserPrices().catch(() => 0);
  return { sales, customPrices };
}



export interface VariantBrief { id: string; name: string; sku: string; defaultCostMinor: number | null; /** Validity of what this variant delivers, in hours; null = no expiry of ours. */ validityHours: number | null }
export async function listVariantsBrief(productId: string): Promise<VariantBrief[]> {
  const rows = await prisma.productVariant.findMany({
    where: { productId, deletedAt: null }, orderBy: { sortOrder: "asc" },
  });
  return rows.map((v) => ({ id: v.id, name: v.name, sku: v.sku, defaultCostMinor: v.defaultCostMinor ?? null, validityHours: effectiveHours(v.durationHours, v.durationDays) }));
}

/** Bulk-add license keys to a variant (one per line). Returns counts. */
/** A pasted line that is already in a customer's hands — offered back to the admin to decide. */
export interface BlockedStockLine {
  /** Last 4 characters, so a decision can be made without printing the secret. */
  tail: string;
  /** The pasted line itself, so the admin can confirm and re-add it. Never logged. */
  value: string;
  orderNumber: string | null;
  buyer: string | null;
  deliveredAt: Date | null;
}

export interface AddStockResult {
  added: number;
  skipped: number;
  relisted: number;
  /** Held by a LIVE order — not added, waiting on the admin's decision. */
  blocked: BlockedStockLine[];
}

export async function addLicenseKeys(
  variantId: string,
  rawKeys: string[],
  opts: { force?: boolean } = {},
): Promise<AddStockResult> {
  const masterKey = loadConfig().ENCRYPTION_MASTER_KEY;
  let added = 0, skipped = 0, relisted = 0;

  // Batched: 4 queries instead of 1-3 per key. A 2,000-key upload was 4,000+
  // sequential round trips, minutes of an admin watching nothing happen.
  const seen = new Set<string>();
  const incoming: Array<{ value: string; keyHash: string }> = [];
  for (const raw of rawKeys) {
    const value = raw.trim();
    if (!value) continue;
    const keyHash = sha256Hex(normalizeLicenseKey(value));
    if (seen.has(keyHash)) { skipped++; continue; } // duplicate within the upload itself
    seen.add(keyHash);
    incoming.push({ value, keyHash });
  }
  if (incoming.length === 0) return { added, skipped, relisted, blocked: [] };

  const existing = await prisma.licenseKey.findMany({
    where: { variantId, keyHash: { in: incoming.map((k) => k.keyHash) } },
    select: { id: true, keyHash: true, status: true, orderItemId: true },
  });
  const byHash = new Map(existing.map((e) => [e.keyHash, e]));

  // One lookup for every order that still holds one of these keys.
  const heldOrderItemIds = existing.map((e) => e.orderItemId).filter((x): x is string => Boolean(x));
  const heldItems = heldOrderItemIds.length > 0
    ? await prisma.orderItem.findMany({
        where: { id: { in: heldOrderItemIds } },
        select: {
          id: true, fulfilledAt: true,
          order: { select: { status: true, orderNumber: true, user: { select: { telegramHandle: true, firstName: true, telegramId: true } } } },
        },
      })
    : [];
  const orderStatusByItem = new Map(heldItems.map((i) => [i.id, i.order.status]));
  const heldByItem = new Map(heldItems.map((i) => [i.id, i]));

  const toCreate: Array<{ variantId: string; keyEncrypted: string; keyHash: string; supplier: string }> = [];
  const toRelist: string[] = [];
  const blocked: BlockedStockLine[] = [];
  for (const k of incoming) {
    const ex = byHash.get(k.keyHash);
    if (!ex) {
      toCreate.push({ variantId, keyEncrypted: encryptSecret(k.value, masterKey), keyHash: k.keyHash, supplier: "bot-admin" });
      continue;
    }
    // Already AVAILABLE → a true duplicate, skip. Already sold/disabled (e.g. a
    // test delivery) → put it BACK on the shelf instead of silently skipping,
    // and never create a second row for the same key.
    if (ex.status === "AVAILABLE") { skipped++; continue; }
    // NEVER resurrect a key that belongs to a live order — the buyer can still
    // see it in My Orders, and nulling orderItemId would drop the unique
    // constraint that prevents the same key being delivered twice.
    if (ex.orderItemId) {
      const st = orderStatusByItem.get(ex.orderItemId);
      const dead = st === undefined || ["CANCELLED", "EXPIRED", "REFUNDED"].includes(st);
      // A key a real customer still holds used to be dropped in silence, so
      // re-pasting it looked like nothing happened. Hand it back to the caller
      // as a decision instead — and only put it on the shelf when the admin
      // has said yes, knowing whose it was.
      if (!dead && !opts.force) {
        const held = heldByItem.get(ex.orderItemId);
        const u = held?.order.user;
        blocked.push({
          tail: k.value.length > 4 ? k.value.slice(-4) : k.value,
          value: k.value,
          orderNumber: held?.order.orderNumber ?? null,
          buyer: u ? (u.telegramHandle ? `@${u.telegramHandle}` : (u.firstName ?? String(u.telegramId ?? ""))) : null,
          deliveredAt: held?.fulfilledAt ?? null,
        });
        continue;
      }
    }
    toRelist.push(ex.id);
  }

  if (toCreate.length > 0) {
    const res = await prisma.licenseKey.createMany({ data: toCreate, skipDuplicates: true });
    added += res.count;
    skipped += toCreate.length - res.count; // lost a race with a concurrent upload
  }
  if (toRelist.length > 0) {
    const res = await prisma.licenseKey.updateMany({
      where: { id: { in: toRelist } },
      data: { status: "AVAILABLE", orderItemId: null, soldAt: null, reservedUntil: null, deletedAt: null },
    });
    relisted += res.count;
  }

  if (added + relisted > 0) {
    const v = await prisma.productVariant.findUnique({ where: { id: variantId }, select: { productId: true } });
    if (v) {
      await announceRestock(v.productId, added + relisted, { createdById: "bot-admin" }).catch(() => undefined);
      // Tell everyone who asked to be notified when this came back.
      const { notifyRestock } = await import("./watch.service.js");
      void notifyRestock(v.productId).catch(() => undefined);
    }
    await invalidate("cat:*");
  }
  return { added, skipped, relisted, blocked };
}

/** Add digital-account stock (username/password lines) for a DIGITAL_ACCOUNT variant. */
export async function addAccountStock(
  variantId: string,
  rawLines: string[],
  opts: { force?: boolean } = {},
): Promise<AddStockResult> {
  const masterKey = loadConfig().ENCRYPTION_MASTER_KEY;
  let added = 0, skipped = 0, relisted = 0;
  const blocked: BlockedStockLine[] = [];
  for (const raw of rawLines) {
    const line = raw.trim();
    if (!line) continue;
    // Shared parser: strips pasted markdown/mailto links and prefers "|" over ":",
    // so "[a@b.com](mailto:a@b.com)|pw" no longer splits inside "mailto:".
    const parsed = splitCredential(line) ?? (() => {
      const t = sanitizeCredentialLine(line);
      const m = t.match(/^(\S+)\s+(\S+)(?:\s+(\S+))?$/); // "user pass [2fa]"
      return m?.[1] && m[2] ? { id: m[1], pw: m[2], twofa: m[3] } : null;
    })();
    if (!parsed) { skipped++; continue; }
    const username = parsed.id;
    const password = parsed.pw;
    if (!username || !password) { skipped++; continue; }
    // Same username already on this variant? Never create a second row — either
    // it is a duplicate (skip) or it was sold/disabled (e.g. a test delivery),
    // in which case put it back on the shelf with the credentials just pasted.
    const usernameHash = sha256Hex(username.trim().toLowerCase());
    let existing = await prisma.digitalAccount.findFirst({ where: { variantId, usernameHash } });
    if (!existing) {
      // Rows created before usernameHash existed have it NULL — decrypt those to
      // compare, and backfill the hash so the next lookup is a plain index hit.
      const legacy = await prisma.digitalAccount.findMany({
        where: { variantId, usernameHash: null },
        select: { id: true, usernameEncrypted: true },
      });
      for (const l of legacy) {
        let u = "";
        try { u = decryptSecret(l.usernameEncrypted, masterKey); } catch { continue; }
        const h = sha256Hex(u.trim().toLowerCase());
        await prisma.digitalAccount.update({ where: { id: l.id }, data: { usernameHash: h } }).catch(() => undefined);
        if (h === usernameHash) { existing = await prisma.digitalAccount.findUnique({ where: { id: l.id } }); break; }
      }
    }
    if (existing) {
      if (existing.status === "AVAILABLE" && existing.usedSlots < existing.maxSlots && existing.deletedAt === null) { skipped++; continue; }
      // Only re-list when every assignment belongs to a dead order. Otherwise a
      // shared account would have live customers' slots wiped and resold, and
      // their password silently rewritten underneath them.
      const holders = await prisma.accountAssignment.findMany({
        where: { accountId: existing.id },
        select: {
          orderItem: {
            select: {
              fulfilledAt: true,
              order: { select: { status: true, orderNumber: true, user: { select: { telegramHandle: true, firstName: true, telegramId: true } } } },
            },
          },
        },
      });
      const liveHolder = holders.find((h) => !["CANCELLED", "EXPIRED", "REFUNDED"].includes(h.orderItem.order.status));
      // As with keys: a live holder is a decision for the admin, not a silent
      // skip. Forcing wipes their slot and rewrites the password, so the
      // confirmation names the customer before any of that happens.
      if (liveHolder && !opts.force) {
        const u = liveHolder.orderItem.order.user;
        blocked.push({
          tail: username.length > 4 ? username.slice(-4) : username,
          value: line,
          orderNumber: liveHolder.orderItem.order.orderNumber,
          buyer: u.telegramHandle ? `@${u.telegramHandle}` : (u.firstName ?? String(u.telegramId ?? "")),
          deliveredAt: liveHolder.orderItem.fulfilledAt,
        });
        continue;
      }
      await prisma.digitalAccount.update({
        where: { id: existing.id },
        data: {
          passwordEncrypted: encryptSecret(password, masterKey),
          ...(parsed.twofa ? { twofaEncrypted: encryptSecret(parsed.twofa, masterKey) } : {}),
          status: "AVAILABLE",
          usedSlots: 0,
          reservedUntil: null,
          deletedAt: null,
        },
      });
      await prisma.accountAssignment.deleteMany({ where: { accountId: existing.id } });
      relisted++;
      continue;
    }
    await prisma.digitalAccount.create({
      data: {
        variantId,
        usernameEncrypted: encryptSecret(username, masterKey),
        usernameHash,
        passwordEncrypted: encryptSecret(password, masterKey),
        ...(parsed.twofa ? { twofaEncrypted: encryptSecret(parsed.twofa, masterKey) } : {}),
        status: "AVAILABLE",
        maxSlots: 1,
        usedSlots: 0,
        supplier: "bot-admin",
      },
    });
    added++;
  }
  if (added + relisted > 0) {
    const v = await prisma.productVariant.findUnique({ where: { id: variantId }, select: { productId: true } });
    if (v) {
      await announceRestock(v.productId, added + relisted, { createdById: "bot-admin" }).catch(() => undefined);
      // Tell everyone who asked to be notified when this came back.
      const { notifyRestock } = await import("./watch.service.js");
      void notifyRestock(v.productId).catch(() => undefined);
    }
    await invalidate("cat:*");
  }
  return { added, skipped, relisted, blocked };
}

/**
 * Type-aware stock add: license keys for LICENSE_KEY variants, accounts for
 * DIGITAL_ACCOUNT. `force` re-lists values a live order still holds — only ever
 * passed after the admin has been shown whose they are and has said yes.
 */
export async function addStock(
  variantId: string,
  rawLines: string[],
  opts: { force?: boolean; actorLabel?: string } = {},
): Promise<AddStockResult & { type: string }> {
  const v = await prisma.productVariant.findUnique({ where: { id: variantId }, include: { product: { select: { type: true } } } });
  const type = v?.product.type ?? "LICENSE_KEY";
  const res = type === "DIGITAL_ACCOUNT"
    ? await addAccountStock(variantId, rawLines, opts)
    : await addLicenseKeys(variantId, rawLines, opts);
  if (opts.force && res.relisted > 0) {
    await prisma.auditLog.create({
      data: {
        actorType: "ADMIN", action: "inventory.relist.forced",
        entityType: "ProductVariant", entityId: variantId,
        after: {
          relisted: res.relisted,
          by: opts.actorLabel ?? "bot-admin",
          note: "re-listed values still held by a live order, at the admin's confirmation",
        },
      },
    }).catch(() => undefined);
  }
  return { ...res, type };
}

// ───────────── In-bot product-creation wizard helpers ─────────────

export interface CategoryBrief { id: string; name: string; emoji: string | null }

export async function listCategoriesBrief(): Promise<CategoryBrief[]> {
  const rows = await prisma.category.findMany({
    where: { deletedAt: null }, orderBy: { sortOrder: "asc" },
  });
  return rows.map((c) => ({ id: c.id, name: c.name, emoji: c.emoji }));
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "item";
}

async function uniqueSlug(base: string): Promise<string> {
  let slug = base;
  for (let i = 0; i < 50; i++) {
    const exists = await prisma.product.findUnique({ where: { slug } });
    if (!exists) return slug;
    slug = `${base}-${Math.floor(Math.random() * 9000 + 1000)}`;
  }
  return `${base}-${Date.now()}`;
}

export async function createCategoryQuick(name: string): Promise<CategoryBrief> {
  let slug = slugify(name);
  const clash = await prisma.category.findUnique({ where: { slug } });
  if (clash) slug = `${slug}-${Math.floor(Math.random() * 9000 + 1000)}`;
  const c = await prisma.category.create({ data: { name: name.slice(0, 120), slug } });
  return { id: c.id, name: c.name, emoji: c.emoji };
}

async function ensureUncategorized(): Promise<string> {
  const c = await prisma.category.upsert({
    where: { slug: "uncategorized" },
    create: { name: "Uncategorized", slug: "uncategorized", sortOrder: 999 },
    update: {},
  });
  return c.id;
}

/** Product types offered by the bot wizard. */
export const WIZARD_TYPES: Record<string, { type: string; fulfillmentMode: "AUTOMATIC" | "MANUAL"; label: string }> = {
  key: { type: "LICENSE_KEY", fulfillmentMode: "AUTOMATIC", label: "License Key" },
  acct: { type: "DIGITAL_ACCOUNT", fulfillmentMode: "AUTOMATIC", label: "Account" },
  other: { type: "MANUAL_SERVICE", fulfillmentMode: "MANUAL", label: "Manual service" },
};

/** Create a product with one "Standard" variant + prices, as a DRAFT. */
export async function createProductFull(input: {
  name: string;
  nameHtml?: string;
  description?: string;
  descriptionHtml?: string;
  typeKey: string;
  categoryId?: string;
  priceInrMinor: number;
  priceUsdMinor?: number;
}): Promise<{ productId: string; existed?: boolean }> {
  // Same product name already in the catalogue? Reuse it instead of creating a
  // near-duplicate — one product, one listing, stock accumulates on it.
  const dupe = await prisma.product.findFirst({
    where: { deletedAt: null, name: { equals: input.name.trim(), mode: "insensitive" } },
    select: { id: true },
  });
  if (dupe) return { productId: dupe.id, existed: true };

  const spec = WIZARD_TYPES[input.typeKey] ?? { type: "LICENSE_KEY", fulfillmentMode: "AUTOMATIC" as const, label: "License Key" };
  const categoryId = input.categoryId || (await ensureUncategorized());
  const slug = await uniqueSlug(slugify(input.name));
  const retail = await prisma.priceTier.findUniqueOrThrow({ where: { name: "RETAIL" } });

  return prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        slug,
        name: input.name.slice(0, 200),
        nameHtml: input.nameHtml?.slice(0, 500) || null,
        description: input.description?.slice(0, 4000) || null,
        descriptionHtml: input.descriptionHtml?.slice(0, 8000) || null,
        type: spec.type as never,
        status: "DRAFT",
        categoryId,
        fulfillmentMode: spec.fulfillmentMode,
      },
    });
    const variant = await tx.productVariant.create({
      data: { productId: product.id, name: "Standard", sku: `${slug}-STD`.toUpperCase().slice(0, 120) },
    });
    // Always store both currencies so the bot shows a price in INR and USD.
    // If no USD given, derive it from INR (USDT≈USD, so INR ÷ INR-per-USDT rate).
    let usdMinor = input.priceUsdMinor;
    if (!usdMinor || usdMinor <= 0) {
      const rate = usdtRate("INR");
      usdMinor = Math.max(1, Math.round(input.priceInrMinor / rate));
    }
    const prices: Array<{ currency: "INR" | "USD"; amountMinor: number }> = [
      { currency: "INR", amountMinor: input.priceInrMinor },
      { currency: "USD", amountMinor: usdMinor },
    ];
    for (const p of prices) {
      await tx.variantPrice.create({
        data: { variantId: variant.id, tierId: retail.id, currency: p.currency, amountMinor: p.amountMinor },
      });
    }
    return { productId: product.id };
  });
}

// ───────────── VIP per-user pricing ─────────────

export async function resolveUserByTelegramId(telegramId: string): Promise<{ id: string; label: string } | null> {
  const id = telegramId.trim().replace(/^@/, "");
  const user = /^\d+$/.test(id)
    ? await prisma.user.findUnique({ where: { telegramId: BigInt(id) } })
    : await prisma.user.findFirst({ where: { telegramHandle: id } });
  if (!user) return null;
  return { id: user.id, label: user.telegramHandle ? `@${user.telegramHandle}` : (user.firstName ?? String(user.telegramId)) };
}

export async function setVip(userId: string, isVip: boolean): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { isVip } });
}

export type PriceChannel = "BOTH" | "DIRECT" | "API";

/**
 * Set a customer's own price for a product. It has no expiry — it stands until
 * an admin removes it.
 *
 * The currency is the missing piece this used to skip: `UserPrice.currency`
 * defaults to USD in the schema, and nothing ever wrote it, so an admin who
 * followed the prompt ("send the amount in the customer's currency") and typed
 * 499 for an INR customer stored $4.99 — which then came back converted to about
 * ₹450. The price the operator set was never the price anyone paid. It now
 * follows the customer's own currency unless the caller states otherwise.
 */
export async function setUserPrice(
  userId: string,
  productId: string,
  amountMinor: number,
  channel: PriceChannel = "BOTH",
  currency?: "USD" | "INR",
  permanent = false,
): Promise<void> {
  const cur = currency
    ?? ((await prisma.user.findUnique({ where: { id: userId }, select: { currency: true } }))?.currency as "USD" | "INR" | undefined)
    ?? "USD";
  await prisma.userPrice.upsert({
    where: { userId_productId_channel: { userId, productId, channel } },
    create: { userId, productId, amountMinor, channel, currency: cur, permanent },
    update: { amountMinor, currency: cur, permanent },
  });
  await invalidate("cat:*");
}

export async function removeUserPrice(userId: string, productId: string, channel?: PriceChannel): Promise<void> {
  await prisma.userPrice.deleteMany({ where: { userId, productId, ...(channel ? { channel } : {}) } });
  await invalidate("cat:*");
}

export async function listUserPrices(userId: string): Promise<Array<{ productId: string; productName: string; amountMinor: number; channel: PriceChannel }>> {
  const rows = await prisma.userPrice.findMany({ where: { userId } });
  const products = await prisma.product.findMany({ where: { id: { in: rows.map((r) => r.productId) } }, select: { id: true, name: true } });
  const nameOf = new Map(products.map((p) => [p.id, p.name]));
  return rows.map((r) => ({ productId: r.productId, productName: nameOf.get(r.productId) ?? r.productId, amountMinor: r.amountMinor, channel: r.channel as PriceChannel }));
}

/** All per-user custom prices set for one product (for the admin product view). */
export async function setUserPricePermanent(userId: string, productId: string, channel: PriceChannel, permanent: boolean): Promise<void> {
  await prisma.userPrice.updateMany({ where: { userId, productId, channel }, data: { permanent } });
  await invalidate("cat:*");
}

export async function listProductUserPrices(productId: string): Promise<Array<{ userId: string; label: string; amountMinor: number; currency: string; channel: PriceChannel; permanent: boolean }>> {
  const rows = await prisma.userPrice.findMany({ where: { productId }, orderBy: { updatedAt: "desc" } });
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, telegramHandle: true, firstName: true, telegramId: true } });
  const labelOf = new Map(users.map((u) => [u.id, u.telegramHandle ? `@${u.telegramHandle}` : (u.firstName ?? String(u.telegramId))]));
  return rows.map((r) => ({ userId: r.userId, label: labelOf.get(r.userId) ?? r.userId, amountMinor: r.amountMinor, currency: r.currency as string, channel: r.channel as PriceChannel, permanent: r.permanent === true }));
}

/** Set the public (RETAIL) price for ALL variants of a product, in USD and/or INR. This is the price everyone sees. */
export async function setProductPublicPrice(
  productId: string,
  prices: { usdMinor?: number; inrMinor?: number },
  opts: { announce?: boolean } = {},
): Promise<{ oldMinor: number | null; newMinor: number | null; currency: "USD" | "INR" }> {
  const retail = await prisma.priceTier.findUniqueOrThrow({ where: { name: "RETAIL" } });
  const variants = await prisma.productVariant.findMany({ where: { productId, deletedAt: null } });
  // Capture the price BEFORE the update so we can tell customers what changed.
  const announceCurrency: "USD" | "INR" = prices.usdMinor && prices.usdMinor > 0 ? "USD" : "INR";
  const beforeRows = await prisma.variantPrice.findMany({
    where: { variantId: { in: variants.map((v) => v.id) }, tierId: retail.id, currency: announceCurrency },
    orderBy: { amountMinor: "asc" },
    take: 1,
  });
  const oldMinor = beforeRows[0]?.amountMinor ?? null;
  // Whichever currency you skip is derived from the other at the store rate, so a
  // product is never left unpriced for half your customers.
  // INR prices carry the surcharge so USDT stays the cheaper, instant option.
  let usd = prices.usdMinor && prices.usdMinor > 0 ? prices.usdMinor : 0;
  let inr = prices.inrMinor && prices.inrMinor > 0 ? prices.inrMinor : 0;
  if (usd > 0 && inr === 0) inr = priceInrFromUsd(usd);
  else if (inr > 0 && usd === 0) usd = priceUsdFromInr(inr);
  const entries: Array<["USD" | "INR", number]> = [];
  if (usd > 0) entries.push(["USD", usd]);
  if (inr > 0) entries.push(["INR", inr]);
  for (const v of variants) {
    for (const [currency, amt] of entries) {
      await prisma.variantPrice.upsert({
        where: { variantId_tierId_currency: { variantId: v.id, tierId: retail.id, currency } },
        create: { variantId: v.id, tierId: retail.id, currency, amountMinor: amt },
        update: { amountMinor: amt },
      });
    }
  }
  await prisma.product.update({ where: { id: productId }, data: { priceLocked: true } }); // keep this price through supplier re-syncs
  await invalidate("cat:*");

  const newMinor = (announceCurrency === "USD" ? usd : inr) || null;
  if (oldMinor !== null && newMinor !== null && newMinor < oldMinor) {
    // Price-drop watchers are told regardless of whether you broadcast publicly.
    const { notifyPriceDrop } = await import("./watch.service.js");
    void notifyPriceDrop(productId, newMinor, announceCurrency).catch(() => undefined);
  }
  if (opts.announce && oldMinor !== null && newMinor !== null && oldMinor !== newMinor) {
    const { announcePriceChange } = await import("./broadcast.service.js");
    await announcePriceChange(productId, oldMinor, newMinor, announceCurrency).catch(() => undefined);
  }
  return { oldMinor, newMinor, currency: announceCurrency };
}

/** Set the default store price (INR + derived USD) for all variants of a product. */
export async function setStoreDefaultPrice(productId: string, amountMinorInr: number): Promise<void> {
  const retail = await prisma.priceTier.findUniqueOrThrow({ where: { name: "RETAIL" } });
  const rate = usdtRate("INR");
  const usdMinor = Math.max(1, Math.round(amountMinorInr / rate));
  const variants = await prisma.productVariant.findMany({ where: { productId, deletedAt: null } });
  for (const v of variants) {
    for (const [currency, amt] of [["INR", amountMinorInr], ["USD", usdMinor]] as const) {
      await prisma.variantPrice.upsert({
        where: { variantId_tierId_currency: { variantId: v.id, tierId: retail.id, currency } },
        create: { variantId: v.id, tierId: retail.id, currency, amountMinor: amt },
        update: { amountMinor: amt },
      });
    }
  }
  await invalidate("cat:*");
}


// ───────────── Admin passcode (in-bot change, stored hashed) ─────────────
const _pcHash = (plain: string): string => createHash("sha256").update(plain).digest("hex");

export async function getAdminPasscodeHash(): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: "bot.admin_passcode" } });
  const v = row?.value as { hash?: string } | null | undefined;
  return v?.hash ?? null;
}

/** Set (or change) the in-bot admin passcode. Stored as a SHA-256 hash, never plaintext. */
export async function setAdminPasscode(plain: string): Promise<void> {
  const value = { hash: _pcHash(plain.trim()) };
  await prisma.setting.upsert({
    where: { key: "bot.admin_passcode" },
    create: { key: "bot.admin_passcode", value },
    update: { value },
  });
}

/** True if a passcode is configured either in the DB (in-bot) or via env. */
export async function isAdminPasscodeConfigured(envPasscode?: string | null): Promise<boolean> {
  if (envPasscode) return true;
  return (await getAdminPasscodeHash()) !== null;
}

/** Verify an entered passcode against the DB override (preferred) or the env value. */
export async function verifyAdminPasscode(plain: string, envPasscode?: string | null): Promise<boolean> {
  const dbHash = await getAdminPasscodeHash();
  if (dbHash) return _pcHash(plain.trim()) === dbHash;
  return !!envPasscode && plain === envPasscode;
}

// ───────────── Sales dashboard ─────────────
export interface SalesDashboard {
  revenueTodayMinor: Record<string, number>;
  revenue7dMinor: Record<string, number>;
  ordersToday: number;
  orders7d: number;
  topProducts: Array<{ name: string; qty: number }>;
  buyers: number;
  repeatBuyers: number;
  repeatRatePct: number;
}

const PAID_STATUSES = ["PAID", "COMPLETED", "PENDING_FULFILLMENT", "AWAITING_STOCK", "PARTIALLY_REFUNDED"] as const;

export async function getSalesDashboard(): Promise<SalesDashboard> {
  const now = Date.now();
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const start7d = new Date(now - 7 * 86_400_000);
  const start30d = new Date(now - 30 * 86_400_000);

  const paid7d = await prisma.order.findMany({
    where: { paidAt: { gte: start7d }, status: { in: [...PAID_STATUSES] } },
    select: { currency: true, walletUsedMinor: true, totalMinor: true, paidAt: true },
  });
  const revenueTodayMinor: Record<string, number> = {};
  const revenue7dMinor: Record<string, number> = {};
  let ordersToday = 0;
  for (const o of paid7d) {
    const val = o.walletUsedMinor + o.totalMinor;
    revenue7dMinor[o.currency] = (revenue7dMinor[o.currency] ?? 0) + val;
    if (o.paidAt && o.paidAt >= startToday) {
      revenueTodayMinor[o.currency] = (revenueTodayMinor[o.currency] ?? 0) + val;
      ordersToday++;
    }
  }

  const topRows = await prisma.orderItem.groupBy({
    by: ["productNameSnap"],
    where: { order: { paidAt: { gte: start30d }, status: { in: [...PAID_STATUSES] } } },
    _sum: { quantity: true },
    orderBy: { _sum: { quantity: "desc" } },
    take: 5,
  });
  const topProducts = topRows.map((r) => ({ name: r.productNameSnap, qty: r._sum.quantity ?? 0 }));

  const byUser = await prisma.order.groupBy({
    by: ["userId"],
    where: { paidAt: { not: null }, status: { in: [...PAID_STATUSES] } },
    _count: { _all: true },
  });
  const buyers = byUser.length;
  const repeatBuyers = byUser.filter((u) => u._count._all >= 2).length;
  const repeatRatePct = buyers ? Math.round((repeatBuyers / buyers) * 100) : 0;

  return { revenueTodayMinor, revenue7dMinor, ordersToday, orders7d: paid7d.length, topProducts, buyers, repeatBuyers, repeatRatePct };
}

// ───────────── Admin-managed custom emoji registry ─────────────
export interface CustomEmojiEntry { id: string; glyph: string }

export async function getCustomEmojiRegistry(): Promise<Record<string, CustomEmojiEntry>> {
  const row = await prisma.setting.findUnique({ where: { key: "ui.custom_emoji" } });
  return (row?.value as Record<string, CustomEmojiEntry> | undefined) ?? {};
}

export async function setCustomEmojiEntry(name: string, id: string, glyph: string): Promise<void> {
  const cur = await getCustomEmojiRegistry();
  cur[name.trim().toLowerCase().slice(0, 24)] = { id, glyph };
  await prisma.setting.upsert({ where: { key: "ui.custom_emoji" }, create: { key: "ui.custom_emoji", value: cur as object }, update: { value: cur as object } });
}

export async function removeCustomEmojiEntry(name: string): Promise<void> {
  const cur = await getCustomEmojiRegistry();
  delete cur[name];
  await prisma.setting.upsert({ where: { key: "ui.custom_emoji" }, create: { key: "ui.custom_emoji", value: cur as object }, update: { value: cur as object } });
}

// ───────────── Support live chat relay ─────────────
/** Deliver a support reply from an admin to a customer by user id. */
export async function dmUser(userId: string, text: string): Promise<boolean> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { telegramId: true } });
  if (!u?.telegramId) return false;
  const safe = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  await enqueueTelegramMessage(u.telegramId, `💬 <b>Support</b>\n${safe}`);
  return true;
}

// ───────────── Web admin password reset (from the bot) ─────────────
import { hash as argonHash } from "@node-rs/argon2";

/**
 * Set (or create) the web admin-panel super-admin credentials from the bot.
 * Hashes with argon2 — same scheme the web login verifies against.
 */
export async function setWebAdminPassword(email: string, password: string): Promise<{ ok: boolean; reason?: string }> {
  const mail = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return { ok: false, reason: "BAD_EMAIL" };
  if (password.length < 12) return { ok: false, reason: "WEAK" };
  const role = await prisma.role.findUnique({ where: { name: "SUPER_ADMIN" } });
  if (!role) return { ok: false, reason: "NO_ROLE" };
  const passwordHash = await argonHash(password, { memoryCost: 65536, timeCost: 3, parallelism: 4 });
  const user = await prisma.user.upsert({
    where: { email: mail },
    create: { email: mail, emailVerified: true, passwordHash, firstName: "Admin", currency: "USD", status: "ACTIVE", wallet: { create: { currency: "USD" } } },
    update: { passwordHash, status: "ACTIVE" },
  });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: role.id } },
    create: { userId: user.id, roleId: role.id },
    update: {},
  });
  // withRoleNames caches for 120s — drop it so a new admin is recognised at once.
  await invalidate("role:*").catch(() => undefined);
  return { ok: true };
}

// ───────────── Global post-delivery instructions ─────────────
/** Store-wide instructions appended after every order delivery (HTML). Empty = none. */
export async function getDeliveryInstructions(): Promise<string> {
  const row = await prisma.setting.findUnique({ where: { key: "delivery.instructions" } });
  return typeof row?.value === "string" ? row.value : "";
}

export async function setDeliveryInstructions(html: string): Promise<void> {
  const val = html.slice(0, 3500);
  await prisma.setting.upsert({ where: { key: "delivery.instructions" }, create: { key: "delivery.instructions", value: val }, update: { value: val } });
}

/** The formatted instructions message, or null when unset. */
export async function deliveryInstructionsMessage(): Promise<string | null> {
  const html = (await getDeliveryInstructions()).trim();
  return html ? `📋 <b>Important — please read</b>\n${html}` : null;
}

// ───────────── Users management ─────────────
export interface UserRow { id: string; label: string; telegramId: string; balanceMinor: number; currency: string; status: string; orders: number }

export async function listRecentUsers(limit = 12): Promise<UserRow[]> {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" }, take: limit,
    include: { wallet: true, _count: { select: { orders: true } } },
  });
  return users.map((u) => ({
    id: u.id,
    label: u.telegramHandle ? `@${u.telegramHandle}` : (u.firstName ?? String(u.telegramId ?? "user")),
    telegramId: String(u.telegramId ?? ""),
    balanceMinor: Number(u.wallet?.balanceMinor ?? 0n),
    currency: u.wallet?.currency ?? u.currency,
    status: u.status,
    orders: u._count.orders,
  }));
}

export async function getUserSummary(identifier: string): Promise<UserRow | null> {
  const id = identifier.trim().replace(/^@/, "");
  const u = /^\d+$/.test(id)
    ? await prisma.user.findUnique({ where: { telegramId: BigInt(id) }, include: { wallet: true, _count: { select: { orders: true } } } })
    : await prisma.user.findFirst({ where: { telegramHandle: id }, include: { wallet: true, _count: { select: { orders: true } } } });
  if (!u) return null;
  return {
    id: u.id,
    label: u.telegramHandle ? `@${u.telegramHandle}` : (u.firstName ?? String(u.telegramId ?? "user")),
    telegramId: String(u.telegramId ?? ""),
    balanceMinor: Number(u.wallet?.balanceMinor ?? 0n),
    currency: u.wallet?.currency ?? u.currency,
    status: u.status,
    orders: u._count.orders,
  };
}

export async function getUserById(userId: string): Promise<UserRow | null> {
  const u = await prisma.user.findUnique({ where: { id: userId }, include: { wallet: true, _count: { select: { orders: true } } } });
  if (!u) return null;
  return {
    id: u.id,
    label: u.telegramHandle ? `@${u.telegramHandle}` : (u.firstName ?? String(u.telegramId ?? "user")),
    telegramId: String(u.telegramId ?? ""),
    balanceMinor: Number(u.wallet?.balanceMinor ?? 0n),
    currency: u.wallet?.currency ?? u.currency,
    status: u.status,
    orders: u._count.orders,
  };
}

export async function setUserBanned(userId: string, banned: boolean): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { status: banned ? "BANNED" : "ACTIVE" } });
}

/** Add or deduct a user's wallet balance by user id (admin). Positive = add, negative = deduct. */
export async function adjustUserWalletById(
  userId: string,
  amountMinor: number,
  actorId?: string,
  opts: { note?: string; idempotencyKey?: string } = {},
): Promise<{ ok: boolean; newBalanceMinor?: bigint; currency?: string; duplicate?: boolean }> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { ok: false };
  // idempotencyKey is @unique on WalletTransaction, so passing "upi:<utr>" makes
  // double-crediting a single UPI payment impossible at the DATABASE level, no
  // matter how many times an approve button is tapped or redelivered.
  if (opts.idempotencyKey) {
    const seen = await prisma.walletTransaction.findFirst({
      where: { idempotencyKey: opts.idempotencyKey }, select: { id: true },
    });
    if (seen) return { ok: false, duplicate: true };
  }
  let newBalanceMinor: bigint;
  try {
    newBalanceMinor = await adjustWallet({
      userId, amountMinor: BigInt(amountMinor), type: "ADJUSTMENT",
      note: opts.note ?? "admin adjustment (bot)", actorId, idempotencyKey: opts.idempotencyKey,
    });
  } catch (e) {
    // Lost the race to a concurrent approval of the same reference.
    if ((e as { code?: string })?.code === "P2002") return { ok: false, duplicate: true };
    throw e;
  }
  const w = await prisma.wallet.findUnique({ where: { userId } });
  const currency = w?.currency ?? user.currency;
  if (user.telegramId !== null) {
    await enqueueTelegramMessage(user.telegramId, `💳 Your wallet was ${amountMinor >= 0 ? "credited" : "debited"} by an admin. New balance: <b>${(Number(newBalanceMinor) / 100).toFixed(2)} ${currency}</b>.`);
  }
  return { ok: true, newBalanceMinor, currency };
}


// ───────────── Flash-sale headline (admin-set hook) ─────────────
export async function getFlashHeadline(): Promise<string> {
  const row = await prisma.setting.findUnique({ where: { key: "flash.headline" } });
  return typeof row?.value === "string" ? row.value : "";
}

/**
 * Hooks for a sale post, rotated so the same customers do not see the identical
 * line every single time — a headline that never changes stops being read after
 * the second sale. The operator can paste their own set (one per line) in
 * 🔥 Flash Sale Headline; these are the fallback.
 */
const DEFAULT_FLASH_HOOKS = [
  "⚡🔥 <b>HURRY — FLASH SALE IS LIVE!</b> 🔥⚡",
  "🚨 <b>PRICE DROP — for a few hours only</b> 🚨",
  "🎯 <b>Today's deal is live</b> — and it will not last",
  "💥 <b>Big discount, small window</b> 💥",
  "⏰ <b>Sale started — the clock is running</b> ⏰",
  "🔥 <b>Cheapest it has been</b> — grab it before it is gone",
  "🎉 <b>Flash sale unlocked</b> 🎉",
  "🏃 <b>Quick — this price ends soon</b> 💨",
];

/**
 * The next hook to use, different from the last one. Round-robin through a
 * Redis counter so consecutive posts never repeat; falls back to the first
 * line if Redis is unavailable.
 */
export async function nextFlashHeadline(): Promise<string> {
  const configured = (await getFlashHeadline().catch(() => ""))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const pool = configured.length > 0 ? configured : DEFAULT_FLASH_HOOKS;
  if (pool.length === 1) return pool[0] as string;
  let idx = 0;
  try {
    const { getRedis } = await import("./redis.js");
    idx = (await getRedis().incr("flashhook:idx")) % pool.length;
  } catch {
    idx = Math.floor(Math.random() * pool.length);
  }
  return pool[idx] ?? (pool[0] as string);
}
export async function setFlashHeadline(html: string): Promise<void> {
  const v = html.slice(0, 400);
  await prisma.setting.upsert({ where: { key: "flash.headline" }, create: { key: "flash.headline", value: v }, update: { value: v } });
}

/**
 * One-off repair for account stock saved by the OLD buggy parser, which split a
 * pasted markdown email link inside "mailto:" and left the address in BOTH the
 * username and password. Decrypts, rejoins, re-parses and re-encrypts.
 */
export async function repairBrokenAccounts(): Promise<{ scanned: number; fixed: number }> {
  const masterKey = loadConfig().ENCRYPTION_MASTER_KEY;
  const rows = await prisma.digitalAccount.findMany({
    where: { deletedAt: null, status: { in: ["AVAILABLE", "RESERVED"] } },
    select: { id: true, usernameEncrypted: true, passwordEncrypted: true, twofaEncrypted: true },
  });
  let fixed = 0;
  for (const r of rows) {
    let u: string, pw: string;
    try {
      u = decryptSecret(r.usernameEncrypted, masterKey);
      pw = decryptSecret(r.passwordEncrypted, masterKey);
    } catch {
      continue; // cannot decrypt — leave it alone
    }
    const repaired = repairAccountPair(u, pw);
    if (!repaired || (repaired.id === u && repaired.pw === pw)) {
      // Not broken — still backfill the dedupe hash while we have it decrypted.
      await prisma.digitalAccount
        .update({ where: { id: r.id }, data: { usernameHash: sha256Hex(u.trim().toLowerCase()) } })
        .catch(() => undefined);
      continue;
    }
    await prisma.digitalAccount.update({
      where: { id: r.id },
      data: {
        usernameEncrypted: encryptSecret(repaired.id, masterKey),
        usernameHash: sha256Hex(repaired.id.trim().toLowerCase()),
        passwordEncrypted: encryptSecret(repaired.pw, masterKey),
        ...(repaired.twofa && !r.twofaEncrypted ? { twofaEncrypted: encryptSecret(repaired.twofa, masterKey) } : {}),
      },
    });
    fixed++;
  }
  if (fixed > 0) await invalidate("cat:*");
  return { scanned: rows.length, fixed };
}

export interface FundedUserRow {
  id: string;
  label: string;
  telegramId: string;
  balanceMinor: number;
  currency: string;
  bnplLimitMinor: number;
  bnplOwedMinor: number;
  status: string;
}

/** Customers who hold wallet money, owe BNPL, or have a BNPL limit set. */
export async function listFundedUsers(limit = 25): Promise<FundedUserRow[]> {
  const rows = await prisma.user.findMany({
    where: {
      deletedAt: null,
      OR: [
        { wallet: { balanceMinor: { gt: 0 } } },
        { bnplOutstandingMinor: { gt: 0 } },
        { bnplLimitMinor: { gt: 0 } },
      ],
    },
    include: { wallet: true },
    take: limit,
  });
  return rows
    .map((u) => ({
      id: u.id,
      label: u.telegramHandle ? `@${u.telegramHandle}` : (u.firstName ?? String(u.telegramId ?? "user")),
      telegramId: String(u.telegramId ?? ""),
      balanceMinor: Number(u.wallet?.balanceMinor ?? 0n),
      currency: u.wallet?.currency ?? u.currency,
      bnplLimitMinor: u.bnplLimitMinor,
      bnplOwedMinor: u.bnplOutstandingMinor,
      status: u.status,
    }))
    // Richest / most-owing first — that is what an admin wants to see.
    .sort((a, b) => b.balanceMinor + b.bnplOwedMinor - (a.balanceMinor + a.bnplOwedMinor));
}

export interface WalletHistoryRow {
  type: string;
  amountMinor: number;
  balanceAfterMinor: number;
  note: string | null;
  at: Date;
}

/** Wallet transaction history for one customer (newest first). */
export async function getUserWalletHistory(userId: string, limit = 12): Promise<{ currency: string; rows: WalletHistoryRow[] }> {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) return { currency: "USD", rows: [] };
  const txns = await prisma.walletTransaction.findMany({
    where: { walletId: wallet.id },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return {
    currency: wallet.currency,
    rows: txns.map((t) => ({
      type: t.type,
      amountMinor: Number(t.amountMinor),
      balanceAfterMinor: Number(t.balanceAfterMinor),
      note: t.referenceNote,
      at: t.createdAt,
    })),
  };
}

/** Close a customer's BNPL: clear the credit limit (and optionally write off what is owed). */
export async function closeBnpl(userId: string, writeOff = false): Promise<{ ok: boolean; clearedMinor: number }> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { bnplOutstandingMinor: true } });
  if (!u) return { ok: false, clearedMinor: 0 };
  await prisma.user.update({
    where: { id: userId },
    data: { bnplLimitMinor: 0, ...(writeOff ? { bnplOutstandingMinor: 0 } : {}) },
  });
  return { ok: true, clearedMinor: writeOff ? u.bnplOutstandingMinor : 0 };
}

/**
 * One value delivered to EVERY buyer (a shared redemption link, invite, or
 * coupon). While set, the product is never out of stock and no inventory is
 * consumed. Pass null to clear it and go back to unit stock.
 */
export async function setProductManualStock(productId: string, qty: number | null): Promise<void> {
  await prisma.product.update({
    where: { id: productId },
    data: { manualStock: qty !== null && qty >= 0 ? Math.round(qty) : null },
  });
  await invalidate("cat:*");
}

export async function setProductReusableStock(productId: string, qty: number | null): Promise<void> {
  await prisma.product.update({
    where: { id: productId },
    data: { reusableStock: qty !== null && qty >= 0 ? Math.round(qty) : null },
  });
  await invalidate("cat:*");
}

export async function setProductReusableSecret(productId: string, value: string | null): Promise<void> {
  const masterKey = loadConfig().ENCRYPTION_MASTER_KEY;
  await prisma.product.update({
    where: { id: productId },
    data: { reusableSecretEnc: value && value.trim() ? encryptSecret(value.trim(), masterKey) : null },
  });
  await invalidate("cat:*");
}

export async function getProductReusableSecret(productId: string): Promise<string | null> {
  const p = await prisma.product.findUnique({ where: { id: productId }, select: { reusableSecretEnc: true } });
  if (!p?.reusableSecretEnc) return null;
  try { return decryptSecret(p.reusableSecretEnc, loadConfig().ENCRYPTION_MASTER_KEY); } catch { return null; }
}

// ───────────── Bulk categorisation ─────────────

export interface CatAdminRow {
  id: string;
  name: string;
  emoji: string | null;
  productCount: number;
  isActive: boolean;
  sortOrder: number;
}

/** Categories with their live product counts, for the admin manager. */
export async function listCategoriesAdmin(): Promise<CatAdminRow[]> {
  const rows = await prisma.category.findMany({
    where: { deletedAt: null },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { _count: { select: { products: { where: { deletedAt: null } } } } },
  });
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    emoji: c.emoji,
    productCount: c._count.products,
    isActive: c.isActive,
    sortOrder: c.sortOrder,
  }));
}

export interface ProductPickRow {
  id: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  visible: boolean;
}

/**
 * One page of products for the bulk categoriser. Paged and searchable, because a
 * shop with a synced supplier catalogue has far too many to scroll.
 */
export async function listProductsForCategorising(opts: {
  page?: number;
  pageSize?: number;
  search?: string;
  /** "none" = only uncategorised, or a category id to see what's already in it. */
  filter?: string;
} = {}): Promise<{ items: ProductPickRow[]; page: number; pages: number; total: number }> {
  const pageSize = Math.min(50, Math.max(5, opts.pageSize ?? 12));
  const where = {
    deletedAt: null,
    ...(opts.search ? { name: { contains: opts.search, mode: "insensitive" as const } } : {}),
    // categoryId is required on Product, so "uncategorised" means the
    // Uncategorized bucket rather than a null.
    ...(opts.filter === "none"
      ? { category: { slug: "uncategorized" } }
      : opts.filter && opts.filter !== "all"
        ? { categoryId: opts.filter }
        : {}),
  };
  const total = await prisma.product.count({ where });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, opts.page ?? 1), pages);
  const rows = await prisma.product.findMany({
    where,
    orderBy: { name: "asc" },
    skip: (page - 1) * pageSize,
    take: pageSize,
    select: { id: true, name: true, categoryId: true, status: true, category: { select: { name: true } } },
  });
  return {
    items: rows.map((p) => ({
      id: p.id,
      name: p.name,
      categoryId: p.categoryId,
      categoryName: p.category?.name ?? null,
      visible: p.status === "ACTIVE",
    })),
    page,
    pages,
    total,
  };
}

/** Ids matching the current filter, for "select all". */
export async function productIdsForCategorising(filter?: string, search?: string, cap = 500): Promise<string[]> {
  const rows = await prisma.product.findMany({
    where: {
      deletedAt: null,
      ...(search ? { name: { contains: search, mode: "insensitive" as const } } : {}),
      ...(filter === "none" ? { category: { slug: "uncategorized" } } : filter && filter !== "all" ? { categoryId: filter } : {}),
    },
    orderBy: { name: "asc" },
    take: cap,
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Move many products into one category in a single statement. */
export async function bulkSetCategory(productIds: string[], categoryId: string): Promise<number> {
  const ids = [...new Set(productIds)].slice(0, 500);
  if (ids.length === 0) return 0;
  const cat = await prisma.category.findFirst({ where: { id: categoryId, deletedAt: null }, select: { id: true } });
  if (!cat) return 0;
  const r = await prisma.product.updateMany({ where: { id: { in: ids }, deletedAt: null }, data: { categoryId } });
  await invalidate("cat:*");
  return r.count;
}

/** Set a category's emoji — it becomes the tile icon in the customer grid. */
export async function setCategoryEmoji(categoryId: string, emoji: string | null): Promise<void> {
  await prisma.category.update({ where: { id: categoryId }, data: { emoji: emoji?.slice(0, 8) ?? null } });
  await invalidate("cat:*");
}

export async function renameCategory(categoryId: string, name: string): Promise<void> {
  await prisma.category.update({ where: { id: categoryId }, data: { name: name.slice(0, 120) } });
  await invalidate("cat:*");
}

/**
 * Hide or show a whole category. Its products keep their own status — this only
 * removes the tile from the grid, so nothing is silently unpublished.
 */
export async function setCategoryActive(categoryId: string, isActive: boolean): Promise<void> {
  await prisma.category.update({ where: { id: categoryId }, data: { isActive } });
  await invalidate("cat:*");
}

/**
 * Delete a category. Its products are moved to Uncategorized rather than deleted —
 * losing a category must never take the products with it.
 */
export async function deleteCategory(categoryId: string): Promise<{ moved: number }> {
  const fallback = await ensureUncategorized();
  if (fallback === categoryId) return { moved: 0 };
  const r = await prisma.product.updateMany({ where: { categoryId }, data: { categoryId: fallback } });
  await prisma.category.update({ where: { id: categoryId }, data: { deletedAt: new Date(), isActive: false } });
  await invalidate("cat:*");
  return { moved: r.count };
}
