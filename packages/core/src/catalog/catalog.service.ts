import { prisma, type Currency } from "@gis/database";
import { CoreError, PAGE_SIZE } from "@gis/shared";
import { translateMany } from "../translate.service.js";
import { cached } from "../redis.js";
import { effectivePriceMinor, isSaleActive } from "../pricing.js";

const CACHE_TTL = 60;

export interface CategoryNode {
  id: string;
  name: string;
  emoji: string | null;
  hasChildren: boolean;
}

export interface ProductListVariant {
  id: string;
  name: string;
  priceMinor: number | null;
  stock: number;
}

export interface ProductListItem {
  id: string;
  name: string;
  iconEmoji: string | null;
  fromPriceMinor: number | null;
  onSale: boolean;
  inStock: boolean;
  /** Total units across variants; null = unlimited (not unit-stocked). */
  stock: number | null;
  /** true = stocked/fulfilled by an upstream supplier, still auto-delivered. */
  supplierBacked: boolean;
  buttonStyle: string | null;
  iconCustomEmojiId: string | null;
  /** Buyable variants — API consumers order by `variants[].id`. */
  variants: ProductListVariant[];
}

/** Pull the first custom (premium) emoji id out of stored *Html fields, for use as a button icon. */
export function firstCustomEmojiId(html: string | null | undefined): string | null {
  if (!html) return null;
  const m = html.match(/emoji-id="(\d+)"/);
  return m?.[1] ?? null;
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
  supplierBacked: boolean;
  buyButtonText: string | null;
  buttonStyle: string | null;
  iconCustomEmojiId: string | null;
  variants: VariantView[];
}

/** Sentinel for products that are not unit-stocked (downloads, manual services). */
export const UNLIMITED_STOCK = Number.MAX_SAFE_INTEGER;

async function variantStock(
  variantId: string,
  type: string,
  supplier?: { supplierId: string | null; supplierStock: number | null },
): Promise<number> {
  // Supplier-backed products are stocked at the supplier, not locally.
  if (supplier?.supplierId && supplier.supplierStock !== null && supplier.supplierStock !== undefined) {
    return supplier.supplierStock;
  }
  if (type === "LICENSE_KEY")
    return prisma.licenseKey.count({ where: { variantId, status: "AVAILABLE", deletedAt: null } });
  if (type === "DIGITAL_ACCOUNT")
    return prisma.digitalAccount.count({ where: { variantId, status: "AVAILABLE", deletedAt: null } });
  return UNLIMITED_STOCK; // downloads / manual services are not unit-stocked
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
    include: { product: { select: { type: true, supplierId: true, supplierStock: true } } },
  });
  if (!v) return 0;
  return variantStock(variantId, v.product.type, v.product);
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
  locale?: string;
}): Promise<Paged<ProductListItem>> {
  const { categoryId, search, featuredOnly, currency, page, userId, channel = "DIRECT" } = opts;
  const locale = opts.locale ?? "en";
  const size = opts.pageSize ?? PAGE_SIZE;
  const cacheKey = `cat:prods:${categoryId ?? "all"}:${featuredOnly ? "f" : "a"}:${search ?? ""}:${currency}:${page}:${size}:${userId ?? "-"}:${channel}:${locale}`;
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
      // One stock lookup per variant, reused for inStock and the variant rows.
      const variantRows = await Promise.all(
        p.variants.map(async (v) => {
          const base = v.prices[0]?.amountMinor ?? null;
          return {
            id: v.id,
            name: v.name,
            priceMinor: ov ?? (base === null ? null : effectivePriceMinor(base, p)),
            stock: await variantStock(v.id, p.type, p),
          };
        }),
      );
      const inStock = variantRows.some((v) => v.stock > 0);
      const unlimited = variantRows.some((v) => v.stock >= UNLIMITED_STOCK);
      const stock = unlimited ? null : variantRows.reduce((n, v) => n + v.stock, 0);
      items.push({
        id: p.id,
        name: p.name,
        iconEmoji: p.iconEmoji,
        variants: variantRows,
        fromPriceMinor: priced.length > 0 ? Math.min(...priced) : null,
        onSale,
        inStock,
        stock,
        supplierBacked: p.supplierId !== null,
        buttonStyle: p.buttonStyle,
        iconCustomEmojiId: firstCustomEmojiId(p.nameHtml),
      });
    }
    if (locale !== "en" && items.length > 0) {
      const names = await translateMany(items.map((i) => i.name), locale);
      items.forEach((it, i) => { it.name = names[i] ?? it.name; });
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

export async function getProductView(productId: string, currency: Currency, userId?: string, channel: "DIRECT" | "API" = "DIRECT", locale = "en"): Promise<ProductView> {
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
  const variants: VariantView[] = await Promise.all(
    p.variants.map(async (v) => {
      const base = v.prices[0]?.amountMinor ?? null;
      const eff = override ?? (base === null ? null : effectivePriceMinor(base, p));
      return {
        id: v.id,
        name: v.name,
        priceMinor: eff,
        originalPriceMinor: override !== null && base !== null ? base : (onSale && base !== null ? base : null),
        stock: await variantStock(v.id, p.type, p),
      };
    }),
  );
  const [trName, trDesc] = locale === "en" ? [p.name, p.description ?? ""] : await translateMany([p.name, p.description], locale);
  return {
    id: p.id,
    name: trName || p.name,
    nameHtml: p.nameHtml,
    description: locale === "en" ? p.description : (trDesc || p.description),
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
    supplierBacked: p.supplierId !== null,
    buyButtonText: p.buyButtonText,
    buttonStyle: p.buttonStyle,
    iconCustomEmojiId: firstCustomEmojiId(p.nameHtml),
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
