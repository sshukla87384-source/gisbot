import { prisma, type Currency } from "@gis/database";
import { CoreError, PAGE_SIZE } from "@gis/shared";
import { cached } from "../redis.js";
import { effectivePriceMinor, isSaleActive, priceInCurrency } from "../pricing.js";

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
  totalStock: number | null; // units available across variants; null = unlimited (downloads/manual)
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
  description: string | null;
  highlight: string | null;
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

export async function listProducts(opts: {
  categoryId?: string;
  search?: string;
  featuredOnly?: boolean;
  currency: Currency;
  page: number;
}): Promise<Paged<ProductListItem>> {
  const { categoryId, search, featuredOnly, currency, page } = opts;
  const cacheKey = `cat:prods:${categoryId ?? "all"}:${featuredOnly ? "f" : "a"}:${search ?? ""}:${currency}:${page}`;
  return cached(cacheKey, CACHE_TTL, async () => {
    const where = {
      status: "ACTIVE" as const,
      deletedAt: null,
      ...(categoryId ? { categoryId } : {}),
      ...(featuredOnly ? { isFeatured: true } : {}),
      ...(search ? { name: { contains: search, mode: "insensitive" as const } } : {}),
    };
    const total = await prisma.product.count({ where });
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const products = await prisma.product.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        variants: {
          where: { isActive: true, deletedAt: null },
          include: { prices: { where: { tier: { name: "RETAIL" } } } },
        },
      },
    });

    const items: ProductListItem[] = [];
    for (const p of products) {
      const onSale = isSaleActive(p);
      const priced: number[] = [];
      for (const v of p.variants) {
        const base = priceInCurrency(v.prices, currency);
        if (base !== null) priced.push(effectivePriceMinor(base, p));
      }
      let inStock = false;
      let totalStock = 0;
      let unlimited = false;
      for (const v of p.variants) {
        const s = await variantStock(v.id, p.type);
        if (s >= Number.MAX_SAFE_INTEGER) unlimited = true;
        else totalStock += s;
      }
      inStock = unlimited || totalStock > 0;
      items.push({
        id: p.id,
        name: p.name,
        iconEmoji: p.iconEmoji,
        fromPriceMinor: priced.length > 0 ? Math.min(...priced) : null,
        onSale,
        inStock,
        totalStock: unlimited ? null : totalStock,
      });
    }
    return { items, page, pages, total };
  });
}

export async function getProductView(productId: string, currency: Currency): Promise<ProductView> {
  const p = await prisma.product.findFirst({
    where: { id: productId, status: "ACTIVE", deletedAt: null },
    include: {
      variants: {
        where: { isActive: true, deletedAt: null },
        orderBy: { sortOrder: "asc" },
        include: { prices: { where: { tier: { name: "RETAIL" } } } },
      },
    },
  });
  if (!p) throw new CoreError("PRODUCT_NOT_FOUND");

  const onSale = isSaleActive(p);
  const variants: VariantView[] = [];
  for (const v of p.variants) {
    const base = priceInCurrency(v.prices, currency);
    variants.push({
      id: v.id,
      name: v.name,
      priceMinor: base === null ? null : effectivePriceMinor(base, p),
      originalPriceMinor: onSale && base !== null ? base : null,
      stock: await variantStock(v.id, p.type),
    });
  }
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    highlight: p.highlight,
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

export interface VariantPurchaseInfo {
  productId: string;
  productName: string;
  iconEmoji: string | null;
  variantId: string;
  variantName: string;
  unitPriceMinor: number | null;
  originalPriceMinor: number | null;
  onSale: boolean;
  stock: number;
  currency: Currency;
}

/** Everything needed to render the quantity picker / buy-now flow for one variant. */
export async function getVariantForPurchase(variantId: string, currency: Currency): Promise<VariantPurchaseInfo> {
  const v = await prisma.productVariant.findFirst({
    where: { id: variantId, isActive: true, deletedAt: null },
    include: { product: true, prices: { where: { tier: { name: "RETAIL" } } } },
  });
  if (!v || v.product.status !== "ACTIVE" || v.product.deletedAt !== null) throw new CoreError("VARIANT_NOT_FOUND");
  const p = v.product;
  const onSale = isSaleActive(p);
  const base = priceInCurrency(v.prices, currency);
  return {
    productId: p.id,
    productName: p.name,
    iconEmoji: p.iconEmoji,
    variantId: v.id,
    variantName: v.name,
    unitPriceMinor: base === null ? null : effectivePriceMinor(base, p),
    originalPriceMinor: onSale && base !== null ? base : null,
    onSale,
    stock: await variantStock(v.id, p.type),
    currency,
  };
}

export async function getProductIdBySlug(slug: string): Promise<string | null> {
  const p = await prisma.product.findFirst({
    where: { slug, status: "ACTIVE", deletedAt: null },
    select: { id: true },
  });
  return p?.id ?? null;
}
