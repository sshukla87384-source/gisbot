import { enqueueTelegramMessage } from "@gis/core";
import { prisma } from "@gis/database";
import { Body, Controller, Get, Module, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { writeAudit } from "../common/audit.js";
import { notFound } from "../common/errors.js";
import { filterValue, paginated, parseList } from "../common/pagination.js";
import { RequirePermission } from "../common/permissions.decorator.js";
import { escapeHtml, type ApiRequest } from "../common/types.js";
import { validate } from "../common/zod-body.pipe.js";

const messageBody = z.object({ body: z.string().min(1).max(4000) });
const patchBody = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CLOSED"]).optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional(),
  assigneeId: z.string().nullable().optional(),
});

@ApiBearerAuth()
@ApiTags("tickets")
@Controller("tickets")
export class TicketsController {
  @RequirePermission("tickets.read")
  @Get()
  async list(@Query() query: unknown) {
    const list = parseList(query, ["createdAt", "priority"]);
    const where = {
      ...(filterValue(list, "status") ? { status: filterValue(list, "status") as never } : {}),
      ...(filterValue(list, "priority") ? { priority: filterValue(list, "priority") as never } : {}),
      ...(filterValue(list, "assigneeId") ? { assigneeId: filterValue(list, "assigneeId") } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.supportTicket.count({ where }),
      prisma.supportTicket.findMany({ where, orderBy: list.orderBy, skip: list.skip, take: list.take, include: { user: { select: { telegramHandle: true, firstName: true } } } }),
    ]);
    return paginated(rows, list.page, list.perPage, total);
  }

  @RequirePermission("tickets.read")
  @Get(":id")
  async detail(@Param("id") id: string) {
    const t = await prisma.supportTicket.findUnique({
      where: { id },
      include: { user: { select: { telegramHandle: true, firstName: true } }, messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!t) throw notFound("Ticket");
    return t;
  }

  @RequirePermission("tickets.write")
  @Post(":id/messages")
  async reply(@Param("id") id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    const { body: text } = validate(messageBody, body);
    const ticket = await prisma.supportTicket.findUnique({ where: { id }, include: { user: true } });
    if (!ticket) throw notFound("Ticket");
    await prisma.ticketMessage.create({ data: { ticketId: id, authorId: req.user!.id, authorType: "ADMIN", body: text } });
    await prisma.supportTicket.update({
      where: { id },
      data: { status: "IN_PROGRESS", ...(ticket.firstResponseAt ? {} : { firstResponseAt: new Date() }) },
    });
    if (ticket.user.telegramId != null) {
      await enqueueTelegramMessage(ticket.user.telegramId, `💬 <b>Support (${ticket.ticketNumber})</b>: ${escapeHtml(text)}`);
    }
    await writeAudit(req, "ticket.reply", "SupportTicket", id);
    return { ok: true };
  }

  @RequirePermission("tickets.write")
  @Patch(":id")
  async patch(@Param("id") id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    const data = validate(patchBody, body);
    const patch: Record<string, unknown> = { ...data };
    if (data.status === "RESOLVED") patch.resolvedAt = new Date();
    if (data.status === "CLOSED") patch.closedAt = new Date();
    const t = await prisma.supportTicket.update({ where: { id }, data: patch });
    await writeAudit(req, "ticket.update", "SupportTicket", id, undefined, data);
    return t;
  }
}

@Module({ controllers: [TicketsController] })
export class TicketsModule {}
