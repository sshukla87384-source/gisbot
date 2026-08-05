import { createHash } from "node:crypto";
import { loadConfig } from "@gis/config";
import { prisma } from "@gis/database";
import { encryptSecret, decryptSecret, normalizeLicenseKey, sha256Hex } from "@gis/shared";
import { enqueueTelegramMessage } from "./queues.js";
import { adjustWallet } from "./wallet/wallet.service.js";
import { announceRestock } from "./broadcast.service.js";
import { invalidate, cached } from "./redis.js";
import { usdtRate } from "./fx.js";
import { splitCredential, sanitizeCredentialLine, repairAccountPair } from "./orders/assign.js";

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

export interface ProductBrief { id: string; reusable?: boolean; reusableStock?: number | null; manualStock?: number | null; name: string; nameHtml: string | null; status: string; iconEmoji: string | null; onSalePct: number | null; pinRank: number; fulfillmentMode: string; slug: string; type: string; allowPwChange: boolean; supplierId: string | null; warranty: boolean; warrantyDays: number | null }

type PRow = { id: string; name: string; nameHtml: string | null; status: string; iconEmoji: string | null; salePercentBp: number | null; pinRank: number; fulfillmentMode: string; slug: string; type: string; allowPasswordChange: boolean; supplierId: string | null; warranty: boolean; warrantyDays: number | null };
function toBrief(p: PRow): ProductBrief {
  return { id: p.id, reusable: Boolean((p as unknown as { reusableSecretEnc?: string | null }).reusableSecretEnc), reusableStock: (p as unknown as { reusableStock?: number | null }).reusableStock ?? null, manualStock: (p as unknown as { manualStock?: number | null }).manualStock ?? null, name: p.name, nameHtml: p.nameHtml, status: p.status, iconEmoji: p.iconEmoji, onSalePct: p.salePercentBp, pinRank: p.pinRank, fulfillmentMode: p.fulfillmentMode, slug: p.slug, type: p.type, allowPwChange: p.allowPasswordChange, supplierId: p.supplierId, warranty: p.warranty, warrantyDays: p.warrantyDays };
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

export const BUTTON_LABEL_KEYS = ["shop", "orders", "wallet", "support", "referral", "currency", "language", "developer"] as const;
export type ButtonLabelKey = (typeof BUTTON_LABEL_KEYS)[number];

export interface ButtonOverride { label?: string; icon?: string }

/** Admin overrides for main-menu buttons: custom label and/or premium-emoji icon (empty when unset). */
export async function getButtonConfig(): Promise<Partial<Record<ButtonLabelKey, ButtonOverride>>> {
  const row = await prisma.setting.findUnique({ where: { key: "ui.button_labels" } });
  return (row?.value as Partial<Record<ButtonLabelKey, ButtonOverride>> | undefined) ?? {};
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

/** Replacement window in days (null/0 = unlimited while warranty is on). */
export async function setProductWarrantyDays(productId: string, days: number | null): Promise<void> {
  await prisma.product.update({ where: { id: productId }, data: { warrantyDays: days && days > 0 ? days : null } });
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
}

export interface VariantBrief { id: string; name: string; sku: string }
export async function listVariantsBrief(productId: string): Promise<VariantBrief[]> {
  const rows = await prisma.productVariant.findMany({
    where: { productId, deletedAt: null }, orderBy: { sortOrder: "asc" },
  });
  return rows.map((v) => ({ id: v.id, name: v.name, sku: v.sku }));
}

/** Bulk-add license keys to a variant (one per line). Returns counts. */
export async function addLicenseKeys(variantId: string, rawKeys: string[]): Promise<{ added: number; skipped: number; relisted: number }> {
  const masterKey = loadConfig().ENCRYPTION_MASTER_KEY;
  let added = 0, skipped = 0, relisted = 0;
  for (const raw of rawKeys) {
    const value = raw.trim();
    if (!value) continue;
    const keyHash = sha256Hex(normalizeLicenseKey(value));
    const exists = await prisma.licenseKey.findUnique({ where: { variantId_keyHash: { variantId, keyHash } } });
    if (exists) {
      // Already AVAILABLE → a true duplicate, skip. Already sold/disabled (e.g. a
      // test delivery) → put it BACK on the shelf instead of silently skipping,
      // and never create a second row for the same key.
      if (exists.status === "AVAILABLE") { skipped++; continue; }
      // NEVER resurrect a key that belongs to a live order — the buyer can still
      // see it in My Orders, and nulling orderItemId would drop the unique
      // constraint that prevents the same key being delivered twice.
      if (exists.orderItemId) {
        const oi = await prisma.orderItem.findUnique({
          where: { id: exists.orderItemId },
          select: { order: { select: { status: true } } },
        });
        const dead = !oi || ["CANCELLED", "EXPIRED", "REFUNDED"].includes(oi.order.status);
        if (!dead) { skipped++; continue; } // still owned by a real customer
      }
      await prisma.licenseKey.update({
        where: { id: exists.id },
        data: { status: "AVAILABLE", orderItemId: null, soldAt: null, reservedUntil: null, deletedAt: null },
      });
      relisted++;
      continue;
    }
    await prisma.licenseKey.create({
      data: { variantId, keyEncrypted: encryptSecret(value, masterKey), keyHash, supplier: "bot-admin" },
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
  return { added, skipped, relisted };
}

/** Add digital-account stock (username/password lines) for a DIGITAL_ACCOUNT variant. */
export async function addAccountStock(variantId: string, rawLines: string[]): Promise<{ added: number; skipped: number; relisted: number }> {
  const masterKey = loadConfig().ENCRYPTION_MASTER_KEY;
  let added = 0, skipped = 0, relisted = 0;
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
        select: { orderItem: { select: { order: { select: { status: true } } } } },
      });
      const live = holders.some((h) => !["CANCELLED", "EXPIRED", "REFUNDED"].includes(h.orderItem.order.status));
      if (live) { skipped++; continue; }
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
  return { added, skipped, relisted };
}

/** Type-aware stock add: license keys for LICENSE_KEY variants, accounts for DIGITAL_ACCOUNT. */
export async function addStock(variantId: string, rawLines: string[]): Promise<{ added: number; skipped: number; relisted: number; type: string }> {
  const v = await prisma.productVariant.findUnique({ where: { id: variantId }, include: { product: { select: { type: true } } } });
  const type = v?.product.type ?? "LICENSE_KEY";
  if (type === "DIGITAL_ACCOUNT") return { ...(await addAccountStock(variantId, rawLines)), type };
  return { ...(await addLicenseKeys(variantId, rawLines)), type };
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
  const rate = usdtRate("INR"); // INR per 1 USD
  let usd = prices.usdMinor && prices.usdMinor > 0 ? prices.usdMinor : 0;
  let inr = prices.inrMinor && prices.inrMinor > 0 ? prices.inrMinor : 0;
  if (usd > 0 && inr === 0) inr = Math.max(1, Math.round(usd * rate));
  else if (inr > 0 && usd === 0) usd = Math.max(1, Math.round(inr / rate));
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
export async function adjustUserWalletById(userId: string, amountMinor: number, actorId?: string): Promise<{ ok: boolean; newBalanceMinor?: bigint; currency?: string }> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { ok: false };
  const newBalanceMinor = await adjustWallet({ userId, amountMinor: BigInt(amountMinor), type: "ADJUSTMENT", note: "admin adjustment (bot)", actorId });
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
