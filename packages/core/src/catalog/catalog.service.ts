import { prisma, type Currency } from "@gis/database";
import { CoreError, PAGE_SIZE } from "@gis/shared";
import { cached } from "../redis.js";
import { effectivePriceMinor, isSaleActive } from "../pricing.js";

const CACHE_TTL = 60;

export interface CategoryNode {
  id: string;
  name: string;
  emoji: string | null;
  hasChildren: boolean;
}

export interface ProductListItem {
  id: string;
  name: string;
  iconEmoji: string | null;
  fromPriceMinor: number | null;
  onSale: boolean;
  inStock: boolean;
}

export interface Paged<T> {
  items: T[];
  page: number;
  pages: number;
  total: number;
}

export interface VariantView {
  id: string;
  name: string;
  priceMinor: number | null; // effective (post-sale) price
  originalPriceMinor: number | null; // pre-sale price when a sale is active
  stock: number;
}

export interface ProductView {
  id: string;
  name: string;
  nameHtml: string | null;
  description: string | null;
  descriptionHtml: string | null;
  imageUrl: string | null;
  iconEmoji: string | null;
  onSale: boolean;
  salePercentBp: number | null;
  saleEndsAt: Date | null;
  type: string;
  fulfillmentMode: string;
  activationGuide: string | null;
  isPlatform: boolean;
  variants: VariantView[];
}

async function variantStock(variantId: string, type: string): Promise<number> {
  if (type === "LICENSE_KEY")
    return prisma.licenseKey.count({ where: { variantId, status: "AVAILABLE", deletedAt: null } });
  if (type === "DIGITAL_ACCOUNT")
    return prisma.digitalAccount.count({ where: { variantId, status: "AVAILABLE", deletedAt: null } });
  return Number.MAX_SAFE_INTEGER; // downloads / manual services are not unit-stocked
}

export async function listCategories(parentId: string | null): Promise<CategoryNode[]> {
  return cached(`cat:tree:${parentId ?? "root"}`, CACHE_TTL, async () => {
    const cats = await prisma.category.findMany({
      where: { parentId, isActive: true, deletedAt: null },
      orderBy: { sortOrder: "asc" },
      include: { _count: { select: { children: true } } },
    });
    return cats.map((c) => ({
      id: c.id,
      name: c.name,
      emoji: c.emoji,
      hasChildren: c._count.children > 0,
    }));
  });
}

export async function getVariantAvailable(variantId: string): Promise<number> {
  const v = await prisma.productVariant.findUnique({
    where: { id: variantId },
    include: { product: { select: { type: true } } },
  });
  if (!v) return 0;
  return variantStock(variantId, v.product.type);
}

export async function listProducts(opts: {
  categoryId?: string;
  search?: string;
  featuredOnly?: boolean;
  currency: Currency;
  page: number;
  pageSize?: number;
  userId?: string;
  channel?: "DIRECT" | "API";
}): Promise<Paged<ProductListItem>> {
  const { categoryId, search, featuredOnly, currency, page, userId, channel = "DIRECT" } = opts;
  const size = opts.pageSize ?? PAGE_SIZE;
  const cacheKey = `cat:prods:${categoryId ?? "all"}:${featuredOnly ? "f" : "a"}:${search ?? ""}:${currency}:${page}:${size}:${userId ?? "-"}:${channel}`;
  return cached(cacheKey, CACHE_TTL, async () => {
    const where = {
      status: "ACTIVE" as const,
      deletedAt: null,
      ...(categoryId ? { categoryId } : {}),
      ...(featuredOnly ? { isFeatured: true } : {}),
      ...(search ? { name: { contains: search, mode: "insensitive" as const } } : {}),
    };
    const total = await prisma.product.count({ where });
    const pages = Math.max(1, Math.ceil(total / size));
    const products = await prisma.product.findMany({
      where,
      orderBy: [{ pinRank: "desc" }, { sortOrder: "asc" }, { createdAt: "desc" }],
      skip: (page - 1) * size,
      take: size,
      include: {
        variants: {
          where: { isActive: true, deletedAt: null },
          include: { prices: { where: { currency, tier: { name: "RETAIL" } } } },
        },
      },
    });

    const overrideMap = userId
      ? await resolveUserPriceMap(userId, products.map((p) => p.id), channel)
      : new Map<string, number>();
    const items: ProductListItem[] = [];
    for (const p of products) {
      const onSale = isSaleActive(p);
      const ov = overrideMap.get(p.id);
      const priced = ov !== undefined ? [ov] : p.variants.flatMap((v) => v.prices.map((pr) => effectivePriceMinor(pr.amountMinor, p)));
      let inStock = false;
      for (const v of p.variants) {
        if ((await variantStock(v.id, p.type)) > 0) {
          inStock = true;
          break;
        }
      }
      items.push({
        id: p.id,
        name: p.name,
        iconEmoji: p.iconEmoji,
        fromPriceMinor: priced.length > 0 ? Math.min(...priced) : null,
        onSale,
        inStock,
      });
    }
    return { items, page, pages, total };
  });
}


/** Resolve a user's per-product override for a channel: a channel-specific price (DIRECT/API) wins over a BOTH price. */
async function resolveUserPriceMap(userId: string, productIds: string[], channel: "DIRECT" | "API"): Promise<Map<string, number>> {
  const rows = await prisma.userPrice.findMany({ where: { userId, productId: { in: productIds }, channel: { in: [channel, "BOTH"] } } });
  const map = new Map<string, number>();
  for (const r of rows) {
    const cur = map.get(r.productId);
    if (cur === undefined || r.channel === channel) map.set(r.productId, r.amountMinor);
  }
  return map;
}

async function resolveUserPrice(userId: string, productId: string, channel: "DIRECT" | "API"): Promise<number | null> {
  const m = await resolveUserPriceMap(userId, [productId], channel);
  return m.get(productId) ?? null;
}

export async function getProductView(productId: string, currency: Currency, userId?: string, channel: "DIRECT" | "API" = "DIRECT"): Promise<ProductView> {
  const p = await prisma.product.findFirst({
    where: { id: productId, status: "ACTIVE", deletedAt: null },
    include: {
      variants: {
        where: { isActive: true, deletedAt: null },
        orderBy: { sortOrder: "asc" },
        include: { prices: { where: { currency, tier: { name: "RETAIL" } } } },
      },
    },
  });
  if (!p) throw new CoreError("PRODUCT_NOT_FOUND");

  const onSale = isSaleActive(p);
  const override = userId ? await resolveUserPrice(userId, p.id, channel) : null;
  const variants: VariantView[] = [];
  for (const v of p.variants) {
    const base = v.prices[0]?.amountMinor ?? null;
    const eff = override ?? (base === null ? null : effectivePriceMinor(base, p));
    variants.push({
      id: v.id,
      name: v.name,
      priceMinor: eff,
      originalPriceMinor: override !== null && base !== null ? base : (onSale && base !== null ? base : null),
      stock: await variantStock(v.id, p.type),
    });
  }
  return {
    id: p.id,
    name: p.name,
    nameHtml: p.nameHtml,
    description: p.description,
    descriptionHtml: p.descriptionHtml,
    imageUrl: p.imageUrl,
    iconEmoji: p.iconEmoji,
    onSale,
    salePercentBp: p.salePercentBp,
    saleEndsAt: p.saleEndsAt,
    type: p.type,
    fulfillmentMode: p.fulfillmentMode,
    activationGuide: p.activationGuide,
    isPlatform: p.resellerId === null,
    variants,
  };
}

export async function getProductIdBySlug(slug: string): Promise<string | null> {
  const p = await prisma.product.findFirst({
    where: { slug, status: "ACTIVE", deletedAt: null },
    select: { id: true },
  });
  return p?.id ?? null;
}
