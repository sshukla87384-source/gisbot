import { announceProduct, invalidate } from "@gis/core";
import { loadConfig } from "@gis/config";
import { prisma } from "@gis/database";
import { BadRequestException, Body, Controller, Delete, Get, Module, Param, Patch, Post, Put, Query, Req, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { writeAudit } from "../common/audit.js";
import { notFound } from "../common/errors.js";
import { paginated, parseList, filterValue } from "../common/pagination.js";
import { RequirePermission } from "../common/permissions.decorator.js";
import { validate } from "../common/zod-body.pipe.js";
import type { ApiRequest } from "../common/types.js";

interface UploadedImage {
  originalname: string;
  buffer: Buffer;
  mimetype: string;
  size: number;
}

/** Coerce empty-string optional fields to null/undefined and ISO dates to Date. */
function normalizeProduct<T extends Record<string, unknown>>(data: T): T {
  const d = { ...data } as Record<string, unknown>;
  if (d.imageUrl === "") d.imageUrl = null;
  if (d.iconEmoji === "") d.iconEmoji = null;
  for (const k of ["saleStartsAt", "saleEndsAt"] as const) {
    if (!(k in d)) continue; // absent → leave unchanged
    if (d[k] === "" || d[k] == null) d[k] = null; // explicit clear
    else if (typeof d[k] === "string") d[k] = new Date(d[k] as string);
  }
  return d as T;
}

const productType = z.enum(["LICENSE_KEY", "DIGITAL_ACCOUNT", "SUBSCRIPTION", "DOWNLOAD", "MANUAL_SERVICE"]);
const fulfillMode = z.enum(["AUTOMATIC", "MANUAL"]);
const currency = z.enum(["INR", "USD", "XTR"]);

const createProduct = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(200).regex(/^[a-z0-9-]+$/),
  description: z.string().max(4000).optional(),
  type: productType,
  categoryId: z.string().min(1),
  fulfillmentMode: fulfillMode.default("AUTOMATIC"),
  activationGuide: z.string().max(4000).optional(),
  sourcingNote: z.string().max(1000).optional(),
  isFeatured: z.boolean().optional(),
  imageUrl: z.string().url().max(2000).optional().or(z.literal("")),
  iconEmoji: z.string().max(16).optional().or(z.literal("")),
  salePercentBp: z.number().int().min(0).max(9000).optional(),
  saleStartsAt: z.string().datetime().optional().or(z.literal("")),
  saleEndsAt: z.string().datetime().optional().or(z.literal("")),
});
const updateProduct = createProduct.partial().extend({
  status: z.enum(["DRAFT", "PENDING_APPROVAL", "ACTIVE", "PAUSED", "ARCHIVED"]).optional(),
});
const createVariant = z.object({
  name: z.string().min(1).max(120),
  sku: z.string().min(1).max(120),
  durationDays: z.number().int().positive().optional(),
  lowStockThreshold: z.number().int().min(0).optional(),
  subscriptionPlan: z.enum(["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL", "LIFETIME"]).optional(),
});
const updateVariant = createVariant.partial().extend({ isActive: z.boolean().optional() });
const pricesBody = z.object({
  prices: z.array(z.object({ tierName: z.string().default("RETAIL"), currency, amountMinor: z.number().int().min(0), compareAtMinor: z.number().int().min(0).optional() })).min(1),
});
const createCategory = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(120).regex(/^[a-z0-9-]+$/),
  parentId: z.string().optional(),
  emoji: z.string().max(8).optional(),
  sortOrder: z.number().int().optional(),
});

@ApiBearerAuth()
@ApiTags("catalog")
@Controller()
export class CatalogController {
  @RequirePermission("catalog.read")
  @Get("categories")
  async categories() {
    return prisma.category.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: "asc" } });
  }

  @RequirePermission("catalog.write")
  @Post("categories")
  async createCategory(@Body() body: unknown, @Req() req: ApiRequest) {
    const data = validate(createCategory, body);
    const cat = await prisma.category.create({ data });
    await invalidate("cat:*");
    await writeAudit(req, "category.create", "Category", cat.id, undefined, cat);
    return cat;
  }

  @RequirePermission("catalog.write")
  @Patch("categories/:id")
  async updateCategory(@Param("id") id: string, @Body() body: unknown) {
    const data = validate(createCategory.partial().extend({ isActive: z.boolean().optional() }), body);
    const cat = await prisma.category.update({ where: { id }, data });
    await invalidate("cat:*");
    return cat;
  }

  @RequirePermission("catalog.write")
  @Delete("categories/:id")
  async deleteCategory(@Param("id") id: string) {
    await prisma.category.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
    await invalidate("cat:*");
    return { ok: true };
  }

  @RequirePermission("catalog.read")
  @Get("products")
  async products(@Query() query: unknown) {
    const list = parseList(query, ["createdAt", "name", "sortOrder"]);
    const where = {
      deletedAt: null,
      ...(filterValue(list, "status") ? { status: filterValue(list, "status") as never } : {}),
      ...(filterValue(list, "categoryId") ? { categoryId: filterValue(list, "categoryId") } : {}),
      ...(list.search ? { name: { contains: list.search, mode: "insensitive" as const } } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        orderBy: list.orderBy,
        skip: list.skip,
        take: list.take,
        include: { category: { select: { name: true } }, _count: { select: { variants: true } } },
      }),
    ]);
    return paginated(rows, list.page, list.perPage, total);
  }

  @RequirePermission("catalog.read")
  @Get("products/:id")
  async product(@Param("id") id: string) {
    const p = await prisma.product.findUnique({
      where: { id },
      include: { category: true, variants: { where: { deletedAt: null }, include: { prices: { include: { tier: true } } } } },
    });
    if (!p) throw notFound("Product");
    return p;
  }

  @RequirePermission("catalog.write")
  @Post("products")
  async createProduct(@Body() body: unknown, @Req() req: ApiRequest) {
    const data = normalizeProduct(validate(createProduct, body));
    const p = await prisma.product.create({ data: { ...data, status: "DRAFT" } });
    await invalidate("cat:*");
    await writeAudit(req, "product.create", "Product", p.id, undefined, p);
    return p;
  }

  @RequirePermission("catalog.write")
  @Patch("products/:id")
  async updateProduct(@Param("id") id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    const data = normalizeProduct(validate(updateProduct, body));
    const before = await prisma.product.findUnique({ where: { id } });
    if (!before) throw notFound("Product");
    const p = await prisma.product.update({ where: { id }, data });
    await invalidate("cat:*");
    await writeAudit(req, "product.update", "Product", id, before, p);
    // Auto-announce the first time a product goes ACTIVE.
    if (before.status !== "ACTIVE" && p.status === "ACTIVE" && !before.announcedAt) {
      await announceProduct(p.id, { createdById: req.user!.id }).catch(() => undefined);
    }
    return p;
  }

  @RequirePermission("catalog.write")
  @Delete("products/:id")
  async deleteProduct(@Param("id") id: string, @Req() req: ApiRequest) {
    await prisma.product.update({ where: { id }, data: { deletedAt: new Date(), status: "ARCHIVED" } });
    await invalidate("cat:*");
    await writeAudit(req, "product.delete", "Product", id);
    return { ok: true };
  }

  @RequirePermission("broadcasts.send")
  @Post("products/:id/announce")
  async announce(@Param("id") id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    const opts = validate(z.object({ pin: z.boolean().default(false) }), body ?? {});
    const res = await announceProduct(id, { createdById: req.user!.id, pin: opts.pin, force: true });
    if (!res.announced) throw new BadRequestException("Product must be ACTIVE to announce");
    await writeAudit(req, "product.announce", "Product", id, undefined, { targets: res.targets });
    return res;
  }

  @RequirePermission("media.write")
  @Post("media/upload")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 8 * 1024 * 1024 } }))
  async uploadMedia(@UploadedFile() file: UploadedImage | undefined, @Req() req: ApiRequest) {
    if (!file) throw new BadRequestException("No file uploaded");
    const extByType: Record<string, string> = {
      "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/gif": "gif",
    };
    const ext = extByType[file.mimetype];
    if (!ext) throw new BadRequestException("Only PNG, JPG, WEBP or GIF images are allowed");
    const cfg = loadConfig();
    const name = `${randomUUID()}.${ext}`;
    await mkdir(cfg.MEDIA_DIR, { recursive: true });
    await writeFile(join(cfg.MEDIA_DIR, name), file.buffer);
    await prisma.media.create({
      data: {
        kind: "IMAGE",
        s3Key: name,
        fileName: file.originalname ?? name,
        contentType: file.mimetype,
        sizeBytes: BigInt(file.size ?? file.buffer.length),
        uploadedById: req.user?.id,
      },
    });
    const base = (cfg.PUBLIC_API_URL ?? "").replace(/\/$/, "");
    return { url: `${base}/media/${name}`, fileName: name };
  }

  @RequirePermission("catalog.write")
  @Post("products/:id/variants")
  async createVariant(@Param("id") productId: string, @Body() body: unknown) {
    const data = validate(createVariant, body);
    const v = await prisma.productVariant.create({ data: { ...data, productId } });
    await invalidate("cat:*");
    return v;
  }

  @RequirePermission("catalog.write")
  @Patch("variants/:id")
  async updateVariant(@Param("id") id: string, @Body() body: unknown) {
    const data = validate(updateVariant, body);
    const v = await prisma.productVariant.update({ where: { id }, data });
    await invalidate("cat:*");
    return v;
  }

  @RequirePermission("catalog.write")
  @Delete("variants/:id")
  async deleteVariant(@Param("id") id: string) {
    await prisma.productVariant.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
    await invalidate("cat:*");
    return { ok: true };
  }

  @RequirePermission("pricing.write")
  @Put("variants/:id/prices")
  async setPrices(@Param("id") variantId: string, @Body() body: unknown) {
    const { prices } = validate(pricesBody, body);
    for (const p of prices) {
      const tier = await prisma.priceTier.findUnique({ where: { name: p.tierName } });
      if (!tier) continue;
      await prisma.variantPrice.upsert({
        where: { variantId_tierId_currency: { variantId, tierId: tier.id, currency: p.currency } },
        create: { variantId, tierId: tier.id, currency: p.currency, amountMinor: p.amountMinor, compareAtMinor: p.compareAtMinor },
        update: { amountMinor: p.amountMinor, compareAtMinor: p.compareAtMinor },
      });
    }
    await invalidate("cat:*");
    return prisma.variantPrice.findMany({ where: { variantId }, include: { tier: true } });
  }
}

@Module({ controllers: [CatalogController] })
export class CatalogModule {}
