"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, Card, Input, Label, Select, Textarea } from "@/components/ui";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/toast";
import { apiData } from "@/lib/api";
import { fromMinor, toMinor } from "@/lib/money";
import { errorMessage } from "@/lib/utils";

interface Price { currency: string; amountMinor: number; tier?: { name: string } }
interface Variant { id: string; name: string; sku: string; isActive: boolean; prices: Price[] }
interface Product { id: string; name: string; description: string | null; status: string; fulfillmentMode: string; imageUrl: string | null; variants: Variant[] }
const STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"];

export default function ProductDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ["product", id], queryFn: () => apiData<Product>(`/products/${id}`) });

  const [fields, setFields] = useState({ name: "", description: "", status: "DRAFT", fulfillmentMode: "AUTOMATIC", imageUrl: "" });
  useEffect(() => { if (data) setFields({ name: data.name, description: data.description ?? "", status: data.status, fulfillmentMode: data.fulfillmentMode, imageUrl: data.imageUrl ?? "" }); }, [data]);

  const save = useMutation({
    mutationFn: () => apiData(`/products/${id}`, { method: "PATCH", body: fields }),
    onSuccess: () => { toast("Saved"); void qc.invalidateQueries({ queryKey: ["product", id] }); },
    onError: (e) => toast(errorMessage(e), "error"),
  });

  const [variantOpen, setVariantOpen] = useState(false);
  const [variant, setVariant] = useState({ name: "", sku: "" });
  const addVariant = useMutation({
    mutationFn: () => apiData(`/products/${id}/variants`, { method: "POST", body: variant }),
    onSuccess: () => { toast("Variant added"); setVariantOpen(false); setVariant({ name: "", sku: "" }); void qc.invalidateQueries({ queryKey: ["product", id] }); },
    onError: (e) => toast(errorMessage(e), "error"),
  });

  if (isLoading || !data) return <p className="text-slate-400">Loading…</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">{data.name}</h1>

      <Card>
        <div className="grid gap-3 md:grid-cols-2">
          <div><Label>Name</Label><Input value={fields.name} onChange={(e) => setFields({ ...fields, name: e.target.value })} /></div>
          <div><Label>Status</Label><Select value={fields.status} onChange={(e) => setFields({ ...fields, status: e.target.value })}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</Select></div>
          <div><Label>Fulfillment</Label><Select value={fields.fulfillmentMode} onChange={(e) => setFields({ ...fields, fulfillmentMode: e.target.value })}><option>AUTOMATIC</option><option>MANUAL</option></Select></div>
          <div className="md:col-span-2"><Label>Description</Label><Textarea rows={3} value={fields.description} onChange={(e) => setFields({ ...fields, description: e.target.value })} /></div>
          <div className="md:col-span-2"><Label>Image URL</Label><Input value={fields.imageUrl} onChange={(e) => setFields({ ...fields, imageUrl: e.target.value })} placeholder="https://…/product.jpg" /></div>
          {fields.imageUrl.trim() ? <div className="md:col-span-2"><img src={fields.imageUrl} alt="preview" className="max-h-44 rounded-lg border border-slate-200" /></div> : null}
        </div>
        <div className="mt-3"><Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button></div>
      </Card>

      <Card className="p-0">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <span className="text-sm font-semibold">Variants</span>
          <Button variant="secondary" onClick={() => setVariantOpen(true)}>Add variant</Button>
        </div>
        {data.variants.length === 0 ? <p className="px-4 py-6 text-sm text-slate-400">No variants yet.</p> : (
          <div className="divide-y divide-slate-100">
            {data.variants.map((v) => <VariantRow key={v.id} variant={v} productId={id} />)}
          </div>
        )}
      </Card>

      <Dialog open={variantOpen} onClose={() => setVariantOpen(false)} title="Add variant"
        footer={<><Button variant="secondary" onClick={() => setVariantOpen(false)}>Cancel</Button><Button onClick={() => addVariant.mutate()} disabled={addVariant.isPending || !variant.name || !variant.sku}>Add</Button></>}>
        <div className="space-y-3">
          <div><Label>Name</Label><Input value={variant.name} onChange={(e) => setVariant({ ...variant, name: e.target.value })} placeholder="e.g. 1 Month" /></div>
          <div><Label>SKU</Label><Input value={variant.sku} onChange={(e) => setVariant({ ...variant, sku: e.target.value })} placeholder="unique code" /></div>
        </div>
      </Dialog>
    </div>
  );
}

function VariantRow({ variant, productId }: { variant: Variant; productId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const inr = variant.prices.find((p) => p.currency === "INR")?.amountMinor ?? null;
  const usd = variant.prices.find((p) => p.currency === "USD")?.amountMinor ?? null;
  const [priceInr, setPriceInr] = useState(fromMinor(inr));
  const [priceUsd, setPriceUsd] = useState(fromMinor(usd));

  const savePrices = useMutation({
    mutationFn: () => {
      const prices: Array<{ tierName: string; currency: string; amountMinor: number }> = [];
      const i = toMinor(priceInr); const u = toMinor(priceUsd);
      if (i !== null && priceInr !== "") prices.push({ tierName: "RETAIL", currency: "INR", amountMinor: i });
      if (u !== null && priceUsd !== "") prices.push({ tierName: "RETAIL", currency: "USD", amountMinor: u });
      return apiData(`/variants/${variant.id}/prices`, { method: "PUT", body: { prices } });
    },
    onSuccess: () => { toast("Prices saved"); void qc.invalidateQueries({ queryKey: ["product", productId] }); },
    onError: (e) => toast(errorMessage(e), "error"),
  });

  return (
    <div className="flex flex-wrap items-end gap-3 px-4 py-3">
      <div className="min-w-[8rem]"><p className="text-sm font-medium">{variant.name}</p><p className="text-xs text-slate-400">{variant.sku}</p></div>
      <div className="w-28"><Label>INR (₹)</Label><Input value={priceInr} onChange={(e) => setPriceInr(e.target.value)} /></div>
      <div className="w-28"><Label>USD ($)</Label><Input value={priceUsd} onChange={(e) => setPriceUsd(e.target.value)} /></div>
      <Button variant="secondary" onClick={() => savePrices.mutate()} disabled={savePrices.isPending}>Save prices</Button>
    </div>
  );
}
