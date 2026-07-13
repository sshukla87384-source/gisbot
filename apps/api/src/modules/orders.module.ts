import { loadConfig } from "@gis/config";
import { enqueueTelegramMessage } from "@gis/core";
import { prisma } from "@gis/database";
import { decryptSecret, encryptSecret } from "@gis/shared";
import { Body, Controller, Get, Module, Param, Post, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { writeAudit } from "../common/audit.js";
import { notFound, conflict } from "../common/errors.js";
import { filterValue, paginated, parseList } from "../common/pagination.js";
import { RequirePermission } from "../common/permissions.decorator.js";
import { escapeHtml, type ApiRequest } from "../common/types.js";
import { validate } from "../common/zod-body.pipe.js";

const fulfillBody = z.object({
  kind: z.enum(["LICENSE_KEY", "DIGITAL_ACCOUNT", "TEXT"]),
  key: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  text: z.string().optional(),
});

function deliveryText(productName: string, variantName: string, p: Record<string, string | undefined>): string {
  const lines = [`📦 <b>${escapeHtml(productName)}</b> · ${escapeHtml(variantName)}`, ""];
  if (p.key) lines.push(`🔑 <code>${escapeHtml(p.key)}</code>`);
  if (p.username) lines.push(`👤 Login: <code>${escapeHtml(p.username)}</code>`);
  if (p.password) lines.push(`🔒 Password: <tg-spoiler>${escapeHtml(p.password)}</tg-spoiler>`);
  if (p.text) lines.push(escapeHtml(p.text));
  lines.push("", "Saved in 🔑 My Licenses. Problem? Open a 🎫 Support ticket.");
  return lines.join("\n");
}

@ApiBearerAuth()
@ApiTags("orders")
@Controller("orders")
export class OrdersController {
  @RequirePermission("orders.read")
  @Get()
  async list(@Query() query: unknown) {
    const list = parseList(query, ["createdAt", "totalMinor", "status"]);
    const where = {
      ...(filterValue(list, "status") ? { status: filterValue(list, "status") as never } : {}),
      ...(filterValue(list, "userId") ? { userId: filterValue(list, "userId") } : {}),
      ...(list.search ? { orderNumber: { contains: list.search, mode: "insensitive" as const } } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        orderBy: list.orderBy,
        skip: list.skip,
        take: list.take,
        include: { user: { select: { telegramHandle: true, firstName: true } } },
      }),
    ]);
    return paginated(rows, list.page, list.perPage, total);
  }

  @RequirePermission("orders.read")
  @Get("queue/manual")
  async manualQueue() {
    return prisma.order.findMany({
      where: { status: "PENDING_FULFILLMENT" },
      orderBy: { paidAt: "asc" },
      include: {
        user: { select: { telegramHandle: true, firstName: true } },
        items: { where: { fulfilledAt: null }, include: { variant: { include: { product: { select: { name: true, type: true } } } } } },
      },
    });
  }

  @RequirePermission("orders.read")
  @Get(":id")
  async detail(@Param("id") id: string) {
    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, telegramHandle: true, firstName: true, email: true } },
        items: { include: { variant: { include: { product: { select: { name: true, type: true } } } } } },
        payments: true,
        refunds: true,
      },
    });
    if (!order) throw notFound("Order");
    const timeline = await prisma.auditLog.findMany({
      where: { entityType: "Order", entityId: id },
      orderBy: { createdAt: "asc" },
    });
    return { ...order, timeline };
  }

  @RequirePermission("orders.fulfill")
  @Post(":id/items/:itemId/fulfill")
  async fulfill(@Param("id") id: string, @Param("itemId") itemId: string, @Body() body: unknown, @Req() req: ApiRequest) {
    const data = validate(fulfillBody, body);
    const master = loadConfig().ENCRYPTION_MASTER_KEY;
    const item = await prisma.orderItem.findFirst({ where: { id: itemId, orderId: id } });
    if (!item) throw notFound("Order item");
    if (item.fulfilledAt) throw conflict("ALREADY_FULFILLED", "This item is already fulfilled.");

    const payload: Record<string, string | undefined> = { kind: data.kind };
    if (data.kind === "LICENSE_KEY") payload.key = data.key;
    else if (data.kind === "DIGITAL_ACCOUNT") {
      payload.username = data.username;
      payload.password = data.password;
    } else payload.text = data.text;

    await prisma.orderItem.update({
      where: { id: itemId },
      data: { fulfilledAt: new Date(), deliveryPayloadEncrypted: encryptSecret(JSON.stringify(payload), master) },
    });

    // Complete the order once all its items are fulfilled.
    const remaining = await prisma.orderItem.count({ where: { orderId: id, fulfilledAt: null } });
    if (remaining === 0) {
      await prisma.order.update({ where: { id }, data: { status: "COMPLETED", completedAt: new Date() } });
    }

    const order = await prisma.order.findUnique({ where: { id }, include: { user: true } });
    if (order?.user.telegramId != null) {
      await enqueueTelegramMessage(order.user.telegramId, deliveryText(item.productNameSnap, item.variantNameSnap, payload));
    }
    await writeAudit(req, "order.fulfill.manual", "Order", id, undefined, { itemId, kind: data.kind });
    return { ok: true, orderCompleted: remaining === 0 };
  }

  @RequirePermission("orders.fulfill")
  @Post(":id/resend-delivery")
  async resend(@Param("id") id: string, @Req() req: ApiRequest) {
    const master = loadConfig().ENCRYPTION_MASTER_KEY;
    const order = await prisma.order.findUnique({
      where: { id },
      include: { user: true, items: { where: { deliveryPayloadEncrypted: { not: null } } } },
    });
    if (!order) throw notFound("Order");
    if (order.user.telegramId == null) throw conflict("NO_TELEGRAM", "User has no Telegram id.");
    for (const item of order.items) {
      const payload = JSON.parse(decryptSecret(item.deliveryPayloadEncrypted!, master)) as Record<string, string | undefined>;
      await enqueueTelegramMessage(order.user.telegramId, deliveryText(item.productNameSnap, item.variantNameSnap, payload));
    }
    await writeAudit(req, "order.resend", "Order", id, undefined, { items: order.items.length });
    return { resent: order.items.length };
  }
}

@Module({ controllers: [OrdersController] })
export class OrdersModule {}
