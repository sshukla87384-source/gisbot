import { prisma } from "@gis/database";
import { enqueueTelegramMessage } from "./queues.js";

/**
 * Broadcast a message to bot users. Segments: "all" | "customers" | "resellers".
 * Fans out through the throttled outbox queue so Telegram rate limits are
 * respected. Records a Broadcast row with counts.
 */
export async function sendBroadcast(opts: {
  title: string;
  body: string;
  segment: "all" | "customers" | "resellers";
  createdById: string;
}): Promise<{ broadcastId: string; targets: number }> {
  const where: Record<string, unknown> = { notifiable: true, telegramId: { not: null }, status: "ACTIVE" };
  if (opts.segment === "resellers") where.roles = { some: { role: { name: "RESELLER" } } };

  const users = await prisma.user.findMany({ where, select: { telegramId: true } });

  const broadcast = await prisma.broadcast.create({
    data: {
      title: opts.title,
      body: opts.body,
      segmentQuery: { segment: opts.segment } as never,
      status: "RUNNING",
      totalTargets: users.length,
      createdById: opts.createdById,
      startedAt: new Date(),
    },
  });

  const text = opts.title ? `<b>${escape(opts.title)}</b>\n\n${escape(opts.body)}` : escape(opts.body);
  let sent = 0;
  for (const u of users) {
    if (u.telegramId === null) continue;
    await enqueueTelegramMessage(u.telegramId, text);
    sent++;
  }

  await prisma.broadcast.update({
    where: { id: broadcast.id },
    data: { status: "COMPLETED", completedAt: new Date(), sentCount: sent },
  });
  return { broadcastId: broadcast.id, targets: sent };
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
