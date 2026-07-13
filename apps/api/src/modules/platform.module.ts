import { prisma } from "@gis/database";
import { Body, Controller, Get, Module, Patch, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { writeAudit } from "../common/audit.js";
import { filterValue, filterDateRange, paginated, parseList } from "../common/pagination.js";
import { Public, RequirePermission } from "../common/permissions.decorator.js";
import { validate } from "../common/zod-body.pipe.js";
import type { ApiRequest } from "../common/types.js";

const settingBody = z.object({ key: z.string().min(1).max(120), value: z.unknown() });

@ApiBearerAuth()
@ApiTags("platform")
@Controller()
export class PlatformController {
  @Public()
  @Get("health")
  health() {
    return { status: "ok" };
  }

  @Public()
  @Get("health/ready")
  async ready() {
    await prisma.$queryRaw`SELECT 1`;
    return { status: "ready" };
  }

  @RequirePermission("analytics.read")
  @Get("settings")
  async settings() {
    return prisma.setting.findMany({ orderBy: { key: "asc" } });
  }

  @RequirePermission("settings.write")
  @Patch("settings")
  async setSetting(@Body() body: unknown, @Req() req: ApiRequest) {
    const { key, value } = validate(settingBody, body);
    const before = await prisma.setting.findUnique({ where: { key } });
    const s = await prisma.setting.upsert({
      where: { key },
      create: { key, value: (value ?? null) as never, updatedById: req.user!.id },
      update: { value: (value ?? null) as never, updatedById: req.user!.id },
    });
    await writeAudit(req, "setting.update", "Setting", key, before?.value, s.value);
    return s;
  }

  @RequirePermission("audit.read")
  @Get("audit-logs")
  async auditLogs(@Query() query: unknown) {
    const list = parseList(query, ["createdAt"]);
    const range = filterDateRange(list, "createdAt");
    const where = {
      ...(filterValue(list, "actorId") ? { actorId: filterValue(list, "actorId") } : {}),
      ...(filterValue(list, "entityType") ? { entityType: filterValue(list, "entityType") } : {}),
      ...(filterValue(list, "entityId") ? { entityId: filterValue(list, "entityId") } : {}),
      ...(filterValue(list, "action") ? { action: { contains: filterValue(list, "action")! } } : {}),
      ...(range ? { createdAt: range } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: list.skip, take: list.take }),
    ]);
    return paginated(rows, list.page, list.perPage, total);
  }
}

@Module({ controllers: [PlatformController] })
export class PlatformModule {}
