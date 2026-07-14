import { prisma } from "@gis/database";
import { enqueueTelegramMessage } from "./queues.js";

export type BroadcastSegment = "all" | "customers" | "resellers";
export type BroadcastRecurrence = "none" | "daily" | "weekly";

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderText(title: string, body: string): string {
  return title ? `<b>${escape(title)}</b>\n\n${escape(body)}` : escape(body);
}

async function targetTelegramIds(segment: BroadcastSegment): Promise<bigint[]> {
  const where: Record<string, unknown> = { notifiable: true, telegramId: { not: null }, status: "ACTIVE" };
  if (segment === "resellers") where.roles = { some: { role: { name: "RESELLER" } } };
  const users = await prisma.user.findMany({ where, select: { telegramId: true } });
  return users.map((u) => u.telegramId).filter((id): id is bigint => id !== null);
}

/** Fan a broadcast row out to its audience through the throttled outbox queue. */
async function deliver(broadcast: {
  id: string;
  title: string;
  body: string;
  imageUrl: string | null;
  segmentQuery: unknown;
}): Promise<number> {
  const segment = ((broadcast.segmentQuery as { segment?: BroadcastSegment })?.segment ?? "all") as BroadcastSegment;
  const ids = await targetTelegramIds(segment);
  const text = renderText(broadcast.title, broadcast.body);
  let sent = 0;
  for (const id of ids) {
    await enqueueTelegramMessage(id, text, broadcast.imageUrl ?? undefined);
    sent++;
  }
  await prisma.broadcast.update({
    where: { id: broadcast.id },
    data: { totalTargets: ids.length, sentCount: sent },
  });
  return sent;
}

/**
 * Send a broadcast immediately to bot users. Optionally attach an image URL.
 * Segments: "all" | "customers" | "resellers".
 */
export async function sendBroadcast(opts: {
  title: string;
  body: string;
  segment: BroadcastSegment;
  imageUrl?: string;
  createdById: string;
}): Promise<{ broadcastId: string; targets: number }> {
  const broadcast = await prisma.broadcast.create({
    data: {
      title: opts.title,
      body: opts.body,
      imageUrl: opts.imageUrl ?? null,
      segmentQuery: { segment: opts.segment } as never,
      status: "RUNNING",
      createdById: opts.createdById,
      startedAt: new Date(),
    },
  });
  const sent = await deliver(broadcast);
  await prisma.broadcast.update({
    where: { id: broadcast.id },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  return { broadcastId: broadcast.id, targets: sent };
}

/**
 * Schedule a broadcast to auto-send at a future time. When recurrence is
 * "daily"/"weekly" the worker re-arms it after each run (auto messaging).
 */
export async function scheduleBroadcast(opts: {
  title: string;
  body: string;
  segment: BroadcastSegment;
  imageUrl?: string;
  scheduledAt: Date;
  recurrence?: BroadcastRecurrence;
  createdById: string;
}): Promise<{ broadcastId: string; scheduledAt: Date; recurrence: BroadcastRecurrence }> {
  const recurrence = opts.recurrence ?? "none";
  const broadcast = await prisma.broadcast.create({
    data: {
      title: opts.title,
      body: opts.body,
      imageUrl: opts.imageUrl ?? null,
      segmentQuery: { segment: opts.segment } as never,
      status: "SCHEDULED",
      scheduledAt: opts.scheduledAt,
      recurrence,
      createdById: opts.createdById,
    },
  });
  return { broadcastId: broadcast.id, scheduledAt: opts.scheduledAt, recurrence };
}

function nextOccurrence(from: Date, recurrence: BroadcastRecurrence): Date {
  const next = new Date(from);
  if (recurrence === "daily") next.setUTCDate(next.getUTCDate() + 1);
  else if (recurrence === "weekly") next.setUTCDate(next.getUTCDate() + 7);
  // If the computed time is still in the past (missed runs), roll forward to the future.
  const now = Date.now();
  while (next.getTime() <= now) {
    if (recurrence === "daily") next.setUTCDate(next.getUTCDate() + 1);
    else next.setUTCDate(next.getUTCDate() + 7);
  }
  return next;
}

/**
 * Cron entrypoint: deliver every SCHEDULED broadcast whose time has arrived.
 * One-time broadcasts complete; recurring ones re-arm for their next slot.
 * Returns how many broadcasts were dispatched.
 */
export async function dispatchDueBroadcasts(): Promise<number> {
  const now = new Date();
  // Claim due rows atomically so a second worker can't double-send.
  const due = await prisma.broadcast.findMany({
    where: { status: "SCHEDULED", scheduledAt: { lte: now } },
    take: 20,
  });
  let dispatched = 0;
  for (const b of due) {
    const claimed = await prisma.broadcast.updateMany({
      where: { id: b.id, status: "SCHEDULED" },
      data: { status: "RUNNING", startedAt: now },
    });
    if (claimed.count === 0) continue; // someone else took it
    await deliver(b);
    const recurrence = (b.recurrence ?? "none") as BroadcastRecurrence;
    if (recurrence === "none") {
      await prisma.broadcast.update({
        where: { id: b.id },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
    } else {
      await prisma.broadcast.update({
        where: { id: b.id },
        data: { status: "SCHEDULED", scheduledAt: nextOccurrence(b.scheduledAt ?? now, recurrence) },
      });
    }
    dispatched++;
  }
  return dispatched;
}

/** Cancel a scheduled (or recurring) broadcast so it stops firing. */
export async function cancelBroadcast(id: string): Promise<void> {
  await prisma.broadcast.updateMany({
    where: { id, status: { in: ["SCHEDULED", "PAUSED"] } },
    data: { status: "CANCELLED" },
  });
}
