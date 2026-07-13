"use client";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Input, statusTone } from "@/components/ui";
import { DataTable, type Column } from "@/components/data-table";
import { api } from "@/lib/api";
import { useDebounced } from "@/lib/utils";

interface UserRow { id: string; telegramHandle: string | null; email: string | null; firstName: string | null; status: string; roles: string[] }

export default function UsersPage() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [searchRaw, setSearchRaw] = useState("");
  const search = useDebounced(searchRaw);
  const { data, isLoading } = useQuery({ queryKey: ["users", page, search], queryFn: () => api<UserRow[]>("/users", { query: { page, search: search || undefined } }) });

  const columns: Column<UserRow>[] = [
    { header: "Name", cell: (u) => u.firstName ?? "—" },
    { header: "Handle", cell: (u) => u.telegramHandle ? `@${u.telegramHandle}` : "—" },
    { header: "Email", cell: (u) => u.email ?? "—" },
    { header: "Roles", cell: (u) => <span className="text-xs text-slate-500">{u.roles.join(", ") || "CUSTOMER"}</span> },
    { header: "Status", cell: (u) => <Badge tone={statusTone(u.status)}>{u.status}</Badge> },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Users</h1>
      <div className="w-72"><Input placeholder="Search email / handle / name / telegram id" value={searchRaw} onChange={(e) => { setSearchRaw(e.target.value); setPage(1); }} /></div>
      <DataTable columns={columns} rows={data?.data ?? []} loading={isLoading} page={page} totalPages={data?.meta?.totalPages ?? 1} onPage={setPage} onRowClick={(u) => router.push(`/users/${u.id}`)} />
    </div>
  );
}
