import { prisma } from "@gis/database";
import { enqueueAdminAlert, enqueueTelegramMessage } from "../queues.js";
import { adminReplaceOrderItem } from "./manual-pay.service.js";

export interface ReplaceableItem {
  orderItemId: string;
  label: string;
  orderNumber: string;
  warranty: boolean;
  eligible: boolean;
  reason: string | null;
}

/**
 * Delivered items the buyer could claim a replacement on, newest first.
 * Warranty is per-product; `warrantyDays` (when set) closes the window.
 */
export async function listReplaceableItems(userId: string, limit = 20): Promise<ReplaceableItem[]> {
  const rows = await prisma.orderItem.findMany({
    where: { order: { userId }, fulfilledAt: { not: null } },
    orderBy: { fulfilledAt: "desc" },
    take: limit,
    include: {
      order: { select: { orderNumber: true } },
      variant: { include: { product: { select: { warranty: true, warrantyDays: true } } } },
      replacements: { where: { status: { in: ["PENDING", "APPROVED"] } }, select: { id: true, status: true } },
    },
  });
  return rows.map((r) => {
    const p = r.variant.product;
    const vn = r.variantNameSnap.trim().toLowerCase() === "standard" ? "" : ` · ${r.variantNameSnap}`;
    let eligible = true;
    let reason: string | null = null;
    if (!p.warranty) { eligible = false; reason = "No warranty on this product"; }
    else if (r.replacements.some((x) => x.status === "PENDING")) { eligible = false; reason = "A request is already under review"; }
    else if (r.replacements.some((x) => x.status === "APPROVED")) { eligible = false; reason = "Already replaced once"; }
    else if (p.warrantyDays && (r.warrantyStartAt ?? r.fulfilledAt)) {
      // Counts from the FIRST delivery, so a replacement does not extend cover.
      const start = (r.warrantyStartAt ?? r.fulfilledAt) as Date;
      const ageDays = (Date.now() - start.getTime()) / 86_400_000;
      if (ageDays > p.warrantyDays) { eligible = false; reason = `Warranty expired (${p.warrantyDays}d)`; }
    }
    return { orderItemId: r.id, label: `${r.productNameSnap}${vn}`, orderNumber: r.order.orderNumber, warranty: p.warranty, eligible, reason };
  });
}

export async function getReplaceableItem(userId: string, orderItemId: string): Promise<ReplaceableItem | null> {
  const r = await prisma.orderItem.findFirst({
    where: { id: orderItemId, order: { userId }, fulfilledAt: { not: null } },
    include: {
      order: { select: { orderNumber: true } },
      variant: { include: { product: { select: { warranty: true, warrantyDays: true } } } },
      replacements: { where: { status: { in: ["PENDING", "APPROVED"] } }, select: { id: true, status: true } },
    },
  });
  if (!r) return null;
  const p = r.variant.product;
  const vn = r.variantNameSnap.trim().toLowerCase() === "standard" ? "" : ` · ${r.variantNameSnap}`;
  let eligible = true;
  let reason: string | null = null;
  if (!p.warranty) { eligible = false; reason = "No warranty on this product"; }
  else if (r.replacements.some((x) => x.status === "PENDING")) { eligible = false; reason = "A request is already under review"; }
  else if (r.replacements.some((x) => x.status === "APPROVED")) { eligible = false; reason = "Already replaced once"; }
  else if (p.warrantyDays && (r.warrantyStartAt ?? r.fulfilledAt)) {
    const start = (r.warrantyStartAt ?? r.fulfilledAt) as Date;
    const ageDays = (Date.now() - start.getTime()) / 86_400_000;
    if (ageDays > p.warrantyDays) { eligible = false; reason = `Warranty expired (${p.warrantyDays}d)`; }
  }
  return { orderItemId: r.id, label: `${r.productNameSnap}${vn}`, orderNumber: r.order.orderNumber, warranty: p.warranty, eligible, reason };
}

/** Buyer submits a claim (reason + screenshot); admins get it for review. */
export async function createReplacementRequest(opts: {
  userId: string;
  orderItemId: string;
  reason: string;
  proofFileId?: string;
}): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const item = await getReplaceableItem(opts.userId, opts.orderItemId);
  if (!item) return { ok: false, reason: "Item not found." };
  if (!item.eligible) return { ok: false, reason: item.reason ?? "Not eligible for replacement." };

  const row = await prisma.replacementRequest.create({
    data: { orderItemId: opts.orderItemId, userId: opts.userId, reason: opts.reason.slice(0, 1000), proofFileId: opts.proofFileId ?? null },
  });

  const user = await prisma.user.findUnique({ where: { id: opts.userId }, select: { telegramHandle: true, firstName: true, telegramId: true } });
  const who = user?.telegramHandle ? `@${user.telegramHandle}` : (user?.firstName ?? "customer");
  await enqueueAdminAlert(
    [
      "🔄 <b>Replacement request</b>",
      `👤 ${who}`,
      `🆔 <code>${user?.telegramId ?? "—"}</code>`,
      `📦 ${item.label}`,
      `🧾 ${item.orderNumber}`,
      "",
      `💬 ${opts.reason.slice(0, 500)}`,
      opts.proofFileId ? "\n📷 Screenshot attached — tap 📷 View proof." : "\n⚠️ No screenshot submitted.",
    ].join("\n"),
    [
      { text: "✅ Approve & replace", callbackData: `adm:rrok:${row.id}`, style: "success" as const },
      { text: "❌ Reject", callbackData: `adm:rrno:${row.id}`, style: "danger" as const },
      ...(opts.proofFileId ? [{ text: "📷 View proof", callbackData: `adm:rrpic:${row.id}`, style: "primary" as const }] : []),
    ],
  );
  return { ok: true, id: row.id };
}

export interface ReplacementRow {
  id: string;
  label: string;
  orderNumber: string;
  reason: string;
  proofFileId: string | null;
  status: string;
  who: string;
  telegramId: string;
  createdAt: Date;
}

export async function listReplacementRequests(status: "PENDING" | "ALL" = "PENDING", limit = 20): Promise<ReplacementRow[]> {
  const rows = await prisma.replacementRequest.findMany({
    where: status === "PENDING" ? { status: "PENDING" } : {},
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      user: { select: { telegramHandle: true, firstName: true, telegramId: true } },
      orderItem: { select: { productNameSnap: true, variantNameSnap: true, order: { select: { orderNumber: true } } } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    label: r.orderItem.productNameSnap,
    orderNumber: r.orderItem.order.orderNumber,
    reason: r.reason,
    proofFileId: r.proofFileId,
    status: r.status,
    who: r.user.telegramHandle ? `@${r.user.telegramHandle}` : (r.user.firstName ?? "customer"),
    telegramId: String(r.user.telegramId ?? ""),
    createdAt: r.createdAt,
  }));
}

export async function getReplacementRequest(id: string): Promise<ReplacementRow | null> {
  const r = await prisma.replacementRequest.findUnique({
    where: { id },
    include: {
      user: { select: { telegramHandle: true, firstName: true, telegramId: true } },
      orderItem: { select: { productNameSnap: true, variantNameSnap: true, order: { select: { orderNumber: true } } } },
    },
  });
  if (!r) return null;
  return {
    id: r.id,
    label: r.orderItem.productNameSnap,
    orderNumber: r.orderItem.order.orderNumber,
    reason: r.reason,
    proofFileId: r.proofFileId,
    status: r.status,
    who: r.user.telegramHandle ? `@${r.user.telegramHandle}` : (r.user.firstName ?? "customer"),
    telegramId: String(r.user.telegramId ?? ""),
    createdAt: r.createdAt,
  };
}

/** Admin approves: issue a DIFFERENT unit of the same product and tell the buyer. */
export async function approveReplacement(id: string): Promise<{ ok: boolean; reason?: string }> {
  const req = await prisma.replacementRequest.findUnique({
    where: { id },
    include: { user: { select: { telegramId: true } } },
  });
  if (!req) return { ok: false, reason: "NOT_FOUND" };
  if (req.status !== "PENDING") return { ok: false, reason: "ALREADY_REVIEWED" };

  const res = await adminReplaceOrderItem(req.orderItemId);
  if (!res.ok) return { ok: false, reason: res.reason };

  await prisma.replacementRequest.update({ where: { id }, data: { status: "APPROVED", reviewedAt: new Date() } });
  if (req.user.telegramId !== null) {
    await enqueueTelegramMessage(req.user.telegramId, "✅ <b>Replacement approved!</b>\nA fresh replacement has just been sent to you above. Thank you for your patience. 🙏");
  }
  return { ok: true };
}

export async function rejectReplacement(id: string, note?: string): Promise<{ ok: boolean; reason?: string }> {
  const req = await prisma.replacementRequest.findUnique({
    where: { id },
    include: { user: { select: { telegramId: true } } },
  });
  if (!req) return { ok: false, reason: "NOT_FOUND" };
  if (req.status !== "PENDING") return { ok: false, reason: "ALREADY_REVIEWED" };
  await prisma.replacementRequest.update({ where: { id }, data: { status: "REJECTED", reviewedAt: new Date(), adminNote: note ?? null } });
  if (req.user.telegramId !== null) {
    await enqueueTelegramMessage(
      req.user.telegramId,
      `❌ <b>Replacement request declined</b>${note ? `\n\n💬 ${note}` : ""}\n\nIf you believe this is a mistake, please open 🎫 Support and our team will take another look.`,
    );
  }
  return { ok: true };
}
