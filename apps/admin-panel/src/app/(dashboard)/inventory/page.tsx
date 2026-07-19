"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Button, Card, Label, Select, Textarea, statusTone } from "@/components/ui";
import { Dialog } from "@/components/ui/dialog";
import { DataTable, type Column } from "@/components/data-table";
import { useToast } from "@/components/toast";
import { api, apiData } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

interface Product { id: string; name: string }
interface ProductDetail { id: string; variants: Array<{ id: string; name: string }> }
interface KeyRow { id: string; status: string; maskedKey: string; supplier?: string | null }

export default function InventoryPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [productId, setProductId] = useState("");
  const [variantId, setVariantId] = useState("");
  const [page, setPage] = useState(1);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [reveal, setReveal] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  const { data: products } = useQuery({ queryKey: ["inv-products"], queryFn: () => api<Product[]>("/products", { query: { perPage: 100 } }) });
  const { data: detail } = useQuery({ enabled: !!productId, queryKey: ["inv-detail", productId], queryFn: () => apiData<ProductDetail>(`/products/${productId}`) });
  const { data: keys, isLoading } = useQuery({
    enabled: !!variantId,
    queryKey: ["inv-keys", variantId, page],
    queryFn: () => api<KeyRow[]>("/inventory/keys", { query: { "filter[variantId]": variantId, page } }),
  });

  const importKeys = useMutation({
    mutationFn: () => {
      const list = importText.split("\n").map((s) => s.trim()).filter(Boolean);
      return apiData<{ inserted: number; duplicates: number }>("/inventory/keys", { method: "POST", body: { variantId, keys: list } });
    },
    onSuccess: (r) => { toast(`Imported ${r.inserted} (${r.duplicates} duplicates)`); setImportOpen(false); setImportText(""); void qc.invalidateQueries({ queryKey: ["inv-keys"] }); },
    onError: (e) => toast(errorMessage(e), "error"),
  });

  const revealKey = useMutation({
    mutationFn: (kid: string) => apiData<{ key: string }>(`/inventory/keys/${kid}/reveal`, { method: "POST" }),
    onSuccess: (r) => setReveal(r.key),
    onError: (e) => toast(errorMessage(e), "error"),
  });

  const deleteKeys = useMutation({
    mutationFn: (ids: string[]) => apiData<{ deleted: number }>("/inventory/keys/delete", { method: "POST", body: { ids } }),
    onSuccess: (r) => { toast(`Deleted ${r.deleted} key(s)`); setSelected([]); void qc.invalidateQueries({ queryKey: ["inv-keys"] }); },
    onError: (e) => toast(errorMessage(e), "error"),
  });

  const toggleSel = (id: string) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const canDelete = (status: string) => status === "AVAILABLE" || status === "DISABLED";

  const columns: Column<KeyRow>[] = [
    { header: "", cell: (k) => canDelete(k.status)
        ? <input type="checkbox" checked={selected.includes(k.id)} onChange={() => toggleSel(k.id)} />
        : <span className="text-slate-300">—</span> },
    { header: "Key", cell: (k) => <span className="font-mono text-xs">{k.maskedKey}</span> },
    { header: "Status", cell: (k) => <Badge tone={statusTone(k.status)}>{k.status}</Badge> },
    { header: "Supplier", cell: (k) => k.supplier ?? "—" },
    { header: "", className: "text-right", cell: (k) => (
      <span className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => revealKey.mutate(k.id)}>Reveal</Button>
        {canDelete(k.status) ? <button onClick={() => { if (confirm("Delete this key permanently?")) deleteKeys.mutate([k.id]); }} className="text-xs text-red-500 hover:underline">Delete</button> : null}
      </span>
    ) },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Inventory</h1>
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-64"><Label>Product</Label>
            <Select value={productId} onChange={(e) => { setProductId(e.target.value); setVariantId(""); setPage(1); }}>
              <option value="">Select…</option>
              {(products?.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </div>
          <div className="w-64"><Label>Variant</Label>
            <Select value={variantId} onChange={(e) => { setVariantId(e.target.value); setPage(1); }} disabled={!detail}>
              <option value="">Select…</option>
              {(detail?.variants ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </Select>
          </div>
          <Button onClick={() => setImportOpen(true)} disabled={!variantId}>Import keys</Button>
        </div>
      </Card>

      {variantId && selected.length > 0 ? (
        <Card>
          <div className="flex items-center justify-between">
            <span className="text-sm">{selected.length} selected</span>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setSelected([])}>Clear</Button>
              <button onClick={() => { if (confirm(`Delete ${selected.length} selected key(s) permanently?`)) deleteKeys.mutate(selected); }} className="rounded-lg bg-red-500 px-3 py-2 text-sm font-medium text-white hover:bg-red-600">🗑 Delete selected</button>
            </div>
          </div>
        </Card>
      ) : null}

      {variantId ? (
        <DataTable columns={columns} rows={keys?.data ?? []} loading={isLoading} page={page} totalPages={keys?.meta?.totalPages ?? 1} onPage={setPage} empty="No keys for this variant." />
      ) : <Card><p className="text-sm text-slate-400">Choose a product and variant to view stock.</p></Card>}

      <Dialog open={importOpen} onClose={() => setImportOpen(false)} title="Import license keys"
        footer={<><Button variant="secondary" onClick={() => setImportOpen(false)}>Cancel</Button><Button onClick={() => importKeys.mutate()} disabled={importKeys.isPending || !importText.trim()}>Import</Button></>}>
        <Label>One key per line</Label>
        <Textarea rows={10} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder={"KEY-1111-...\nKEY-2222-..."} />
      </Dialog>

      <Dialog open={reveal !== null} onClose={() => setReveal(null)} title="Decrypted key (audited)"
        footer={<Button onClick={() => setReveal(null)}>Close</Button>}>
        <p className="mb-2 text-xs text-amber-600">This reveal has been recorded in the audit log.</p>
        <code className="block break-all rounded-lg bg-slate-100 p-3 text-sm">{reveal}</code>
      </Dialog>
    </div>
  );
}
