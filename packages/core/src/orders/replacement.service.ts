import { prisma } from "@gis/database";
import { enqueueAdminAlert, enqueueTelegramMessage } from "../queues.js";
import { noteOnTicket, openTicket, setTicketStatus } from "../support/ticket.service.js";
import { adminReplaceOrderItem } from "./manual-pay.service.js";

export interface ReplaceableItem {
  orderItemId: string;
  label: string;
  orderNumber: string;
  warranty: boolean;
  eligible: boolean;
  reason: string | null;
  /**
   * "claim"  → in warranty: a replacement claim our team approves.
   * "ticket" → out of warranty / already replaced: a support ticket a human
   *            answers. No automatic replacement is offered, but support CAN
   *            issue one from the ticket if they decide to.
   * "blocked" → already in progress; nothing to do but wait.
   */
  route: "claim" | "ticket" | "blocked";
  /** Days of cover left, counted from the FIRST delivery. Null when untimed. */
  daysLeft: number | null;
}

interface EligibilityInput {
  warrantyStartAt: Date | null;
  fulfilledAt: Date | null;
  variant: { product: { warranty: boolean; warrantyDays: number | null } };
  replacements: Array<{ status: string }>;
}

/**
 * One place decides eligibility, so the list and the detail can never disagree.
 * The warranty window is measured from `warrantyStartAt` — the FIRST delivery —
 * so a replacement continues the original cover instead of restarting it.
 */
function evaluate(r: EligibilityInput): Pick<ReplaceableItem, "eligible" | "reason" | "route" | "daysLeft"> {
  const p = r.variant.product;
  const start = r.warrantyStartAt ?? r.fulfilledAt;
  let daysLeft: number | null = null;
  if (p.warranty && p.warrantyDays && start) {
    const ageDays = (Date.now() - start.getTime()) / 86_400_000;
    daysLeft = Math.max(0, Math.ceil(p.warrantyDays - ageDays));
  }

  if (r.replacements.some((x) => x.status === "PENDING")) {
    return { eligible: false, reason: "A request is already under review", route: "blocked", daysLeft };
  }
  if (!p.warranty) {
    return { eligible: false, reason: "Sold as-is — no warranty", route: "ticket", daysLeft: null };
  }
  if (r.replacements.some((x) => x.status === "APPROVED")) {
    return { eligible: false, reason: "Already replaced once", route: "ticket", daysLeft };
  }
  if (p.warrantyDays && start && daysLeft !== null && daysLeft <= 0) {
    return { eligible: false, reason: `Warranty expired (${p.warrantyDays}d)`, route: "ticket", daysLeft: 0 };
  }
  return { eligible: true, reason: null, route: "claim", daysLeft };
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
    return {
      orderItemId: r.id,
      label: `${r.productNameSnap}${vn}`,
      orderNumber: r.order.orderNumber,
      warranty: p.warranty,
      ...evaluate(r),
    };
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
  return {
    orderItemId: r.id,
    label: `${r.productNameSnap}${vn}`,
    orderNumber: r.order.orderNumber,
    warranty: p.warranty,
    ...evaluate(r),
  };
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
  // Out-of-warranty goes through support, never through the auto-claim path.
  if (item.route !== "claim") return { ok: false, reason: item.reason ?? "Not eligible for replacement." };

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

/**
 * Out-of-warranty problem → a support ticket, not an automatic replacement.
 * A human reads it, replies, and decides. Support can still issue a replacement
 * from inside the ticket, which is the point: the decision is theirs, not the bot's.
 */
export async function createReplacementTicket(opts: {
  userId: string;
  orderItemId: string;
  reason: string;
  proofFileId?: string;
}): Promise<{ ok: true; ticketNumber: string } | { ok: false; reason: string }> {
  const item = await getReplaceableItem(opts.userId, opts.orderItemId);
  if (!item) return { ok: false, reason: "Item not found." };
  if (item.route === "blocked") return { ok: false, reason: item.reason ?? "Already under review." };
  if (item.route === "claim") return { ok: false, reason: "This item is in warranty — use the replacement claim." };

  const orderItem = await prisma.orderItem.findUnique({ where: { id: opts.orderItemId }, select: { orderId: true } });
  const t = await openTicket({
    userId: opts.userId,
    category: "ORDER_ISSUE",
    subject: `${item.label} — ${item.reason ?? "out of warranty"}`,
    body: opts.reason,
    orderId: orderItem?.orderId ?? null,
    orderItemId: opts.orderItemId,
    proofFileId: opts.proofFileId ?? null,
    alertLines: [`📦 ${item.label}`, `🧾 ${item.orderNumber}`, `⚠️ ${item.reason ?? "Out of warranty"} — your call.`],
    extraButtons: [{ text: "🔄 Issue replacement", callbackData: `adm:tkrep:${opts.orderItemId}`, style: "success" as const }],
  });
  return { ok: true, ticketNumber: t.ticketNumber };
}

/**
 * Support chooses to replace an item attached to a ticket — a goodwill
 * replacement outside the warranty. Same delivery path as an approved claim.
 */
export async function issueReplacementFromTicket(ticketId: string): Promise<{ ok: boolean; reason?: string }> {
  const t = await prisma.supportTicket.findUnique({ where: { id: ticketId }, select: { orderItemId: true, ticketNumber: true, userId: true } });
  if (!t?.orderItemId) return { ok: false, reason: "This ticket is not linked to a delivered item." };

  // Record the replacement, otherwise the item still evaluates as claimable and
  // could be replaced again and again — each time burning a live unit of stock
  // against a single sale.
  const already = await prisma.replacementRequest.findFirst({
    where: { orderItemId: t.orderItemId, status: "APPROVED" },
    select: { id: true },
  });
  if (already) return { ok: false, reason: "This item has already been replaced once." };

  const res = await adminReplaceOrderItem(t.orderItemId);
  if (!res.ok) return { ok: false, reason: res.reason };
  await prisma.replacementRequest.create({
    data: {
      orderItemId: t.orderItemId,
      userId: t.userId,
      reason: `Goodwill replacement issued by support on ticket ${t.ticketNumber}`,
      status: "APPROVED",
      reviewedAt: new Date(),
    },
  }).catch(() => undefined);
  await noteOnTicket(ticketId, "🔄 Replacement issued by support (goodwill — outside warranty).");
  await setTicketStatus(ticketId, "RESOLVED", false);
  return { ok: true };
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
