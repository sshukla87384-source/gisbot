import { cached } from "@gis/core";
import { prisma } from "@gis/database";
import { Controller, Get, Module, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { RequirePermission } from "../common/permissions.decorator.js";

const RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };

@ApiBearerAuth()
@ApiTags("analytics")
@Controller("analytics")
export class AnalyticsController {
  @RequirePermission("analytics.read")
  @Get("overview")
  async overview(@Query("range") range?: string) {
    const days = RANGE_DAYS[range ?? "30d"] ?? 30;
    return cached(`analytics:overview:${days}`, 300, async () => {
      const since = new Date(Date.now() - days * 86_400_000);
      const paidStatuses = ["PAID", "COMPLETED", "PENDING_FULFILLMENT"] as const;

      const revenueRows = await prisma.order.groupBy({
        by: ["currency"],
        where: { status: { in: paidStatuses as unknown as never }, paidAt: { gte: since } },
        _sum: { subtotalMinor: true, discountMinor: true },
        _count: { _all: true },
      });
      const revenue = revenueRows.map((r) => {
        const gross = (r._sum.subtotalMinor ?? 0) - (r._sum.discountMinor ?? 0);
        const count = r._count._all;
        return { currency: r.currency, grossMinor: gross, orders: count, aovMinor: count > 0 ? Math.round(gross / count) : 0 };
      });

      const [orderCount, newUsers, pendingManualCount, refunds] = await Promise.all([
        prisma.order.count({ where: { status: { in: paidStatuses as unknown as never }, paidAt: { gte: since } } }),
        prisma.user.count({ where: { createdAt: { gte: since } } }),
        prisma.order.count({ where: { status: "PENDING_FULFILLMENT" } }),
        prisma.refund.aggregate({ where: { status: "PROCESSED", processedAt: { gte: since } }, _count: { _all: true }, _sum: { amountMinor: true } }),
      ]);

      const topRows = await prisma.orderItem.groupBy({
        by: ["productNameSnap"],
        where: { order: { paidAt: { gte: since }, status: { in: paidStatuses as unknown as never } } },
        _count: { _all: true },
        orderBy: { _count: { productNameSnap: "desc" } },
        take: 5,
      });
      const topProducts = topRows.map((t) => ({ name: t.productNameSnap, count: t._count._all }));

      const lowStock = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(*)::bigint AS n FROM (
          SELECT v."id"
          FROM "ProductVariant" v JOIN "Product" p ON p."id" = v."productId"
          LEFT JOIN "LicenseKey" k ON k."variantId" = v."id"
          WHERE v."deletedAt" IS NULL AND v."isActive" = true AND p."type" = 'LICENSE_KEY'
          GROUP BY v."id", v."lowStockThreshold"
          HAVING COUNT(k."id") FILTER (WHERE k."status" = 'AVAILABLE' AND k."deletedAt" IS NULL) <= v."lowStockThreshold"
        ) s`;

      return {
        range: `${days}d`,
        revenue,
        orderCount,
        newUsers,
        pendingManualCount,
        refundCount: refunds._count._all,
        refundedMinor: refunds._sum.amountMinor ?? 0,
        topProducts,
        lowStockCount: Number(lowStock[0]?.n ?? 0),
      };
    });
  }
}

@Module({ controllers: [AnalyticsController] })
export class AnalyticsModule {}
