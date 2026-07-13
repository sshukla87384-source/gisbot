import { prisma } from "@gis/database";
import type { ApiRequest } from "./types.js";

/** Write an AuditLog row for a privileged mutation (Security doc §7). */
export async function writeAudit(
  req: ApiRequest,
  action: string,
  entityType: string,
  entityId?: string,
  before?: unknown,
  after?: unknown,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId: req.user?.id,
      actorType: "ADMIN",
      action,
      entityType,
      entityId,
      before: (before ?? undefined) as never,
      after: (after ?? undefined) as never,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    },
  });
}
