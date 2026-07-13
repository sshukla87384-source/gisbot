"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Button, statusTone } from "@/components/ui";
import { DataTable, type Column } from "@/components/data-table";
import { useToast } from "@/components/toast";
import { api, apiData } from "@/lib/api";
import { formatMinor } from "@/lib/money";
import { errorMessage } from "@/lib/utils";

interface Withdrawal { id: string; amountMinor: string; currency: string; method: string; status: string; user?: { telegramHandle?: string | null; email?: string | null } }
const TABS = ["PENDING", "APPROVED", "PROCESSED", "REJECTED"];

export default function WithdrawalsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState("PENDING");
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({ queryKey: ["withdrawals", tab, page], queryFn: () => api<Withdrawal[]>("/withdrawals", { query: { "filter[status]": tab, page } }) });

  const act = useMutation({
    mutationFn: ({ id, action, note }: { id: string; action: string; note?: string }) => apiData(`/withdrawals/${id}/${action}`, { method: "POST", body: note ? { note } : undefined }),
    onSuccess: () => { toast("Updated"); void qc.invalidateQueries({ queryKey: ["withdrawals"] }); },
    onError: (e) => toast(errorMessage(e), "error"),
  });

  const columns: Column<Withdrawal>[] = [
    { header: "User", cell: (w) => w.user?.telegramHandle ? `@${w.user.telegramHandle}` : (w.user?.email ?? "—") },
    { header: "Amount", cell: (w) => formatMinor(Number(w.amountMinor), w.currency) },
    { header: "Method", cell: (w) => w.method },
    { header: "Status", cell: (w) => <Badge tone={statusTone(w.status)}>{w.status}</Badge> },
    { header: "", className: "text-right", cell: (w) => (
      <div className="flex justify-end gap-2">
        {w.status === "PENDING" ? <>
          <Button variant="secondary" onClick={() => act.mutate({ id: w.id, action: "approve" })}>Approve</Button>
          <Button variant="danger" onClick={() => act.mutate({ id: w.id, action: "reject", note: "Rejected by admin" })}>Reject</Button>
        </> : w.status === "APPROVED" ? (
          <Button variant="secondary" onClick={() => act.mutate({ id: w.id, action: "mark-processed" })}>Mark processed</Button>
        ) : null}
      </div>
    ) },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Withdrawals</h1>
      <div className="flex gap-1">
        {TABS.map((t) => (
          <button key={t} onClick={() => { setTab(t); setPage(1); }} className={`rounded-full px-3 py-1 text-xs ${tab === t ? "bg-slate-900 text-white" : "bg-white text-slate-600 border border-slate-300"}`}>{t}</button>
        ))}
      </div>
      <DataTable columns={columns} rows={data?.data ?? []} loading={isLoading} page={page} totalPages={data?.meta?.totalPages ?? 1} onPage={setPage} />
    </div>
  );
}
