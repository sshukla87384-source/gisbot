"use client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card, Input } from "@/components/ui";
import { DataTable, type Column } from "@/components/data-table";
import { api } from "@/lib/api";
import { formatDateTime, prettyJson, useDebounced } from "@/lib/utils";

interface Log { id: string; action: string; entityType: string; entityId: string | null; actorType: string; createdAt: string; before?: unknown; after?: unknown }

export default function AuditPage() {
  const [page, setPage] = useState(1);
  const [entityRaw, setEntityRaw] = useState("");
  const entity = useDebounced(entityRaw);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ["audit", page, entity], queryFn: () => api<Log[]>("/audit-logs", { query: { page, "filter[entityType]": entity || undefined } }) });

  const columns: Column<Log>[] = [
    { header: "Action", cell: (l) => <span className="font-mono text-xs">{l.action}</span> },
    { header: "Entity", cell: (l) => `${l.entityType}${l.entityId ? ` · ${l.entityId.slice(0, 8)}` : ""}` },
    { header: "Actor", cell: (l) => l.actorType },
    { header: "When", cell: (l) => <span className="text-slate-500">{formatDateTime(l.createdAt)}</span> },
    { header: "", className: "text-right", cell: (l) => <button className="text-xs text-sky-600 hover:underline" onClick={(e) => { e.stopPropagation(); setExpanded(expanded === l.id ? null : l.id); }}>{expanded === l.id ? "Hide" : "Details"}</button> },
  ];

  const rows = data?.data ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Audit logs</h1>
      <div className="w-64"><Input placeholder="Filter by entity type (e.g. Order)" value={entityRaw} onChange={(e) => { setEntityRaw(e.target.value); setPage(1); }} /></div>
      <DataTable columns={columns} rows={rows} loading={isLoading} page={page} totalPages={data?.meta?.totalPages ?? 1} onPage={setPage} />
      {expanded ? (() => {
        const log = rows.find((r) => r.id === expanded);
        if (!log) return null;
        return (
          <Card>
            <p className="mb-2 text-sm font-semibold">Detail · {log.action}</p>
            <div className="grid gap-3 md:grid-cols-2">
              <div><p className="mb-1 text-xs text-slate-500">Before</p><pre className="overflow-x-auto rounded-lg bg-slate-100 p-3 text-xs">{prettyJson(log.before)}</pre></div>
              <div><p className="mb-1 text-xs text-slate-500">After</p><pre className="overflow-x-auto rounded-lg bg-slate-100 p-3 text-xs">{prettyJson(log.after)}</pre></div>
            </div>
          </Card>
        );
      })() : null}
    </div>
  );
}
