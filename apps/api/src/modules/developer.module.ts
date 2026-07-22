import { addToCart, checkoutWithWallet, clearCart, getProductView, getWallet, listCategories, listProducts } from "@gis/core";
import { prisma, type Currency } from "@gis/database";
import { Body, Controller, Get, Module, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { isCoreError } from "@gis/shared";
import { z } from "zod";
import { ApiError, forbidden, notFound } from "../common/errors.js";
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

const purchaseSchema = z.object({
  variantId: z.string().min(1),
  quantity: z.number().int().min(1).max(99).optional().default(1),
});

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
  async order(@Param("orderNumber") orderNumber: string, @Req() req: DeveloperRequest) {
    const ownerId = req.apiKey?.ownerUserId ?? null;
    const o = await prisma.order.findFirst({
      where: { orderNumber, ...(ownerId ? { userId: ownerId } : {}) },
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

  /** Your wallet balance (the account this key is linked to). */
  @Scopes("wallet:read")
  @Get("wallet")
  async wallet(@Req() req: DeveloperRequest) {
    const userId = req.apiKey?.ownerUserId;
    if (!userId) throw forbidden("This API key isn't linked to a user account.");
    const w = await getWallet(userId);
    return { balanceMinor: Number(w.balanceMinor), currency: w.currency };
  }

  /**
   * Purchase a variant, paid from your wallet balance. Delivers instantly for
   * auto-fulfilled products (secrets are returned in the response).
   * Body: { "variantId": "...", "quantity": 1 }
   */
  @Scopes("orders:write")
  @Post("orders")
  async purchase(@Body() body: unknown, @Req() req: DeveloperRequest) {
    const userId = req.apiKey?.ownerUserId;
    if (!userId) throw forbidden("This API key isn't linked to a user account, so it can't purchase.");
    const parsed = purchaseSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(400, "VALIDATION_FAILED", parsed.error.issues[0]?.message ?? "Invalid body.");
    const { variantId, quantity } = parsed.data;
    try {
      await clearCart(userId);
      await addToCart(userId, variantId, quantity);
      const r = await checkoutWithWallet(userId);
      return {
        orderNumber: r.orderNumber,
        status: r.status,
        currency: r.currency,
        totalMinor: r.totalMinor,
        pendingManualItems: r.pendingManualItems,
        items: r.deliveries.map((d) => ({
          product: d.productName,
          variant: d.variantName,
          kind: d.kind,
          secret: d.secret,
          activationGuide: d.activationGuide,
        })),
      };
    } catch (e) {
      if (isCoreError(e)) {
        const status = e.code === "INSUFFICIENT_BALANCE" ? 402 : 400;
        throw new ApiError(status, e.code, e.message);
      }
      throw e;
    }
  }
}

@Module({ controllers: [DeveloperController] })
export class DeveloperModule {}
