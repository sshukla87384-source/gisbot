"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Input, Label, Select, Textarea, statusTone } from "@/components/ui";
import { Dialog } from "@/components/ui/dialog";
import { DataTable, type Column } from "@/components/data-table";
import { useToast } from "@/components/toast";
import { api, apiData } from "@/lib/api";
import { errorMessage, slugify } from "@/lib/utils";

interface Product { id: string; name: string; type: string; status: string; category?: { name: string }; _count?: { variants: number } }
interface Category { id: string; name: string }
const TYPES = ["LICENSE_KEY", "DIGITAL_ACCOUNT", "SUBSCRIPTION", "DOWNLOAD", "MANUAL_SERVICE"];

export default function ProductsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", slug: "", type: "LICENSE_KEY", categoryId: "", fulfillmentMode: "AUTOMATIC", description: "", isFeatured: false });

  const { data, isLoading } = useQuery({ queryKey: ["products", page], queryFn: () => api<Product[]>("/products", { query: { page } }) });
  const { data: cats } = useQuery({ queryKey: ["categories"], queryFn: () => apiData<Category[]>("/categories") });

  const create = useMutation({
    mutationFn: () => apiData<Product>("/products", { method: "POST", body: { ...form, slug: form.slug || slugify(form.name) } }),
    onSuccess: (p) => { toast("Product created"); setOpen(false); void qc.invalidateQueries({ queryKey: ["products"] }); router.push(`/products/${p.id}`); },
    onError: (e) => toast(errorMessage(e), "error"),
  });

  const columns: Column<Product>[] = [
    { header: "Name", cell: (p) => <span className="font-medium">{p.name}</span> },
    { header: "Type", cell: (p) => <span className="text-slate-500">{p.type}</span> },
    { header: "Category", cell: (p) => p.category?.name ?? "—" },
    { header: "Variants", cell: (p) => p._count?.variants ?? 0 },
    { header: "Status", cell: (p) => <Badge tone={statusTone(p.status)}>{p.status}</Badge> },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Products</h1>
        <Button onClick={() => setOpen(true)}>New product</Button>
      </div>
      <DataTable columns={columns} rows={data?.data ?? []} loading={isLoading} page={page} totalPages={data?.meta?.totalPages ?? 1} onPage={setPage} onRowClick={(p) => router.push(`/products/${p.id}`)} />

      <Dialog open={open} onClose={() => setOpen(false)} title="New product"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => create.mutate()} disabled={create.isPending || !form.name || !form.categoryId}>Create</Button></>}>
        <div className="space-y-3">
          <div><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value, slug: slugify(e.target.value) })} /></div>
          <div><Label>Slug</Label><Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} /></div>
          <div><Label>Type</Label><Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{TYPES.map((t) => <option key={t}>{t}</option>)}</Select></div>
          <div><Label>Category</Label><Select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}><option value="">Select…</option>{(cats ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></div>
          <div><Label>Fulfillment</Label><Select value={form.fulfillmentMode} onChange={(e) => setForm({ ...form, fulfillmentMode: e.target.value })}><option>AUTOMATIC</option><option>MANUAL</option></Select></div>
          <div><Label>Description</Label><Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isFeatured} onChange={(e) => setForm({ ...form, isFeatured: e.target.checked })} /> Featured</label>
        </div>
      </Dialog>
    </div>
  );
}
