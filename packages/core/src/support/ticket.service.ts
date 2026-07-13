import { nextTicketNumber, prisma, type TicketStatus } from "@gis/database";

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
