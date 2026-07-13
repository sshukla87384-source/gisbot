"use client";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Input, statusTone } from "@/components/ui";
import { DataTable, type Column } from "@/components/data-table";
import { api } from "@/lib/api";
import { formatMinor } from "@/lib/money";
import { formatDateTime, useDebounced } from "@/lib/utils";

interface Order {
  id: string;
  orderNumber: string;
  status: string;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  createdAt: string;
  user?: { telegramHandle?: string | null; firstName?: string | null };
}
const STATUSES = ["", "PENDING_PAYMENT", "PAID", "PENDING_FULFILLMENT", "AWAITING_STOCK", "MANUAL_REVIEW", "COMPLETED", "REFUNDED", "CANCELLED", "EXPIRED"];

export default function OrdersPage() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [searchRaw, setSearchRaw] = useState("");
  const search = useDebounced(searchRaw);

  const { data, isLoading } = useQuery({
    queryKey: ["orders", page, status, search],
    queryFn: () => api<Order[]>("/orders", { query: { page, "filter[status]": status || undefined, search: search || undefined } }),
  });

  const columns: Column<Order>[] = [
    { header: "Order", cell: (o) => <span className="font-mono text-xs">{o.orderNumber}</span> },
    { header: "Customer", cell: (o) => o.user?.telegramHandle ? `@${o.user.telegramHandle}` : (o.user?.firstName ?? "—") },
    { header: "Total", cell: (o) => formatMinor(o.subtotalMinor - o.discountMinor, o.currency) },
    { header: "Status", cell: (o) => <Badge tone={statusTone(o.status)}>{o.status}</Badge> },
    { header: "Created", cell: (o) => <span className="text-slate-500">{formatDateTime(o.createdAt)}</span> },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Orders</h1>
      <div className="flex flex-wrap gap-3">
        <div className="w-64"><Input placeholder="Search order number…" value={searchRaw} onChange={(e) => { setSearchRaw(e.target.value); setPage(1); }} /></div>
        <div className="flex flex-wrap gap-1">
          {STATUSES.map((s) => (
            <button
              key={s || "all"}
              onClick={() => { setStatus(s); setPage(1); }}
              className={`rounded-full px-3 py-1 text-xs ${status === s ? "bg-slate-900 text-white" : "bg-white text-slate-600 border border-slate-300"}`}
            >
              {s || "All"}
            </button>
          ))}
        </div>
      </div>
      <DataTable
        columns={columns}
        rows={data?.data ?? []}
        loading={isLoading}
        page={page}
        totalPages={data?.meta?.totalPages ?? 1}
        onPage={setPage}
        onRowClick={(o) => router.push(`/orders/${o.id}`)}
      />
    </div>
  );
}
