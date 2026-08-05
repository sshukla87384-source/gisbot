import { nextTicketNumber, prisma, type TicketStatus } from "@gis/database";
import { enqueueAdminAlert, enqueueTelegramMessage } from "../queues.js";

export interface TicketSummary {
  id: string;
  ticketNumber: string;
  subject: string;
  status: TicketStatus;
  createdAt: Date;
}

export async function createTicket(userId: string, category: string, body: string): Promise<TicketSummary> {
  const allowed = ["ORDER_ISSUE", "DELIVERY_ISSUE", "PAYMENT_ISSUE", "ACCOUNT", "OTHER"] as const;
  const cat = (allowed as readonly string[]).includes(category) ? category : "OTHER";

  return prisma.$transaction(async (tx) => {
    const ticketNumber = await nextTicketNumber(tx);
    const ticket = await tx.supportTicket.create({
      data: {
        ticketNumber,
        userId,
        category: cat as (typeof allowed)[number],
        subject: body.slice(0, 60),
        messages: { create: { authorId: userId, authorType: "CUSTOMER", body } },
      },
    });
    return {
      id: ticket.id,
      ticketNumber: ticket.ticketNumber,
      subject: ticket.subject,
      status: ticket.status,
      createdAt: ticket.createdAt,
    };
  });
}

export async function listTickets(userId: string, page: number, pageSize = 6): Promise<{
  items: TicketSummary[];
  page: number;
  pages: number;
}> {
  const total = await prisma.supportTicket.count({ where: { userId } });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const rows = await prisma.supportTicket.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
  return {
    items: rows.map((t) => ({
      id: t.id,
      ticketNumber: t.ticketNumber,
      subject: t.subject,
      status: t.status,
      createdAt: t.createdAt,
    })),
    page,
    pages,
  };
}

// ─────────────────────────── Two-way ticket conversation ───────────────────────────
//
// A ticket is only useful if support can answer it. Everything below is that
// missing half: the customer's thread, the admin's queue, replies in both
// directions, and — for items with no warranty — an "issue replacement"
// decision that a human makes instead of the bot handing one out automatically.

export interface TicketMsg {
  id: string;
  authorType: "CUSTOMER" | "ADMIN" | "SYSTEM";
  body: string;
  proofFileId: string | null;
  createdAt: Date;
}

export interface TicketThread {
  id: string;
  ticketNumber: string;
  subject: string;
  status: TicketStatus;
  category: string;
  createdAt: Date;
  orderItemId: string | null;
  itemLabel: string | null;
  orderNumber: string | null;
  who: string;
  telegramId: string;
  messages: TicketMsg[];
}

const OPEN_STATES: TicketStatus[] = ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER"];

/** Create a ticket AND tell the admins about it — the old version told nobody. */
export async function openTicket(opts: {
  userId: string;
  category: string;
  body: string;
  subject?: string;
  orderId?: string | null;
  orderItemId?: string | null;
  proofFileId?: string | null;
  /** Extra lines for the admin alert, and extra buttons. */
  alertLines?: string[];
  extraButtons?: Array<{ text: string; callbackData: string; style?: "primary" | "success" | "danger" }>;
}): Promise<TicketSummary> {
  const allowed = ["ORDER_ISSUE", "DELIVERY_ISSUE", "PAYMENT_ISSUE", "ACCOUNT", "OTHER"] as const;
  const cat = (allowed as readonly string[]).includes(opts.category) ? opts.category : "OTHER";
  const body = opts.body.trim().slice(0, 2000);

  const ticket = await prisma.$transaction(async (tx) => {
    const ticketNumber = await nextTicketNumber(tx);
    return tx.supportTicket.create({
      data: {
        ticketNumber,
        userId: opts.userId,
        category: cat as (typeof allowed)[number],
        subject: (opts.subject ?? body).slice(0, 60) || "Support request",
        orderId: opts.orderId ?? null,
        orderItemId: opts.orderItemId ?? null,
        messages: { create: { authorId: opts.userId, authorType: "CUSTOMER", body, proofFileId: opts.proofFileId ?? null } },
      },
    });
  });

  const u = await prisma.user
    .findUnique({ where: { id: opts.userId }, select: { telegramHandle: true, firstName: true, telegramId: true } })
    .catch(() => null);
  const who = u?.telegramHandle ? `@${u.telegramHandle}` : (u?.firstName ?? "customer");
  void enqueueAdminAlert(
    [
      `🎫 <b>New ticket ${ticket.ticketNumber}</b>`,
      `👤 ${esc(who)}`,
      `🆔 <code>${u?.telegramId ?? "—"}</code>`,
      ...(opts.alertLines ?? []),
      "",
      `💬 ${esc(body).slice(0, 700)}`,
      opts.proofFileId ? "\n📷 Screenshot attached." : "",
    ]
      .filter((l) => l !== "")
      .join("\n"),
    [
      { text: "📂 Open ticket", callbackData: `adm:tk:${ticket.id}`, style: "primary" as const },
      ...(opts.extraButtons ?? []),
    ],
  ).catch(() => undefined);

  return {
    id: ticket.id,
    ticketNumber: ticket.ticketNumber,
    subject: ticket.subject,
    status: ticket.status,
    createdAt: ticket.createdAt,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function threadOf(where: { id: string; userId?: string }): Promise<TicketThread | null> {
  const t = await prisma.supportTicket.findFirst({
    where,
    include: {
      user: { select: { telegramHandle: true, firstName: true, telegramId: true } },
      messages: { orderBy: { createdAt: "asc" }, take: 40 },
    },
  });
  if (!t) return null;
  let itemLabel: string | null = null;
  let orderNumber: string | null = null;
  if (t.orderItemId) {
    const it = await prisma.orderItem
      .findUnique({
        where: { id: t.orderItemId },
        select: { productNameSnap: true, variantNameSnap: true, order: { select: { orderNumber: true } } },
      })
      .catch(() => null);
    if (it) {
      const vn = it.variantNameSnap.trim().toLowerCase() === "standard" ? "" : ` · ${it.variantNameSnap}`;
      itemLabel = `${it.productNameSnap}${vn}`;
      orderNumber = it.order.orderNumber;
    }
  }
  return {
    id: t.id,
    ticketNumber: t.ticketNumber,
    subject: t.subject,
    status: t.status,
    category: String(t.category),
    createdAt: t.createdAt,
    orderItemId: t.orderItemId,
    itemLabel,
    orderNumber,
    who: t.user.telegramHandle ? `@${t.user.telegramHandle}` : (t.user.firstName ?? "customer"),
    telegramId: String(t.user.telegramId ?? "—"),
    messages: t.messages.map((m) => ({
      id: m.id,
      authorType: m.authorType as TicketMsg["authorType"],
      body: m.body,
      proofFileId: m.proofFileId,
      createdAt: m.createdAt,
    })),
  };
}

/** The customer's own thread — scoped to them so nobody can read another ticket. */
export function getMyTicket(userId: string, ticketId: string): Promise<TicketThread | null> {
  return threadOf({ id: ticketId, userId });
}

export function adminGetTicket(ticketId: string): Promise<TicketThread | null> {
  return threadOf({ id: ticketId });
}

export async function adminListTickets(opts: { openOnly?: boolean; limit?: number } = {}): Promise<Array<{
  id: string;
  ticketNumber: string;
  subject: string;
  status: TicketStatus;
  who: string;
  hasItem: boolean;
  waitingOnUs: boolean;
  createdAt: Date;
}>> {
  const rows = await prisma.supportTicket.findMany({
    where: opts.openOnly === false ? {} : { status: { in: OPEN_STATES } },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: opts.limit ?? 15,
    include: { user: { select: { telegramHandle: true, firstName: true } } },
  });
  return rows.map((t) => ({
    id: t.id,
    ticketNumber: t.ticketNumber,
    subject: t.subject,
    status: t.status,
    who: t.user.telegramHandle ? `@${t.user.telegramHandle}` : (t.user.firstName ?? "customer"),
    hasItem: Boolean(t.orderItemId),
    // Nothing from us yet, or the customer answered last.
    waitingOnUs: t.status !== "WAITING_CUSTOMER",
    createdAt: t.createdAt,
  }));
}

/** Count for the admin panel badge. */
export function openTicketCount(): Promise<number> {
  return prisma.supportTicket.count({ where: { status: { in: OPEN_STATES } } }).catch(() => 0);
}

/** Support answers. The customer gets it as a normal Telegram message. */
export async function adminReplyTicket(ticketId: string, body: string): Promise<{ ok: boolean; ticketNumber?: string }> {
  const t = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: { id: true, ticketNumber: true, firstResponseAt: true, user: { select: { telegramId: true } } },
  });
  if (!t) return { ok: false };
  const text = body.trim().slice(0, 2000);
  await prisma.supportTicket.update({
    where: { id: t.id },
    data: {
      status: "WAITING_CUSTOMER",
      firstResponseAt: t.firstResponseAt ?? new Date(),
      messages: { create: { authorType: "ADMIN", body: text } },
    },
  });
  if (t.user.telegramId) await enqueueTelegramMessage(
    t.user.telegramId,
    [`💬 <b>Support replied</b> — ticket <b>${t.ticketNumber}</b>`, "", esc(text)].join("\n"),
    { buttons: [{ text: "↩️ Reply", callbackData: `tkt:re:${t.id}`, style: "primary" }, { text: "📂 View ticket", callbackData: `tkt:open:${t.id}`, style: "primary" }] },
  ).catch(() => undefined);
  return { ok: true, ticketNumber: t.ticketNumber };
}

/** The customer answers back — the thread stays in one place instead of a new ticket. */
export async function customerReplyTicket(userId: string, ticketId: string, body: string, proofFileId?: string): Promise<{ ok: boolean; ticketNumber?: string }> {
  const t = await prisma.supportTicket.findFirst({
    where: { id: ticketId, userId, status: { in: OPEN_STATES } },
    select: { id: true, ticketNumber: true },
  });
  if (!t) return { ok: false };
  const text = body.trim().slice(0, 2000);
  await prisma.supportTicket.update({
    where: { id: t.id },
    data: { status: "IN_PROGRESS", messages: { create: { authorId: userId, authorType: "CUSTOMER", body: text, proofFileId: proofFileId ?? null } } },
  });
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { telegramHandle: true, firstName: true } }).catch(() => null);
  const who = u?.telegramHandle ? `@${u.telegramHandle}` : (u?.firstName ?? "customer");
  void enqueueAdminAlert(
    [`💬 <b>Reply on ${t.ticketNumber}</b>`, `👤 ${esc(who)}`, "", esc(text).slice(0, 700)].join("\n"),
    [{ text: "📂 Open ticket", callbackData: `adm:tk:${t.id}`, style: "primary" as const }],
  ).catch(() => undefined);
  return { ok: true, ticketNumber: t.ticketNumber };
}

/** Add a SYSTEM note (e.g. "replacement issued") — never notifies anyone. */
export async function noteOnTicket(ticketId: string, body: string): Promise<void> {
  await prisma.ticketMessage.create({ data: { ticketId, authorType: "SYSTEM", body: body.slice(0, 500) } }).catch(() => undefined);
}

export async function setTicketStatus(ticketId: string, status: TicketStatus, notify = true): Promise<{ ok: boolean; ticketNumber?: string }> {
  const t = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: { id: true, ticketNumber: true, user: { select: { telegramId: true } } },
  });
  if (!t) return { ok: false };
  await prisma.supportTicket.update({
    where: { id: t.id },
    data: {
      status,
      resolvedAt: status === "RESOLVED" ? new Date() : undefined,
      closedAt: status === "CLOSED" ? new Date() : undefined,
    },
  });
  if (notify && t.user.telegramId && (status === "RESOLVED" || status === "CLOSED")) {
    await enqueueTelegramMessage(
      t.user.telegramId,
      status === "RESOLVED"
        ? [`✅ <b>Ticket ${t.ticketNumber} resolved</b>`, "", "If this is still not sorted, just reply and we'll reopen it. 🙏"].join("\n")
        : [`🔒 <b>Ticket ${t.ticketNumber} closed</b>`, "", "Thank you for your patience. Open a new ticket any time."].join("\n"),
      { buttons: [{ text: "🎫 Support", callbackData: "sup:home", style: "primary" }] },
    ).catch(() => undefined);
  }
  return { ok: true, ticketNumber: t.ticketNumber };
}

/** file_id of a screenshot on one ticket message, for the admin's 📷 button. */
export async function getTicketProof(messageId: string): Promise<string | null> {
  const m = await prisma.ticketMessage.findUnique({ where: { id: messageId }, select: { proofFileId: true } }).catch(() => null);
  return m?.proofFileId ?? null;
}

/** Newest ticket about a delivered item — the alert button carries the item id. */
export async function findTicketByOrderItem(orderItemId: string): Promise<string | null> {
  const t = await prisma.supportTicket
    .findFirst({ where: { orderItemId }, orderBy: { createdAt: "desc" }, select: { id: true } })
    .catch(() => null);
  return t?.id ?? null;
}
