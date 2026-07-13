import { PrismaClient } from "@prisma/client";

/**
 * Singleton Prisma client (connection pooling handled by Prisma engine).
 * In dev, survive hot-reloads without exhausting connections.
 */
const globalForPrisma = globalThis as unknown as { __gisPrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.__gisPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.__gisPrisma = prisma;

/**
 * Idempotent creation of DB objects Prisma can't express (sequences for
 * human-friendly order/ticket numbers). Called at app boot and from seed.
 */
export async function ensureDbObjects(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS gis_order_seq START 1`);
  await prisma.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS gis_ticket_seq START 1`);
}

export async function nextOrderNumber(tx: Pick<PrismaClient, "$queryRawUnsafe">): Promise<string> {
  const rows = await tx.$queryRawUnsafe<Array<{ nextval: bigint }>>(`SELECT nextval('gis_order_seq')`);
  const n = rows[0]?.nextval ?? 1n;
  return `GIS-${new Date().getFullYear()}-${n.toString().padStart(6, "0")}`;
}

export async function nextTicketNumber(tx: Pick<PrismaClient, "$queryRawUnsafe">): Promise<string> {
  const rows = await tx.$queryRawUnsafe<Array<{ nextval: bigint }>>(`SELECT nextval('gis_ticket_seq')`);
  const n = rows[0]?.nextval ?? 1n;
  return `T-${n.toString().padStart(6, "0")}`;
}

export * from "@prisma/client";
