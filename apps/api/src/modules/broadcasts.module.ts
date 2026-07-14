import { sendBroadcast } from "@gis/core";
import { prisma } from "@gis/database";
import { Body, Controller, Get, Module, Post, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { writeAudit } from "../common/audit.js";
import { paginated, parseList } from "../common/pagination.js";
import { RequirePermission } from "../common/permissions.decorator.js";
import { validate } from "../common/zod-body.pipe.js";
import type { ApiRequest } from "../common/types.js";

const createBroadcast = z.object({
  title: z.string().max(120).default(""),
  body: z.string().min(1).max(3500),
  segment: z.enum(["all", "customers", "resellers"]).default("all"),
});

@ApiBearerAuth()
@ApiTags("broadcasts")
@Controller("broadcasts")
export class BroadcastsController {
  @RequirePermission("broadcasts.send")
  @Get()
  async list(@Query() query: unknown) {
    const list = parseList(query, ["createdAt"]);
    const [total, rows] = await Promise.all([
      prisma.broadcast.count(),
      prisma.broadcast.findMany({ orderBy: { createdAt: "desc" }, skip: list.skip, take: list.take }),
    ]);
    return paginated(rows, list.page, list.perPage, total);
  }

  @RequirePermission("broadcasts.send")
  @Post()
  async send(@Body() body: unknown, @Req() req: ApiRequest) {
    const data = validate(createBroadcast, body);
    const res = await sendBroadcast({ ...data, createdById: req.user!.id });
    await writeAudit(req, "broadcast.send", "Broadcast", res.broadcastId, undefined, { targets: res.targets, segment: data.segment });
    return res;
  }
}

@Module({ controllers: [BroadcastsController] })
export class BroadcastsModule {}
