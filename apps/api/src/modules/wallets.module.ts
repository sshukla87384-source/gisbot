import { adjustWallet, convertMinorExact } from "@gis/core";
import { prisma } from "@gis/database";
import { Body, Controller, Get, Module, Param, Post, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { writeAudit } from "../common/audit.js";
import { conflict, notFound } from "../common/errors.js";
import { filterValue, paginated, parseList } from "../common/pagination.js";
import { RequirePermission } from "../common/permissions.decorator.js";
import { validate } from "../common/zod-body.pipe.js";
import type { ApiRequest } from "../common/types.js";

const adjustBody = z.object({ amountMinor: z.number().int(), note: z.string().min(5).max(300) });
const rejectBody = z.object({ note: z.string().max(300).optional() });

@ApiBearerAuth()
@ApiTags("wallets")
@Controller()
export class WalletsController {
  @RequirePermission("wallets.read")
  @Get("wallets/:userId")
  async wallet(@Param("userId") userId: string) {
    const w = await prisma.wallet.findUnique({ where: { userId } });
    if (!w) throw notFound("Wallet");
    return { walletId: w.id, balanceMinor: w.balanceMinor.toString(), holdMinor: w.holdMinor.toString(), currency: w.currency };
  }

  @RequirePermission("wallets.read")
  @Get("wallets/:userId/transactions")
  async transactions(@Param("userId") userId: string, @Query() query: unknown) {
    const list = parseList(query, ["createdAt"]);
    const w = await prisma.wallet.findUnique({ where: { userId } });
    if (!w) throw notFound("Wallet");
    const [total, rows] = await Promise.all([
      prisma.walletTransaction.count({ where: { walletId: w.id } }),
      prisma.walletTransaction.findMany({ where: { walletId: w.id }, orderBy: list.orderBy, skip: list.skip, take: list.take }),
    ]);
    const data = rows.map((t) => ({
      type: t.type,
      amountMinor: t.amountMinor.toString(),
      balanceAfterMinor: t.balanceAfterMinor.toString(),
      currency: t.currency,
      note: t.referenceNote,
      createdAt: t.createdAt,
    }));
    return paginated(data, list.page, list.perPage, total);
  }

  @RequirePermission("wallets.adjust")
  @Post("wallets/:userId/adjust")
  async adjust(@Param("userId") userId: string, @Body() body: unknown, @Req() req: ApiRequest) {
    const { amountMinor, note } = validate(adjustBody, body);
    const balance = await adjustWallet({
      userId,
      amountMinor: BigInt(amountMinor),
      type: "ADJUSTMENT",
      note,
      actorId: req.user!.id,
    });
    await writeAudit(req, "wallet.adjust", "Wallet", userId, undefined, { amountMinor, note });
    return { balanceMinor: balance.toString() };
  }

  @RequirePermission("wallets.withdraw.review")
  @Get("withdrawals")
  async withdrawals(@Query() query: unknown) {
    const list = parseList(query, ["createdAt"]);
    const where = filterValue(list, "status") ? { status: filterValue(list, "status") as never } : {};
    const [total, rows] = await Promise.all([
      prisma.withdrawalRequest.count({ where }),
      prisma.withdrawalRequest.findMany({ where, orderBy: list.orderBy, skip: list.skip, take: list.take, include: { wallet: { include: { user: { select: { telegramHandle: true, email: true } } } } } }),
    ]);
    const data = rows.map((w) => ({
      id: w.id,
      amountMinor: w.amountMinor.toString(),
      currency: w.currency,
      method: w.method,
      status: w.status,
      user: w.wallet.user,
      createdAt: w.createdAt,
    }));
    return paginated(data, list.page, list.perPage, total);
  }

  @RequirePermission("wallets.withdraw.review")
  @Post("withdrawals/:id/approve")
  async approve(@Param("id") id: string, @Req() req: ApiRequest) {
    const w = await prisma.withdrawalRequest.findUnique({ where: { id }, include: { wallet: true } });
    if (!w) throw notFound("Withdrawal");
    if (w.status !== "PENDING") throw conflict("BAD_STATE", "Only pending withdrawals can be approved.");
    // Claim it first, so two reviewers clicking at once cannot both debit.
    const claimed = await prisma.withdrawalRequest.updateMany({ where: { id, status: "PENDING" }, data: { status: "APPROVED", reviewedById: req.user!.id } });
    if (claimed.count === 0) throw conflict("BAD_STATE", "Only pending withdrawals can be approved.");
    // The request is in the currency it was made in; the wallet may have
    // switched INR↔USD since — debit the equivalent in the wallet's currency.
    const debit = w.currency === w.wallet.currency
      ? w.amountMinor
      : BigInt(Math.ceil(convertMinorExact(Number(w.amountMinor), w.currency, w.wallet.currency)));
    try {
      await adjustWallet({
        userId: w.wallet.userId,
        amountMinor: -debit,
        type: "WITHDRAWAL",
        note: `withdrawal ${id}`,
        actorId: req.user!.id,
        idempotencyKey: `wd:${id}`,
      });
    } catch (e) {
      if ((e as { code?: string })?.code === "P2002") return { ok: true }; // already debited
      await prisma.withdrawalRequest.updateMany({ where: { id, status: "APPROVED" }, data: { status: "PENDING", reviewedById: null } });
      if ((e as { code?: string })?.code === "INSUFFICIENT_BALANCE") throw conflict("INSUFFICIENT_BALANCE", "The wallet no longer holds enough for this withdrawal.");
      throw e;
    }
    await writeAudit(req, "withdrawal.approve", "WithdrawalRequest", id);
    return { ok: true };
  }

  @RequirePermission("wallets.withdraw.review")
  @Post("withdrawals/:id/reject")
  async reject(@Param("id") id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    const { note } = validate(rejectBody, body);
    const w = await prisma.withdrawalRequest.findUnique({ where: { id } });
    if (!w) throw notFound("Withdrawal");
    if (w.status !== "PENDING") throw conflict("BAD_STATE", "Only pending withdrawals can be rejected.");
    await prisma.withdrawalRequest.update({ where: { id }, data: { status: "REJECTED", reviewNote: note, reviewedById: req.user!.id } });
    await writeAudit(req, "withdrawal.reject", "WithdrawalRequest", id, undefined, { note });
    return { ok: true };
  }

  @RequirePermission("wallets.withdraw.review")
  @Post("withdrawals/:id/mark-processed")
  async markProcessed(@Param("id") id: string, @Req() req: ApiRequest) {
    const w = await prisma.withdrawalRequest.findUnique({ where: { id } });
    if (!w) throw notFound("Withdrawal");
    if (w.status !== "APPROVED") throw conflict("BAD_STATE", "Only approved withdrawals can be marked processed.");
    await prisma.withdrawalRequest.update({ where: { id }, data: { status: "PROCESSED", processedAt: new Date() } });
    await writeAudit(req, "withdrawal.processed", "WithdrawalRequest", id);
    return { ok: true };
  }
}

@Module({ controllers: [WalletsController] })
export class WalletsModule {}
