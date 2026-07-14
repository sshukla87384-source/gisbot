import { getProductView, listCategories, listProducts } from "@gis/core";
import { prisma, type Currency } from "@gis/database";
import { Controller, Get, Module, Param, Query, Req, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { notFound } from "../common/errors.js";
import { DeveloperApiGuard, Scopes, type DeveloperRequest } from "../common/developer.guard.js";
import { Public } from "../common/permissions.decorator.js";

function currencyOf(q: unknown): Currency {
  const c = String((q as { currency?: string })?.currency ?? "INR").toUpperCase();
  return (c === "USD" ? "USD" : "INR") as Currency;
}

/**
 * Public Developer API (v1) — API-key authenticated, scoped, rate-limited.
 * Base path: /api/v1/developer   ·   Docs: /api/v1/developer/docs
 * Auth: send your key as the `X-API-Key` header (or `Authorization: Bearer`).
 */
@ApiTags("developer")
@ApiSecurity("apiKey")
@Public()
@UseGuards(DeveloperApiGuard)
@Controller("developer")
export class DeveloperController {
  /** Verify your key and see its scopes. */
  @Get("ping")
  ping(@Req() req: DeveloperRequest) {
    return { ok: true, key: req.apiKey?.name, scopes: req.apiKey?.scopes ?? [] };
  }

  @Scopes("catalog:read")
  @Get("categories")
  async categories() {
    return listCategories(null);
  }

  @Scopes("catalog:read")
  @Get("products")
  async products(@Query() query: Record<string, string>) {
    const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
    return listProducts({
      currency: currencyOf(query),
      page,
      search: query.search,
      categoryId: query.categoryId,
      featuredOnly: query.featured === "true",
    });
  }

  @Scopes("catalog:read")
  @Get("products/:id")
  async product(@Param("id") id: string, @Query() query: Record<string, string>) {
    try {
      return await getProductView(id, currencyOf(query));
    } catch {
      throw notFound("Product");
    }
  }

  @Scopes("catalog:read")
  @Get("products/:id/stock")
  async stock(@Param("id") id: string, @Query() query: Record<string, string>) {
    try {
      const p = await getProductView(id, currencyOf(query));
      return {
        productId: p.id,
        name: p.name,
        onSale: p.onSale,
        variants: p.variants.map((v) => ({
          id: v.id, name: v.name, priceMinor: v.priceMinor,
          originalPriceMinor: v.originalPriceMinor, inStock: v.stock > 0, stock: v.stock,
        })),
      };
    } catch {
      throw notFound("Product");
    }
  }

  @Scopes("orders:read")
  @Get("orders/:orderNumber")
  async order(@Param("orderNumber") orderNumber: string) {
    const o = await prisma.order.findUnique({
      where: { orderNumber },
      include: { items: { select: { productNameSnap: true, variantNameSnap: true, quantity: true } } },
    });
    if (!o) throw notFound("Order");
    return {
      orderNumber: o.orderNumber,
      status: o.status,
      currency: o.currency,
      totalMinor: o.totalMinor,
      createdAt: o.createdAt,
      paidAt: o.paidAt,
      items: o.items.map((i) => ({ product: i.productNameSnap, variant: i.variantNameSnap, quantity: i.quantity })),
    };
  }
}

@Module({ controllers: [DeveloperController] })
export class DeveloperModule {}
