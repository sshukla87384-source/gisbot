import { loadConfig } from "@gis/config";
import { prisma } from "@gis/database";
import { encryptSecret, normalizeLicenseKey, sha256Hex } from "@gis/shared";
import { enqueueTelegramMessage } from "./queues.js";
import { adjustWallet } from "./wallet/wallet.service.js";
import { announceRestock } from "./broadcast.service.js";
import { invalidate } from "./redis.js";

/** Compact dashboard figures for the in-bot admin panel. */
export async function getAdminStats(): Promise<{
  users: number;
  activeProducts: number;
  ordersToday: number;
  paidToday: number;
  pendingPayments: number;
  lowStockVariants: number;
}> {
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
  | (OrderBrief & { items: Array<{ name: string; variant: string; qty: number }>; userLabel: string })
  | null
> {
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, user: { select: { firstName: true, telegramHandle: true, telegramId: true } } },
  });
  if (!o) return null;
  return {
    id: o.id, orderNumber: o.orderNumber, status: o.status, totalMinor: o.totalMinor, currency: o.currency,
    binanceAmount: o.binanceAmount, createdAt: o.createdAt, itemCount: o.items.length,
    items: o.items.map((i) => ({ name: i.productNameSnap, variant: i.variantNameSnap, qty: i.quantity })),
    userLabel: o.user.telegramHandle ? `@${o.user.telegramHandle}` : (o.user.firstName ?? String(o.user.telegramId ?? "user")),
  };
}

export async function adminCancelOrder(orderId: string): Promise<void> {
  await prisma.order.updateMany({
    where: { id: orderId, status: { in: ["PENDING_PAYMENT"] } },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });
}

/** Reject a pending manual order and notify the buyer. */
export async function rejectManualOrder(orderId: string): Promise<{ ok: boolean; orderNumber?: string }> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { user: { select: { telegramId: true } } },
  });
  if (!order || order.status !== "PENDING_PAYMENT") return { ok: false };
  await prisma.order.update({ where: { id: orderId }, data: { status: "CANCELLED", cancelledAt: new Date() } });
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

export interface ProductBrief { id: string; name: string; status: string; iconEmoji: string | null; onSalePct: number | null; pinRank: number }

export async function listProductsBrief(limit = 20): Promise<ProductBrief[]> {
  const rows = await prisma.product.findMany({
    where: { deletedAt: null }, orderBy: [{ pinRank: "desc" }, { status: "asc" }, { createdAt: "desc" }], take: limit,
  });
  return rows.map((p) => ({ id: p.id, name: p.name, status: p.status, iconEmoji: p.iconEmoji, onSalePct: p.salePercentBp, pinRank: p.pinRank }));
}

/** Pin a product to the top / a chosen priority. Higher rank = higher in the list; 0 = unpinned. */
export async function setProductPinRank(productId: string, pinRank: number): Promise<void> {
  await prisma.product.update({ where: { id: productId }, data: { pinRank: Math.max(0, Math.round(pinRank)) } });
  await invalidate("cat:*");
}

export async function adminDeleteProduct(id: string): Promise<void> {
  await prisma.product.update({ where: { id }, data: { deletedAt: new Date(), status: "ARCHIVED" } });
}

export async function setProductName(productId: string, name: string): Promise<void> {
  await prisma.product.update({ where: { id: productId }, data: { name: name.slice(0, 200) } });
  await invalidate("cat:*");
}

export async function setProductDescription(productId: string, description: string): Promise<void> {
  await prisma.product.update({ where: { id: productId }, data: { description: description.slice(0, 4000) } });
  await invalidate("cat:*");
}

export async function setProductImage(productId: string, imageUrl: string): Promise<void> {
  await prisma.product.update({ where: { id: productId }, data: { imageUrl } });
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
}

export interface VariantBrief { id: string; name: string; sku: string }
export async function listVariantsBrief(productId: string): Promise<VariantBrief[]> {
  const rows = await prisma.productVariant.findMany({
    where: { productId, deletedAt: null }, orderBy: { sortOrder: "asc" },
  });
  return rows.map((v) => ({ id: v.id, name: v.name, sku: v.sku }));
}

/** Bulk-add license keys to a variant (one per line). Returns counts. */
export async function addLicenseKeys(variantId: string, rawKeys: string[]): Promise<{ added: number; skipped: number }> {
  const masterKey = loadConfig().ENCRYPTION_MASTER_KEY;
  let added = 0, skipped = 0;
  for (const raw of rawKeys) {
    const value = raw.trim();
    if (!value) continue;
    const keyHash = sha256Hex(normalizeLicenseKey(value));
    const exists = await prisma.licenseKey.findUnique({ where: { variantId_keyHash: { variantId, keyHash } } });
    if (exists) { skipped++; continue; }
    await prisma.licenseKey.create({
      data: { variantId, keyEncrypted: encryptSecret(value, masterKey), keyHash, supplier: "bot-admin" },
    });
    added++;
  }
  if (added > 0) {
    const v = await prisma.productVariant.findUnique({ where: { id: variantId }, select: { productId: true } });
    if (v) await announceRestock(v.productId, added, { createdById: "bot-admin" }).catch(() => undefined);
  }
  return { added, skipped };
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
  description?: string;
  typeKey: string;
  categoryId?: string;
  priceInrMinor: number;
  priceUsdMinor?: number;
}): Promise<{ productId: string }> {
  const spec = WIZARD_TYPES[input.typeKey] ?? { type: "LICENSE_KEY", fulfillmentMode: "AUTOMATIC" as const, label: "License Key" };
  const categoryId = input.categoryId || (await ensureUncategorized());
  const slug = await uniqueSlug(slugify(input.name));
  const retail = await prisma.priceTier.findUniqueOrThrow({ where: { name: "RETAIL" } });

  return prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        slug,
        name: input.name.slice(0, 200),
        description: input.description?.slice(0, 4000) || null,
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
      const rate = loadConfig().BINANCE_USDT_INR_RATE || 90;
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

export async function setUserPrice(userId: string, productId: string, amountMinor: number, channel: PriceChannel = "BOTH"): Promise<void> {
  await prisma.userPrice.upsert({
    where: { userId_productId_channel: { userId, productId, channel } },
    create: { userId, productId, amountMinor, channel },
    update: { amountMinor },
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
export async function listProductUserPrices(productId: string): Promise<Array<{ userId: string; label: string; amountMinor: number; channel: PriceChannel }>> {
  const rows = await prisma.userPrice.findMany({ where: { productId }, orderBy: { updatedAt: "desc" } });
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, telegramHandle: true, firstName: true, telegramId: true } });
  const labelOf = new Map(users.map((u) => [u.id, u.telegramHandle ? `@${u.telegramHandle}` : (u.firstName ?? String(u.telegramId))]));
  return rows.map((r) => ({ userId: r.userId, label: labelOf.get(r.userId) ?? r.userId, amountMinor: r.amountMinor, channel: r.channel as PriceChannel }));
}

/** Set the default store price (INR + derived USD) for all variants of a product. */
export async function setStoreDefaultPrice(productId: string, amountMinorInr: number): Promise<void> {
  const retail = await prisma.priceTier.findUniqueOrThrow({ where: { name: "RETAIL" } });
  const rate = loadConfig().BINANCE_USDT_INR_RATE || 90;
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
