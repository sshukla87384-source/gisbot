import { prisma } from "@gis/database";
import { Body, Controller, Delete, Get, Module, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { writeAudit } from "../common/audit.js";
import { notFound } from "../common/errors.js";
import { paginated, parseList } from "../common/pagination.js";
import { RequirePermission } from "../common/permissions.decorator.js";
import { validate } from "../common/zod-body.pipe.js";
import type { ApiRequest } from "../common/types.js";

const base = z.object({
  code: z.string().min(3).max(40).regex(/^[A-Z0-9_-]+$/),
  type: z.enum(["FIXED", "PERCENTAGE"]),
  valueMinor: z.number().int().min(0).optional(),
  valuePct: z.number().int().min(1).max(10000).optional(), // basis points
  currency: z.enum(["INR", "USD", "XTR"]).optional(),
  maxDiscountMinor: z.number().int().min(0).optional(),
  minCartMinor: z.number().int().min(0).default(0),
  usageLimit: z.number().int().min(1).optional(),
  perUserLimit: z.number().int().min(1).default(1),
  firstPurchaseOnly: z.boolean().default(false),
  newUserOnly: z.boolean().default(false),
  isStackable: z.boolean().default(false),
  startsAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().optional(),
  // Scope targets. The evaluator has honoured PRODUCT / CATEGORY / USER since
  // round 2, but nothing could CREATE one — the schema had no way to say which
  // products, categories or user a code was for, so every coupon was GLOBAL.
  scope: z.enum(["GLOBAL", "PRODUCT", "CATEGORY", "USER"]).default("GLOBAL"),
  productIds: z.array(z.string().min(1)).max(200).optional(),
  categoryIds: z.array(z.string().min(1)).max(200).optional(),
  allowedUserId: z.string().min(1).optional(),
});
const scopeIssues = (v: { scope?: string; productIds?: string[]; categoryIds?: string[]; allowedUserId?: string }, ctx: z.RefinementCtx): void => {
  if (v.scope === "PRODUCT" && !(v.productIds && v.productIds.length > 0))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "PRODUCT scope needs at least one productId", path: ["productIds"] });
  if (v.scope === "CATEGORY" && !(v.categoryIds && v.categoryIds.length > 0))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "CATEGORY scope needs at least one categoryId", path: ["categoryIds"] });
  if (v.scope === "USER" && !v.allowedUserId)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "USER scope needs allowedUserId", path: ["allowedUserId"] });
};
const createCoupon = base.superRefine((v, ctx) => {
  if (v.type === "FIXED" && (v.valueMinor === undefined || !v.currency))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "FIXED coupons need valueMinor and currency", path: ["valueMinor"] });
  if (v.type === "PERCENTAGE" && v.valuePct === undefined)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "PERCENTAGE coupons need valuePct (basis points)", path: ["valuePct"] });
  scopeIssues(v, ctx);
});

/**
 * `productIds` is an input convenience; the Prisma side is the `products`
 * relation, and `categoryIds`/`allowedUserId` are plain columns. Split the
 * validated body into the shape `coupon.create`/`update` accept.
 */
function toCouponData<T extends { productIds?: string[] }>(v: T): Omit<T, "productIds"> & { products?: { set?: { id: string }[]; connect?: { id: string }[] } } {
  const { productIds, ...rest } = v;
  if (productIds === undefined) return rest;
  return { ...rest, products: { set: [], connect: productIds.map((id) => ({ id })) } };
}

@ApiBearerAuth()
@ApiTags("coupons")
@Controller("coupons")
export class CouponsController {
  @RequirePermission("coupons.read")
  @Get()
  async list(@Query() query: unknown) {
    const list = parseList(query, ["createdAt", "code", "expiresAt"]);
    const where = { deletedAt: null, ...(list.search ? { code: { contains: list.search.toUpperCase() } } : {}) };
    const [total, rows] = await Promise.all([
      prisma.coupon.count({ where }),
      prisma.coupon.findMany({ where, orderBy: list.orderBy, skip: list.skip, take: list.take }),
    ]);
    return paginated(rows, list.page, list.perPage, total);
  }

  @RequirePermission("coupons.write")
  @Post()
  async create(@Body() body: unknown, @Req() req: ApiRequest) {
    const v = validate(createCoupon, body);
    const { productIds, ...rest } = v;
    // `set` is an update-only operation; on create only `connect` is valid.
    const data = { ...rest, ...(productIds ? { products: { connect: productIds.map((id) => ({ id })) } } : {}) };
    const coupon = await prisma.coupon.create({ data });
    await writeAudit(req, "coupon.create", "Coupon", coupon.id, undefined, { code: coupon.code });
    return coupon;
  }

  @RequirePermission("coupons.write")
  @Patch(":id")
  async update(@Param("id") id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    const v = validate(base.partial().extend({ isActive: z.boolean().optional() }).superRefine(scopeIssues), body);
    const coupon = await prisma.coupon.update({ where: { id }, data: toCouponData(v) });
    await writeAudit(req, "coupon.update", "Coupon", id);
    return coupon;
  }

  @RequirePermission("coupons.write")
  @Delete(":id")
  async remove(@Param("id") id: string, @Req() req: ApiRequest) {
    await prisma.coupon.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
    await writeAudit(req, "coupon.delete", "Coupon", id);
    return { ok: true };
  }

  @RequirePermission("coupons.read")
  @Get(":id/usages")
  async usages(@Param("id") id: string, @Query() query: unknown) {
    // CouponUsage has no `createdAt`, so the "-createdAt" default would produce
    // an orderBy Prisma rejects now that the computed order is actually used.
    const list = parseList(query, ["usedAt"], "-usedAt");
    const [total, rows] = await Promise.all([
      prisma.couponUsage.count({ where: { couponId: id } }),
      prisma.couponUsage.findMany({ where: { couponId: id }, orderBy: list.orderBy, skip: list.skip, take: list.take }),
    ]);
    if (total === 0 && !(await prisma.coupon.findUnique({ where: { id } }))) throw notFound("Coupon");
    return paginated(rows, list.page, list.perPage, total);
  }
}

@Module({ controllers: [CouponsController] })
export class CouponsModule {}
