import { prisma } from "@gis/database";
import { Body, Controller, Delete, Get, Module, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { writeAudit } from "../common/audit.js";
import { ApiError, forbidden, notFound } from "../common/errors.js";
import { paginated, parseList } from "../common/pagination.js";
import { RequirePermission } from "../common/permissions.decorator.js";
import { validate } from "../common/zod-body.pipe.js";
import type { ApiRequest } from "../common/types.js";

const statusBody = z.object({ status: z.enum(["ACTIVE", "SUSPENDED", "BANNED"]) });
const roleBody = z.object({ role: z.string().min(1) });

@ApiBearerAuth()
@ApiTags("users")
@Controller("users")
export class UsersController {
  @RequirePermission("users.read")
  @Get()
  async list(@Query() query: unknown) {
    const list = parseList(query, ["createdAt", "firstPurchaseAt"]);
    const where = list.search
      ? {
          OR: [
            { email: { contains: list.search, mode: "insensitive" as const } },
            { telegramHandle: { contains: list.search, mode: "insensitive" as const } },
            { firstName: { contains: list.search, mode: "insensitive" as const } },
            ...(/^\d+$/.test(list.search) ? [{ telegramId: BigInt(list.search) }] : []),
          ],
        }
      : {};
    const [total, rows] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: list.orderBy,
        skip: list.skip,
        take: list.take,
        include: { roles: { include: { role: { select: { name: true } } } } },
      }),
    ]);
    const data = rows.map((u) => ({
      id: u.id,
      telegramId: u.telegramId?.toString() ?? null,
      telegramHandle: u.telegramHandle,
      email: u.email,
      firstName: u.firstName,
      status: u.status,
      roles: u.roles.map((r) => r.role.name),
      createdAt: u.createdAt,
    }));
    return paginated(data, list.page, list.perPage, total);
  }

  @RequirePermission("users.read")
  @Get(":id")
  async detail(@Param("id") id: string) {
    const u = await prisma.user.findUnique({
      where: { id },
      include: { roles: { include: { role: { select: { name: true } } } }, wallet: true },
    });
    if (!u) throw notFound("User");
    const [orderCount, ticketCount, referralCount] = await Promise.all([
      prisma.order.count({ where: { userId: id } }),
      prisma.supportTicket.count({ where: { userId: id } }),
      prisma.user.count({ where: { referredById: id } }),
    ]);
    return {
      id: u.id,
      telegramId: u.telegramId?.toString() ?? null,
      telegramHandle: u.telegramHandle,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      status: u.status,
      currency: u.currency,
      roles: u.roles.map((r) => r.role.name),
      wallet: u.wallet ? { balanceMinor: u.wallet.balanceMinor.toString(), currency: u.wallet.currency } : null,
      stats: { orderCount, ticketCount, referralCount },
      createdAt: u.createdAt,
    };
  }

  @RequirePermission("users.moderate")
  @Patch(":id/status")
  async setStatus(@Param("id") id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    const { status } = validate(statusBody, body);
    const u = await prisma.user.update({ where: { id }, data: { status } });
    await writeAudit(req, "user.status", "User", id, undefined, { status });
    return { id: u.id, status: u.status };
  }

  @RequirePermission("roles.assign")
  @Post(":id/roles")
  async addRole(@Param("id") id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    const { role } = validate(roleBody, body);
    if (role === "SUPER_ADMIN" && !req.user!.roles.includes("SUPER_ADMIN")) {
      throw forbidden("Only a super admin can grant SUPER_ADMIN.");
    }
    const roleRow = await prisma.role.findUnique({ where: { name: role } });
    if (!roleRow) throw notFound("Role");
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: id, roleId: roleRow.id } },
      create: { userId: id, roleId: roleRow.id },
      update: {},
    });
    // Force re-auth by revoking sessions when privileges change.
    await prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await writeAudit(req, "user.role.add", "User", id, undefined, { role });
    return { ok: true };
  }

  @RequirePermission("roles.assign")
  @Delete(":id/roles/:roleName")
  async removeRole(@Param("id") id: string, @Param("roleName") roleName: string, @Req() req: ApiRequest) {
    if (roleName === "SUPER_ADMIN" && !req.user!.roles.includes("SUPER_ADMIN")) {
      throw forbidden("Only a super admin can revoke SUPER_ADMIN.");
    }
    const roleRow = await prisma.role.findUnique({ where: { name: roleName } });
    if (roleRow) {
      await prisma.userRole.deleteMany({ where: { userId: id, roleId: roleRow.id } });
      await prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await writeAudit(req, "user.role.remove", "User", id, undefined, { role: roleName });
    return { ok: true };
  }
}

@Module({ controllers: [UsersController] })
export class UsersModule {}
