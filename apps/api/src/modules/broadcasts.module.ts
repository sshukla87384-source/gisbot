import { cancelBroadcast, scheduleBroadcast, sendBroadcast } from "@gis/core";
import { prisma } from "@gis/database";
import { Body, Controller, Get, Module, Param, Post, Query, Req } from "@nestjs/common";
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
  imageUrl: z.string().url().max(2000).optional().or(z.literal("")),
  // Optional scheduling. When scheduledAt is a future ISO datetime the
  // broadcast auto-sends then; recurrence re-arms it (auto messaging).
  scheduledAt: z.string().datetime().optional(),
  recurrence: z.enum(["none", "daily", "weekly"]).default("none"),
});

@ApiBearerAuth()
@ApiTags("broadcasts")
@Controller("broadcasts")
export class BroadcastsController {
  @RequirePermission("broadcasts.send")
  @Get()
  async list(@Query() query: unknown) {
    const list = parseList(query, ["createdAt", "scheduledAt"]);
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
    const imageUrl = data.imageUrl ? data.imageUrl : undefined;
    const when = data.scheduledAt ? new Date(data.scheduledAt) : null;

    if (when && when.getTime() > Date.now() + 30_000) {
      const res = await scheduleBroadcast({
        title: data.title,
        body: data.body,
        segment: data.segment,
        imageUrl,
        scheduledAt: when,
        recurrence: data.recurrence,
        createdById: req.user!.id,
      });
      await writeAudit(req, "broadcast.schedule", "Broadcast", res.broadcastId, undefined, {
        segment: data.segment,
        scheduledAt: res.scheduledAt,
        recurrence: res.recurrence,
      });
      return { scheduled: true, ...res };
    }

    const res = await sendBroadcast({
      title: data.title,
      body: data.body,
      segment: data.segment,
      imageUrl,
      createdById: req.user!.id,
    });
    await writeAudit(req, "broadcast.send", "Broadcast", res.broadcastId, undefined, {
      targets: res.targets,
      segment: data.segment,
    });
    return { scheduled: false, ...res };
  }

  @RequirePermission("broadcasts.send")
  @Post(":id/cancel")
  async cancel(@Param("id") id: string, @Req() req: ApiRequest) {
    await cancelBroadcast(id);
    await writeAudit(req, "broadcast.cancel", "Broadcast", id);
    return { ok: true };
  }
}

@Module({ controllers: [BroadcastsController] })
export class BroadcastsModule {}
