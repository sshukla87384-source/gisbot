import { loadConfig } from "@gis/config";
import { prisma, type Prisma } from "@gis/database";
import { decryptSecret } from "@gis/shared";
import { enqueueAdminAlert, enqueueTelegramMessage } from "../queues.js";
import { escHtml, noteOnTicket, openTicket, setTicketStatus } from "../support/ticket.service.js";
import { adminReplaceOrderItem, type ReplacementDetail } from "./manual-pay.service.js";

export interface ReplaceableItem {
  orderItemId: string;
  label: string;
  orderNumber: string;
  orderId: string;
  /** Position among identical units of the same product, so "Unit 2 of 5" is real. */
  unitNumber: number;
  unitTotal: number;
  /** Last 4 characters of the delivered value — how a customer identifies THIS unit. */
  tail: string | null;
  /** Already superseded by a replacement. */
  replaced: boolean;
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

/**
 * Walk a replacement chain back to the unit that was actually PURCHASED, and
 * count how many replacements that purchase has already had.
 *
 * Without this, a replacement unit looked like a brand-new purchase: it lives on
 * its own order, carries no ReplacementRequest rows, and inherits warrantyStartAt.
 * So a customer could claim on A, receive B, open B's order, claim on B, receive
 * C — free keys for as long as the original warranty ran.
 */
async function chainInfo(orderItemId: string): Promise<{ rootId: string; approvedCount: number; depth: number }> {
  let rootId = orderItemId;
  let depth = 0;
  const ids = [orderItemId];
  // Bounded walk — a cycle is impossible via @unique but never loop unbounded.
  for (let i = 0; i < 20; i++) {
    const prev = await prisma.orderItem.findFirst({
      where: { replacedByItemId: rootId },
      select: { id: true },
    });
    if (!prev) break;
    rootId = prev.id;
    ids.push(prev.id);
    depth++;
  }
  const approvedCount = await prisma.replacementRequest.count({
    where: { orderItemId: { in: ids }, status: "APPROVED" },
  });
  return { rootId, approvedCount, depth };
}

interface EligibilityInput {
  warrantyStartAt: Date | null;
  fulfilledAt: Date | null;
  replacedAt: Date | null;
  variant: { product: { warranty: boolean; warrantyDays: number | null } };
  replacements: Array<{ status: string }>;
  /** Replacements already granted across this unit's whole chain. */
  chainApproved?: number;
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
  // Already superseded — the replacement itself is the live unit now.
  if (r.replacedAt) {
    return { eligible: false, reason: "Already replaced — a new one was issued", route: "ticket", daysLeft };
  }
  if (!p.warranty) {
    return { eligible: false, reason: "Sold as-is — no warranty", route: "ticket", daysLeft: null };
  }
  // Counted across the CHAIN, not just this row, so replacing a replacement
  // cannot restart the allowance.
  if ((r.chainApproved ?? 0) > 0 || r.replacements.some((x) => x.status === "APPROVED")) {
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
const UNIT_INCLUDE: Prisma.OrderItemInclude = {
  order: { select: { orderNumber: true, id: true } },
  variant: { include: { product: { select: { warranty: true, warrantyDays: true } } } },
  replacements: { where: { status: { in: ["PENDING", "APPROVED"] } }, select: { id: true, status: true } },
};

/** Last 4 characters of a delivered value, decrypted per unit. Never throws. */
function tailOfPayload(enc: string | null, masterKey: string): string | null {
  if (!enc) return null;
  try {
    const p = JSON.parse(decryptSecret(enc, masterKey)) as { key?: string; username?: string };
    const label = (p.key ? (p.key.split(/\r?\n/)[0] ?? "") : (p.username ?? "")).trim();
    return label.length > 4 ? label.slice(-4) : label || null;
  } catch {
    return null;
  }
}

type UnitRow = {
  id: string;
  productNameSnap: string;
  variantNameSnap: string;
  deliveryPayloadEncrypted: string | null;
  replacedAt: Date | null;
  fulfilledAt: Date | null;
  warrantyStartAt: Date | null;
  order: { orderNumber: string; id: string };
  variant: { product: { warranty: boolean; warrantyDays: number | null } };
  replacements: Array<{ status: string }>;
};

function toReplaceable(
  r: UnitRow,
  pos: { n: number; total: number },
  masterKey: string,
  chainApproved = 0,
): ReplaceableItem {
  const vn = r.variantNameSnap.trim().toLowerCase() === "standard" ? "" : ` · ${r.variantNameSnap}`;
  return {
    orderItemId: r.id,
    label: `${r.productNameSnap}${vn}`,
    orderNumber: r.order.orderNumber,
    orderId: r.order.id,
    unitNumber: pos.n,
    unitTotal: pos.total,
    tail: tailOfPayload(r.deliveryPayloadEncrypted, masterKey),
    replaced: r.replacedAt !== null,
    warranty: r.variant.product.warranty,
    ...evaluate({ ...r, chainApproved }),
  };
}

/**
 * Delivered units the buyer could claim on, newest order first.
 *
 * One row per UNIT, each identified by its position and the last 4 characters of
 * its value — because "Licence Key" five times over is useless to someone trying
 * to say which one is broken.
 */
export async function listReplaceableItems(userId: string, orderLimit = 8): Promise<ReplaceableItem[]> {
  const masterKey = loadConfig().ENCRYPTION_MASTER_KEY;
  // Driven from ORDERS, not from a global OrderItem scan. The old query filtered
  // `order: { userId }` while ordering by a global fulfilledAt index, and applied
  // `take` BEFORE grouping — so unit numbers restarted mid-order and disagreed
  // with the order page, and a dormant customer's lookup walked the whole table.
  const orders = await prisma.order.findMany({
    where: { userId, items: { some: { fulfilledAt: { not: null } } } },
    orderBy: { createdAt: "desc" },
    take: orderLimit,
    select: { id: true },
  });
  if (orders.length === 0) return [];
  const rows = (await prisma.orderItem.findMany({
    where: { orderId: { in: orders.map((o) => o.id) }, fulfilledAt: { not: null } },
    orderBy: [{ fulfilledAt: "asc" }, { id: "asc" }],
    include: UNIT_INCLUDE,
  })) as unknown as UnitRow[];

  const chains = await chainMapFor(rows);
  const numbered = numberUnits(rows);
  // Newest order first for display, units ascending within each order.
  const orderRank = new Map(orders.map((o, i) => [o.id, i]));
  return rows
    .map((r) => toReplaceable(r, numbered.get(r.id) ?? { n: 1, total: 1 }, masterKey, chains.get(r.id) ?? 0))
    .sort((a, b) => (orderRank.get(a.orderId) ?? 0) - (orderRank.get(b.orderId) ?? 0) || a.unitNumber - b.unitNumber);
}

/** Unit numbers scoped to order + product + variant, computed once for a row set. */
function numberUnits(rows: UnitRow[]): Map<string, { n: number; total: number }> {
  const key = (r: UnitRow) => `${r.order.id}|${r.productNameSnap}|${r.variantNameSnap}`;
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(key(r), (totals.get(key(r)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const out = new Map<string, { n: number; total: number }>();
  // rows must already be sorted ascending for numbering to be stable.
  for (const r of rows) {
    const n = (seen.get(key(r)) ?? 0) + 1;
    seen.set(key(r), n);
    out.set(r.id, { n, total: totals.get(key(r)) ?? 1 });
  }
  return out;
}

/**
 * Chain-approved counts for many units in 2 queries instead of 2 per unit.
 * Same rule as chainInfo: a replacement inherits its ancestor's used allowance.
 */
async function chainMapFor(rows: UnitRow[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (rows.length === 0) return out;
  const ids = rows.map((r) => r.id);
  // One level up is enough in practice (a second replacement is already blocked),
  // and it is a single set-based query rather than a walk per unit.
  const parents = await prisma.orderItem.findMany({
    where: { replacedByItemId: { in: ids } },
    select: { id: true, replacedByItemId: true },
  });
  const parentOf = new Map(parents.map((p) => [p.replacedByItemId as string, p.id]));
  const allIds = [...new Set([...ids, ...parents.map((p) => p.id)])];
  const approved = await prisma.replacementRequest.groupBy({
    by: ["orderItemId"],
    where: { orderItemId: { in: allIds }, status: "APPROVED" },
    _count: { _all: true },
  });
  const countOf = new Map(approved.map((a) => [a.orderItemId, a._count._all]));
  for (const r of rows) {
    const own = countOf.get(r.id) ?? 0;
    const parent = parentOf.get(r.id);
    out.set(r.id, own + (parent ? (countOf.get(parent) ?? 0) : 0));
  }
  return out;
}

/** Every delivered unit of ONE order — what the selection screen is built from. */
export async function listUnitsForOrder(userId: string, orderId: string): Promise<ReplaceableItem[]> {
  const masterKey = loadConfig().ENCRYPTION_MASTER_KEY;
  const rows = (await prisma.orderItem.findMany({
    // Ownership is enforced in the query itself, not by the caller.
    where: { orderId, order: { userId }, fulfilledAt: { not: null } },
    orderBy: [{ fulfilledAt: "asc" }, { id: "asc" }],
    take: 200,
    include: UNIT_INCLUDE,
  })) as unknown as UnitRow[];
  if (rows.length === 0) return [];
  const [chains, numbered] = [await chainMapFor(rows), numberUnits(rows)];
  return rows.map((r) => toReplaceable(r, numbered.get(r.id) ?? { n: 1, total: 1 }, masterKey, chains.get(r.id) ?? 0));
}

export async function getReplaceableItem(userId: string, orderItemId: string): Promise<ReplaceableItem | null> {
  const own = await prisma.orderItem.findFirst({
    where: { id: orderItemId, order: { userId }, fulfilledAt: { not: null } },
    select: { orderId: true },
  });
  if (!own) return null;
  // Built from the same function the picker uses, so "unit 2" is the same unit on
  // every screen by construction rather than by two implementations agreeing.
  const units = await listUnitsForOrder(userId, own.orderId);
  return units.find((u) => u.orderItemId === orderItemId) ?? null;
}

export interface BatchResult {
  ok: boolean;
  /** Units accepted, with the label the customer will recognise. */
  accepted: Array<{ orderItemId: string; label: string; unitNumber: number; tail: string | null }>;
  /** Units refused, each with the reason — never silently dropped. */
  rejected: Array<{ orderItemId: string; label: string; unitNumber: number; reason: string }>;
  /** In-warranty claims go to review; out-of-warranty ones open a ticket. */
  claimIds: string[];
  ticketNumber: string | null;
  reason?: string;
}

/**
 * Submit a claim for SEVERAL specific units at once — the partial-replacement
 * case: five keys delivered, only #2 and #4 broken.
 *
 * Every selected id is re-validated here against the database. The frontend
 * selection is treated as a request, not as a fact: ownership, delivery, prior
 * replacement and warranty are all re-checked per unit, so a tampered callback
 * cannot reach another customer's key or claim twice on the same unit.
 */
export async function createReplacementBatch(opts: {
  userId: string;
  orderItemIds: string[];
  reason: string;
  proofFileId?: string;
}): Promise<BatchResult> {
  const ids = [...new Set(opts.orderItemIds)].slice(0, 25); // de-duped and bounded
  const empty: BatchResult = { ok: false, accepted: [], rejected: [], claimIds: [], ticketNumber: null };
  if (ids.length === 0) return { ...empty, reason: "Nothing selected." };

  // ONE order-scoped lookup, not one per selected id. The old version fanned
  // getReplaceableItem across up to 25 ids — ~176 round trips for a single submit,
  // enough to starve the connection pool and stall every other bot request.
  const owned = await prisma.orderItem.findMany({
    // Ownership enforced in the query: anything not belonging to this user simply
    // is not returned, and falls into `rejected` below.
    where: { id: { in: ids }, order: { userId: opts.userId }, fulfilledAt: { not: null } },
    select: { id: true, orderId: true },
  });
  // All selections must come from ONE order. A crafted callback could otherwise
  // mix orders, which then mis-labels the alert and splits the follow-up.
  const orderIds = [...new Set(owned.map((o) => o.orderId))];
  if (orderIds.length > 1) return { ...empty, reason: "Please select items from one order at a time." };
  const byId = new Map<string, ReplaceableItem>();
  if (orderIds[0]) {
    for (const u of await listUnitsForOrder(opts.userId, orderIds[0])) byId.set(u.orderItemId, u);
  }
  const units = ids.map((id) => byId.get(id) ?? null);
  const accepted: BatchResult["accepted"] = [];
  const rejected: BatchResult["rejected"] = [];
  const claimUnits: ReplaceableItem[] = [];
  const ticketUnits: ReplaceableItem[] = [];

  for (let i = 0; i < ids.length; i++) {
    const u = units[i];
    if (!u) {
      rejected.push({ orderItemId: ids[i] as string, label: "Unknown item", unitNumber: 0, reason: "Not found on your account" });
      continue;
    }
    if (u.route === "claim") claimUnits.push(u);
    else if (u.route === "ticket") ticketUnits.push(u);
    else {
      rejected.push({ orderItemId: u.orderItemId, label: u.label, unitNumber: u.unitNumber, reason: u.reason ?? "Not eligible" });
      continue;
    }
    accepted.push({ orderItemId: u.orderItemId, label: u.label, unitNumber: u.unitNumber, tail: u.tail });
  }

  if (accepted.length === 0) return { ...empty, rejected, reason: "None of the selected items can be replaced." };

  const reason = opts.reason.slice(0, 1000);
  const claimIds: string[] = [];
  const user = await prisma.user.findUnique({
    where: { id: opts.userId },
    select: { telegramHandle: true, firstName: true, telegramId: true },
  });
  const who = user?.telegramHandle ? `@${user.telegramHandle}` : (user?.firstName ?? "customer");
  const unitLine = (u: ReplaceableItem) =>
    `• ${escHtml(u.label)} — unit ${u.unitNumber}/${u.unitTotal}${u.tail ? ` (…${escHtml(u.tail)})` : ""}`;

  // In-warranty units: one request row each, so each can be approved or rejected
  // on its own. A single row for five units would force an all-or-nothing call.
  if (claimUnits.length > 0) {
    // createMany is one round trip; the ids come back from a follow-up select
    // because Postgres createMany cannot return them.
    await prisma.replacementRequest.createMany({
      data: claimUnits.map((u) => ({
        orderItemId: u.orderItemId,
        userId: opts.userId,
        reason,
        proofFileId: opts.proofFileId ?? null,
        warrantyCovered: true,
      })),
    });
    const made = await prisma.replacementRequest.findMany({
      where: { userId: opts.userId, status: "PENDING", orderItemId: { in: claimUnits.map((u) => u.orderItemId) } },
      orderBy: { createdAt: "desc" },
      take: claimUnits.length,
      select: { id: true },
    });
    claimIds.push(...made.map((m) => m.id));
  }

  if (claimUnits.length > 0) {
    await enqueueAdminAlert(
      [
        `🔄 <b>Replacement request</b> — ${claimUnits.length} item(s)`,
        `👤 ${escHtml(who)}`,
        `🆔 <code>${user?.telegramId ?? "—"}</code>`,
        `🧾 ${escHtml(claimUnits[0]?.orderNumber ?? "")}`,
        "",
        ...claimUnits.map(unitLine),
        "",
        `💬 ${escHtml(reason.slice(0, 400))}`,
        opts.proofFileId ? "📷 Screenshot attached." : "⚠️ No screenshot submitted.",
      ].join("\n"),
      [
        // Approve-all is one tap; each unit is still individually reviewable.
        ...(claimIds.length > 1
          ? [{ text: `✅ Approve all ${claimIds.length}`, callbackData: `adm:rrall:${claimIds[0]}`, style: "success" as const }]
          : []),
        ...claimIds.slice(0, 3).map((id, n) => ({
          text: claimIds.length > 1 ? `✅ Approve #${claimUnits[n]?.unitNumber ?? n + 1}` : "✅ Approve & replace",
          callbackData: `adm:rrok:${id}`,
          style: "success" as const,
        })),
        { text: "🔄 Review all", callbackData: "adm:reps", style: "primary" as const },
      ],
    ).catch(() => undefined);
  }

  // Out-of-warranty units: ONE ticket covering them all, so support has a single
  // conversation rather than five.
  let ticketNumber: string | null = null;
  if (ticketUnits.length > 0) {
    const first = ticketUnits[0] as ReplaceableItem;
    try {
    const t = await openTicket({
      userId: opts.userId,
      category: "ORDER_ISSUE",
      subject: `${first.label} — ${ticketUnits.length} item(s), out of warranty`,
      body: reason,
      orderId: first.orderId,
      // The primary unit; the rest are listed in the body and alert.
      orderItemId: first.orderItemId,
      proofFileId: opts.proofFileId ?? null,
      alertLines: [
        `🧾 ${escHtml(first.orderNumber)}`,
        `⚠️ Out of warranty — ${ticketUnits.length} item(s), your call:`,
        ...ticketUnits.map(unitLine),
      ],
      extraButtons: [{ text: "🔄 Issue replacement", callbackData: `adm:tkrep:${first.orderItemId}`, style: "success" as const }],
    });
    ticketNumber = t.ticketNumber;
    } catch (e) {
      // The warranty claims above are already recorded, so report a partial
      // success rather than throwing and inviting a duplicate resubmission.
      // eslint-disable-next-line no-console
      console.error("replacement ticket failed", { error: String(e).slice(0, 200) });
      for (const u of ticketUnits) {
        rejected.push({ orderItemId: u.orderItemId, label: u.label, unitNumber: u.unitNumber, reason: "Could not open a ticket — please try again" });
      }
    }
  }

  return { ok: true, accepted, rejected, claimIds, ticketNumber };
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
    alertLines: [`📦 ${escHtml(item.label)}`, `🧾 ${escHtml(item.orderNumber)}`, `⚠️ ${escHtml(item.reason ?? "Out of warranty")} — your call.`],
    extraButtons: [{ text: "🔄 Issue replacement", callbackData: `adm:tkrep:${opts.orderItemId}`, style: "success" as const }],
  });
  return { ok: true, ticketNumber: t.ticketNumber };
}

/**
 * Support chooses to replace an item attached to a ticket — a goodwill
 * replacement outside the warranty. Same delivery path as an approved claim.
 */
export async function issueReplacementFromTicket(
  ticketId: string,
  opts: { approvedBy?: string; orderItemId?: string } = {},
): Promise<{ ok: boolean; reason?: string; detail?: ReplacementDetail }> {
  const t = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: { orderItemId: true, ticketNumber: true, userId: true },
  });
  const targetId = opts.orderItemId ?? t?.orderItemId;
  if (!t || !targetId) return { ok: false, reason: "This ticket is not linked to a delivered item." };

  // Record the replacement, otherwise the item still evaluates as claimable and
  // could be replaced again and again — each time burning a live unit of stock
  // against a single sale.
  const already = await prisma.replacementRequest.findFirst({
    where: { orderItemId: targetId, status: "APPROVED" },
    select: { id: true },
  });
  if (already) return { ok: false, reason: "This item has already been replaced once." };

  const res = await adminReplaceOrderItem(targetId, {
    warrantyCovered: false,
    approvedBy: opts.approvedBy,
    ticketId,
  });
  // FAILED: do not note, do not resolve, do not close. The ticket stays open so
  // the admin can retry — closing a ticket on a failed replacement is how a
  // customer ends up with nothing and no way to chase it.
  if (!res.ok || !res.detail) return { ok: false, reason: res.reason };
  const d = res.detail;

  await prisma.replacementRequest.create({
    data: {
      orderItemId: targetId,
      userId: t.userId,
      reason: `Goodwill replacement issued by support on ticket ${t.ticketNumber}`,
      status: "APPROVED",
      warrantyCovered: false,
      ticketId,
      replacementOrderItemId: d.replacementItemId,
      approvedBy: opts.approvedBy ?? null,
      reviewedAt: new Date(),
    },
  }).catch(() => undefined);

  // The full result goes INTO the ticket thread FIRST, so the customer sees the
  // replacement in the conversation they were already having. Previously the only
  // thing that arrived here was "Ticket closed", and they had to go hunting
  // through My Orders to discover whether they'd been given anything.
  const at = d.at.toISOString().slice(0, 16).replace("T", " ");
  const body = [
    "✅ Replacement completed",
    "",
    `Product: ${d.productName}${d.variantName && d.variantName.toLowerCase() !== "standard" ? ` · ${d.variantName}` : ""}`,
    "Items replaced: 1",
    `Original order: ${d.originalOrderNumber}`,
    ...(d.replacementOrderNumber ? [`Replacement order: ${d.replacementOrderNumber}`] : []),
    `Type: ${d.warrantyCovered ? "Warranty replacement" : "Goodwill replacement (outside warranty)"}`,
    ...(d.oldTail ? [`Replaced unit: ends …${d.oldTail}`] : []),
    `New unit: ends …${d.newTail}`,
    `Completed: ${at}`,
    "",
    "The new details have been sent to you in this chat — tap 📦 View updated order to see it alongside the original.",
  ].join("\n");

  // Resolve only AFTER the message is safely on the thread.
  await noteOnTicket(ticketId, body);
  await notifyReplacementOnTicket(ticketId, d);
  await setTicketStatus(ticketId, "RESOLVED", false);
  return { ok: true, detail: d };
}

/**
 * Push the replacement result to the customer as a chat message, with a button
 * straight to the updated order. Telegram push IS this project's realtime
 * channel — there is no page to revalidate, the message simply arrives.
 */
async function notifyReplacementOnTicket(ticketId: string, d: ReplacementDetail): Promise<void> {
  const t = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: { ticketNumber: true, user: { select: { telegramId: true } } },
  });
  if (!t?.user.telegramId) return;
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const at = d.at.toISOString().slice(0, 16).replace("T", " ");
  await enqueueTelegramMessage(
    t.user.telegramId,
    [
      "✅ <b>Replacement completed</b>",
      `🎫 Ticket <b>${esc(t.ticketNumber)}</b>`,
      "",
      `📦 <b>${esc(d.productName)}</b>${d.variantName && d.variantName.toLowerCase() !== "standard" ? ` · ${esc(d.variantName)}` : ""}`,
      `🔢 Items replaced: <b>1</b>`,
      `🧾 Original order: <b>${esc(d.originalOrderNumber)}</b>`,
      ...(d.replacementOrderNumber ? [`🧾 Replacement order: <b>${esc(d.replacementOrderNumber)}</b>`] : []),
      `🛡 ${d.warrantyCovered ? "Warranty replacement" : "Goodwill replacement — outside warranty"}`,
      "",
      ...(d.oldTail ? [`❌ Replaced unit: <code>…${esc(d.oldTail)}</code> <i>(no longer works)</i>`] : []),
      `✅ New unit: <code>…${esc(d.newTail)}</code>`,
      `🕒 ${at}`,
      "",
      "The full details were sent to you just above. Your original key stays visible in the order for your records.",
    ].join("\n"),
    {
      buttons: [
        { text: "📦 View updated order", callbackData: `ord:view:${d.originalOrderId}`, style: "success" as const },
        ...(d.replacementOrderId ? [{ text: "🧾 Replacement order", callbackData: `ord:view:${d.replacementOrderId}`, style: "primary" as const }] : []),
        { text: "🎫 View ticket", callbackData: `tkt:open:${ticketId}`, style: "primary" as const },
      ],
    },
  ).catch(() => undefined);
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
export async function approveReplacement(id: string, approvedBy?: string): Promise<{ ok: boolean; reason?: string; detail?: ReplacementDetail }> {
  const req = await prisma.replacementRequest.findUnique({
    where: { id },
    include: { user: { select: { telegramId: true } } },
  });
  if (!req) return { ok: false, reason: "NOT_FOUND" };
  if (req.status !== "PENDING") return { ok: false, reason: "ALREADY_REVIEWED" };

  const res = await adminReplaceOrderItem(req.orderItemId, {
    warrantyCovered: req.warrantyCovered,
    approvedBy,
    ticketId: req.ticketId ?? undefined,
  });
  // Only mark APPROVED once the unit really was delivered — otherwise a failed
  // replacement would look reviewed and settled while the customer got nothing.
  if (!res.ok || !res.detail) return { ok: false, reason: res.reason };
  const d = res.detail;

  await prisma.replacementRequest.update({
    where: { id },
    data: {
      status: "APPROVED",
      reviewedAt: new Date(),
      approvedBy: approvedBy ?? null,
      replacementOrderItemId: d.replacementItemId,
    },
  });

  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (req.user.telegramId !== null) {
    await enqueueTelegramMessage(
      req.user.telegramId,
      [
        "✅ <b>Replacement approved</b>",
        "",
        `📦 <b>${esc(d.productName)}</b>`,
        `🧾 Original order: <b>${esc(d.originalOrderNumber)}</b>`,
        ...(d.replacementOrderNumber ? [`🧾 Replacement order: <b>${esc(d.replacementOrderNumber)}</b>`] : []),
        `🛡 Warranty replacement`,
        "",
        ...(d.oldTail ? [`❌ Replaced unit: <code>…${esc(d.oldTail)}</code>`] : []),
        `✅ New unit: <code>…${esc(d.newTail)}</code>`,
        "",
        "The full details were sent to you just above. Your original key stays in the order for your records. Thank you for your patience. 🙏",
      ].join("\n"),
      {
        buttons: [
          { text: "📦 View updated order", callbackData: `ord:view:${d.originalOrderId}`, style: "success" as const },
          ...(d.replacementOrderId ? [{ text: "🧾 Replacement order", callbackData: `ord:view:${d.replacementOrderId}`, style: "primary" as const }] : []),
        ],
      },
    );
  }
  // If this claim came in through a ticket, put the outcome on that thread too.
  if (req.ticketId) {
    await noteOnTicket(req.ticketId, `✅ Warranty replacement completed — new unit ends …${d.newTail}, order ${d.replacementOrderNumber ?? "—"}.`).catch(() => undefined);
    await setTicketStatus(req.ticketId, "RESOLVED", false).catch(() => undefined);
  }
  return { ok: true, detail: d };
}

/** Approve several pending claims in one tap — the partial-replacement case. */
export async function approveReplacementsForOrder(
  firstRequestId: string,
  approvedBy?: string,
): Promise<{ done: number; failed: Array<{ id: string; reason: string }> }> {
  const seed = await prisma.replacementRequest.findUnique({
    where: { id: firstRequestId },
    select: { orderItem: { select: { orderId: true } }, createdAt: true, userId: true },
  });
  if (!seed) return { done: 0, failed: [{ id: firstRequestId, reason: "NOT_FOUND" }] };
  // Same order, same customer, still pending — the batch that was submitted together.
  // Bounded to the submission window. Without this, "Approve all 3" on Monday's
  // alert also approved claims filed on Tuesday that the admin never looked at.
  const from = new Date(seed.createdAt.getTime() - 60_000);
  const to = new Date(seed.createdAt.getTime() + 60_000);
  const siblings = await prisma.replacementRequest.findMany({
    where: {
      status: "PENDING",
      userId: seed.userId,
      orderItem: { orderId: seed.orderItem.orderId },
      createdAt: { gte: from, lte: to },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  let done = 0;
  const failed: Array<{ id: string; reason: string }> = [];
  for (const s of siblings) {
    const r = await approveReplacement(s.id, approvedBy);
    if (r.ok) done++;
    else failed.push({ id: s.id, reason: r.reason ?? "FAILED" });
  }
  return { done, failed };
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
