"use client";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, statusTone } from "@/components/ui";
import { DataTable, type Column } from "@/components/data-table";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";

interface Ticket { id: string; ticketNumber: string; subject: string; category: string; priority: string; status: string; createdAt: string; user?: { telegramHandle?: string | null; firstName?: string | null } }
const TABS = ["", "OPEN", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CLOSED"];

export default function TicketsPage() {
  const router = useRouter();
  const [tab, setTab] = useState("");
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({ queryKey: ["tickets", tab, page], queryFn: () => api<Ticket[]>("/tickets", { query: { "filter[status]": tab || undefined, page } }) });

  const columns: Column<Ticket>[] = [
    { header: "Ticket", cell: (t) => <span className="font-mono text-xs">{t.ticketNumber}</span> },
    { header: "Subject", cell: (t) => t.subject },
    { header: "Customer", cell: (t) => t.user?.telegramHandle ? `@${t.user.telegramHandle}` : (t.user?.firstName ?? "—") },
    { header: "Priority", cell: (t) => <Badge tone={statusTone(t.priority)}>{t.priority}</Badge> },
    { header: "Status", cell: (t) => <Badge tone={statusTone(t.status)}>{t.status}</Badge> },
    { header: "Created", cell: (t) => <span className="text-slate-500">{formatDateTime(t.createdAt)}</span> },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Support tickets</h1>
      <div className="flex gap-1">
        {TABS.map((t) => <button key={t || "all"} onClick={() => { setTab(t); setPage(1); }} className={`rounded-full px-3 py-1 text-xs ${tab === t ? "bg-slate-900 text-white" : "bg-white text-slate-600 border border-slate-300"}`}>{t || "All"}</button>)}
      </div>
      <DataTable columns={columns} rows={data?.data ?? []} loading={isLoading} page={page} totalPages={data?.meta?.totalPages ?? 1} onPage={setPage} onRowClick={(t) => router.push(`/tickets/${t.id}`)} />
    </div>
  );
}
