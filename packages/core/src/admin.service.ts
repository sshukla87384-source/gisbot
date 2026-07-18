import { loadConfig } from "@gis/config";
import { prisma } from "@gis/database";
import { encryptSecret, normalizeLicenseKey, sha256Hex } from "@gis/shared";
import { enqueueTelegramMessage } from "./queues.js";
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

export interface ProductBrief { id: string; name: string; status: string; iconEmoji: string | null; onSalePct: number | null }

export async function listProductsBrief(limit = 20): Promise<ProductBrief[]> {
  const rows = await prisma.product.findMany({
    where: { deletedAt: null }, orderBy: [{ status: "asc" }, { createdAt: "desc" }], take: limit,
  });
  return rows.map((p) => ({ id: p.id, name: p.name, status: p.status, iconEmoji: p.iconEmoji, onSalePct: p.salePercentBp }));
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
