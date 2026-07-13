"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Button, Input, Label, Select } from "@/components/ui";
import { Dialog } from "@/components/ui/dialog";
import { DataTable, type Column } from "@/components/data-table";
import { useToast } from "@/components/toast";
import { api, apiData } from "@/lib/api";
import { fromMinor, toMinor } from "@/lib/money";
import { errorMessage, formatDate } from "@/lib/utils";

interface Coupon {
  id: string; code: string; type: string; valueMinor: number | null; valuePct: number | null;
  currency: string | null; minCartMinor: number; isActive: boolean; expiresAt: string | null; usedCount: number; usageLimit: number | null;
}

export default function CouponsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: "", type: "PERCENTAGE", value: "", currency: "INR", minCart: "", expiresAt: "", usageLimit: "", perUserLimit: "1", firstPurchaseOnly: false, newUserOnly: false });

  const { data, isLoading } = useQuery({ queryKey: ["coupons", page], queryFn: () => api<Coupon[]>("/coupons", { query: { page } }) });

  const create = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        code: form.code.toUpperCase(),
        type: form.type,
        minCartMinor: toMinor(form.minCart || "0") ?? 0,
        perUserLimit: Number(form.perUserLimit) || 1,
        firstPurchaseOnly: form.firstPurchaseOnly,
        newUserOnly: form.newUserOnly,
      };
      if (form.type === "FIXED") { body.valueMinor = toMinor(form.value) ?? 0; body.currency = form.currency; }
      else body.valuePct = Math.round(Number(form.value) * 100);
      if (form.expiresAt) body.expiresAt = new Date(form.expiresAt).toISOString();
      if (form.usageLimit) body.usageLimit = Number(form.usageLimit);
      return apiData("/coupons", { method: "POST", body });
    },
    onSuccess: () => { toast("Coupon created"); setOpen(false); void qc.invalidateQueries({ queryKey: ["coupons"] }); },
    onError: (e) => toast(errorMessage(e), "error"),
  });

  const toggle = useMutation({
    mutationFn: (c: Coupon) => apiData(`/coupons/${c.id}`, { method: "PATCH", body: { isActive: !c.isActive } }),
    onSuccess: () => { toast("Updated"); void qc.invalidateQueries({ queryKey: ["coupons"] }); },
    onError: (e) => toast(errorMessage(e), "error"),
  });

  const columns: Column<Coupon>[] = [
    { header: "Code", cell: (c) => <span className="font-mono text-sm font-medium">{c.code}</span> },
    { header: "Value", cell: (c) => c.type === "FIXED" ? formatMinorSafe(c.valueMinor, c.currency) : `${(c.valuePct ?? 0) / 100}%` },
    { header: "Used", cell: (c) => `${c.usedCount}${c.usageLimit ? ` / ${c.usageLimit}` : ""}` },
    { header: "Expires", cell: (c) => formatDate(c.expiresAt) },
    { header: "Active", cell: (c) => <Badge tone={c.isActive ? "green" : "gray"}>{c.isActive ? "Active" : "Off"}</Badge> },
    { header: "", className: "text-right", cell: (c) => <Button variant="ghost" onClick={() => toggle.mutate(c)}>{c.isActive ? "Disable" : "Enable"}</Button> },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Coupons</h1>
        <Button onClick={() => setOpen(true)}>New coupon</Button>
      </div>
      <DataTable columns={columns} rows={data?.data ?? []} loading={isLoading} page={page} totalPages={data?.meta?.totalPages ?? 1} onPage={setPage} />

      <Dialog open={open} onClose={() => setOpen(false)} title="New coupon"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => create.mutate()} disabled={create.isPending || !form.code || !form.value}>Create</Button></>}>
        <div className="space-y-3">
          <div><Label>Code</Label><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Type</Label><Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}><option value="PERCENTAGE">Percentage</option><option value="FIXED">Fixed</option></Select></div>
            <div><Label>{form.type === "FIXED" ? "Amount" : "Percent"}</Label><Input value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} placeholder={form.type === "FIXED" ? "100.00" : "10"} /></div>
          </div>
          {form.type === "FIXED" ? <div><Label>Currency</Label><Select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}><option>INR</option><option>USD</option></Select></div> : null}
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Min cart</Label><Input value={form.minCart} onChange={(e) => setForm({ ...form, minCart: e.target.value })} placeholder="0" /></div>
            <div><Label>Usage limit</Label><Input value={form.usageLimit} onChange={(e) => setForm({ ...form, usageLimit: e.target.value })} placeholder="∞" /></div>
          </div>
          <div><Label>Expires at</Label><Input type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} /></div>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={form.firstPurchaseOnly} onChange={(e) => setForm({ ...form, firstPurchaseOnly: e.target.checked })} /> First purchase</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={form.newUserOnly} onChange={(e) => setForm({ ...form, newUserOnly: e.target.checked })} /> New users</label>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function formatMinorSafe(minor: number | null, currency: string | null): string {
  if (minor === null) return "—";
  return fromMinor(minor) + " " + (currency ?? "");
}
