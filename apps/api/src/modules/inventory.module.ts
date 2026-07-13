import { loadConfig } from "@gis/config";
import { prisma } from "@gis/database";
import { decryptSecret, encryptSecret, normalizeLicenseKey, sha256Hex } from "@gis/shared";
import { Body, Controller, Get, Module, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { writeAudit } from "../common/audit.js";
import { notFound } from "../common/errors.js";
import { filterValue, paginated, parseList } from "../common/pagination.js";
import { RequirePermission } from "../common/permissions.decorator.js";
import { validate } from "../common/zod-body.pipe.js";
import type { ApiRequest } from "../common/types.js";

const keysBody = z.object({
  variantId: z.string().min(1),
  keys: z.array(z.string().min(1)).min(1).max(5000),
  supplier: z.string().max(200).optional(),
  expiresAt: z.coerce.date().optional(),
});
const accountsBody = z.object({
  variantId: z.string().min(1),
  accounts: z
    .array(
      z.object({
        username: z.string().min(1),
        password: z.string().min(1),
        recoveryEmail: z.string().email().optional(),
        maxSlots: z.number().int().min(1).max(20).default(1),
        expiresAt: z.coerce.date().optional(),
      }),
    )
    .min(1)
    .max(2000),
  supplier: z.string().max(200).optional(),
});
const bulkStatus = z.object({
  ids: z.array(z.string()).min(1).max(5000),
  status: z.enum(["AVAILABLE", "DISABLED"]),
});

function mask(keyHash: string): string {
  return `••••••••-${keyHash.slice(0, 8)}`;
}

@ApiBearerAuth()
@ApiTags("inventory")
@Controller("inventory")
export class InventoryController {
  @RequirePermission("inventory.read")
  @Get("keys")
  async keys(@Query() query: unknown) {
    const list = parseList(query, ["createdAt", "status"]);
    const where = {
      deletedAt: null,
      ...(filterValue(list, "variantId") ? { variantId: filterValue(list, "variantId") } : {}),
      ...(filterValue(list, "status") ? { status: filterValue(list, "status") as never } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.licenseKey.count({ where }),
      prisma.licenseKey.findMany({ where, orderBy: list.orderBy, skip: list.skip, take: list.take }),
    ]);
    // NEVER return decrypted keys in a list (Security doc §3): mask.
    const masked = rows.map((k) => ({
      id: k.id,
      variantId: k.variantId,
      status: k.status,
      maskedKey: mask(k.keyHash),
      expiresAt: k.expiresAt,
      supplier: k.supplier,
      soldAt: k.soldAt,
      createdAt: k.createdAt,
    }));
    return paginated(masked, list.page, list.perPage, total);
  }

  @RequirePermission("inventory.write")
  @Post("keys")
  async addKeys(@Body() body: unknown, @Req() req: ApiRequest) {
    const { variantId, keys, supplier, expiresAt } = validate(keysBody, body);
    const master = loadConfig().ENCRYPTION_MASTER_KEY;
    let inserted = 0;
    let duplicates = 0;
    const seen = new Set<string>();
    for (const raw of keys) {
      const keyHash = sha256Hex(normalizeLicenseKey(raw));
      if (seen.has(keyHash)) {
        duplicates++;
        continue;
      }
      seen.add(keyHash);
      try {
        await prisma.licenseKey.create({
          data: { variantId, keyHash, keyEncrypted: encryptSecret(raw, master), supplier, expiresAt },
        });
        inserted++;
      } catch (e) {
        if (e instanceof Error && "code" in e && (e as { code?: string }).code === "P2002") duplicates++;
        else throw e;
      }
    }
    await writeAudit(req, "inventory.keys.import", "ProductVariant", variantId, undefined, { inserted, duplicates });
    return { inserted, duplicates };
  }

  @RequirePermission("inventory.reveal")
  @Post("keys/:id/reveal")
  async reveal(@Param("id") id: string, @Req() req: ApiRequest) {
    const key = await prisma.licenseKey.findUnique({ where: { id } });
    if (!key) throw notFound("License key");
    await writeAudit(req, "inventory.reveal", "LicenseKey", id);
    return { id, key: decryptSecret(key.keyEncrypted, loadConfig().ENCRYPTION_MASTER_KEY) };
  }

  @RequirePermission("inventory.write")
  @Patch("keys/bulk")
  async bulkKeys(@Body() body: unknown, @Req() req: ApiRequest) {
    const { ids, status } = validate(bulkStatus, body);
    // Only AVAILABLE <-> DISABLED transitions (never touch SOLD/RESERVED).
    const result = await prisma.licenseKey.updateMany({
      where: { id: { in: ids }, status: { in: ["AVAILABLE", "DISABLED"] } },
      data: { status },
    });
    await writeAudit(req, "inventory.keys.bulk", "LicenseKey", undefined, undefined, { count: result.count, status });
    return { updated: result.count };
  }

  @RequirePermission("inventory.read")
  @Get("accounts")
  async accounts(@Query() query: unknown) {
    const list = parseList(query, ["createdAt", "status"]);
    const where = {
      deletedAt: null,
      ...(filterValue(list, "variantId") ? { variantId: filterValue(list, "variantId") } : {}),
      ...(filterValue(list, "status") ? { status: filterValue(list, "status") as never } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.digitalAccount.count({ where }),
      prisma.digitalAccount.findMany({ where, orderBy: list.orderBy, skip: list.skip, take: list.take }),
    ]);
    const masked = rows.map((a) => ({
      id: a.id,
      variantId: a.variantId,
      status: a.status,
      recoveryEmail: a.recoveryEmail,
      slots: `${a.usedSlots}/${a.maxSlots}`,
      expiresAt: a.expiresAt,
      supplier: a.supplier,
    }));
    return paginated(masked, list.page, list.perPage, total);
  }

  @RequirePermission("inventory.write")
  @Post("accounts")
  async addAccounts(@Body() body: unknown, @Req() req: ApiRequest) {
    const { variantId, accounts, supplier } = validate(accountsBody, body);
    const master = loadConfig().ENCRYPTION_MASTER_KEY;
    let inserted = 0;
    for (const a of accounts) {
      await prisma.digitalAccount.create({
        data: {
          variantId,
          usernameEncrypted: encryptSecret(a.username, master),
          passwordEncrypted: encryptSecret(a.password, master),
          recoveryEmail: a.recoveryEmail,
          maxSlots: a.maxSlots,
          expiresAt: a.expiresAt,
          supplier,
        },
      });
      inserted++;
    }
    await writeAudit(req, "inventory.accounts.import", "ProductVariant", variantId, undefined, { inserted });
    return { inserted };
  }

  @RequirePermission("inventory.reveal")
  @Post("accounts/:id/reveal")
  async revealAccount(@Param("id") id: string, @Req() req: ApiRequest) {
    const a = await prisma.digitalAccount.findUnique({ where: { id } });
    if (!a) throw notFound("Account");
    const master = loadConfig().ENCRYPTION_MASTER_KEY;
    await writeAudit(req, "inventory.reveal", "DigitalAccount", id);
    return {
      id,
      username: decryptSecret(a.usernameEncrypted, master),
      password: decryptSecret(a.passwordEncrypted, master),
      recoveryEmail: a.recoveryEmail,
    };
  }

  @RequirePermission("inventory.read")
  @Get("alerts")
  async alerts() {
    const soon = new Date(Date.now() + 7 * 86_400_000);
    const lowStock = await prisma.$queryRaw<Array<{ variantId: string; productName: string; variantName: string; available: bigint; threshold: number }>>`
      SELECT v."id" AS "variantId", p."name" AS "productName", v."name" AS "variantName",
             COUNT(k."id") FILTER (WHERE k."status" = 'AVAILABLE' AND k."deletedAt" IS NULL) AS "available",
             v."lowStockThreshold" AS "threshold"
      FROM "ProductVariant" v JOIN "Product" p ON p."id" = v."productId"
      LEFT JOIN "LicenseKey" k ON k."variantId" = v."id"
      WHERE v."deletedAt" IS NULL AND v."isActive" = true AND p."type" = 'LICENSE_KEY'
      GROUP BY v."id", p."name", v."name", v."lowStockThreshold"
      HAVING COUNT(k."id") FILTER (WHERE k."status" = 'AVAILABLE' AND k."deletedAt" IS NULL) <= v."lowStockThreshold"`;
    const expiring = await prisma.licenseKey.count({ where: { status: "AVAILABLE", expiresAt: { lte: soon, gte: new Date() } } });
    return { lowStock: lowStock.map((r) => ({ ...r, available: Number(r.available) })), expiringWithin7d: expiring };
  }
}

@Module({ controllers: [InventoryController] })
export class InventoryModule {}
