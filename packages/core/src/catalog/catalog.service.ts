import { prisma, type Currency } from "@gis/database";
import { CoreError, PAGE_SIZE } from "@gis/shared";
import { cached } from "../redis.js";

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
  fromPriceMinor: number | null;
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
  priceMinor: number | null;
  stock: number;
}

export interface ProductView {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
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
          include: { prices: { where: { currency, tier: { name: "RETAIL" } } } },
        },
      },
    });

    const items: ProductListItem[] = [];
    for (const p of products) {
      const priced = p.variants.flatMap((v) => v.prices.map((pr) => pr.amountMinor));
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
        fromPriceMinor: priced.length > 0 ? Math.min(...priced) : null,
        inStock,
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
        include: { prices: { where: { currency, tier: { name: "RETAIL" } } } },
      },
    },
  });
  if (!p) throw new CoreError("PRODUCT_NOT_FOUND");

  const variants: VariantView[] = [];
  for (const v of p.variants) {
    variants.push({
      id: v.id,
      name: v.name,
      priceMinor: v.prices[0]?.amountMinor ?? null,
      stock: await variantStock(v.id, p.type),
    });
  }
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    imageUrl: p.imageUrl,
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
