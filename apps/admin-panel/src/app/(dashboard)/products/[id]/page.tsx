"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button, Card, Input, Label, Select, Textarea } from "@/components/ui";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/toast";
import { apiData, uploadFile } from "@/lib/api";
import { fromMinor, toMinor } from "@/lib/money";
import { errorMessage } from "@/lib/utils";

interface Price { currency: string; amountMinor: number; tier?: { name: string } }
interface Variant { id: string; name: string; sku: string; isActive: boolean; prices: Price[] }
interface Product {
  id: string; name: string; description: string | null; status: string; fulfillmentMode: string;
  imageUrl: string | null; iconEmoji: string | null;
  salePercentBp: number | null; saleStartsAt: string | null; saleEndsAt: string | null;
  variants: Variant[];
}
const STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"];

// datetime-local <-> ISO helpers
const toLocal = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16) : "");
const toIso = (local: string) => (local ? new Date(local).toISOString() : "");

export default function ProductDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const { data, isLoading } = useQuery({ queryKey: ["product", id], queryFn: () => apiData<Product>(`/products/${id}`) });

  const [fields, setFields] = useState({
    name: "", description: "", status: "DRAFT", fulfillmentMode: "AUTOMATIC",
    imageUrl: "", iconEmoji: "", salePercent: "", saleStartsAt: "", saleEndsAt: "",
  });
  useEffect(() => {
    if (data) setFields({
      name: data.name, description: data.description ?? "", status: data.status, fulfillmentMode: data.fulfillmentMode,
      imageUrl: data.imageUrl ?? "", iconEmoji: data.iconEmoji ?? "",
      salePercent: data.salePercentBp ? String(data.salePercentBp / 100) : "",
      saleStartsAt: toLocal(data.saleStartsAt), saleEndsAt: toLocal(data.saleEndsAt),
    });
  }, [data]);

  const save = useMutation({
    mutationFn: () => {
      const pct = fields.salePercent.trim() === "" ? undefined : Math.round(parseFloat(fields.salePercent) * 100);
      const body: Record<string, unknown> = {
        name: fields.name, description: fields.description, status: fields.status,
        fulfillmentMode: fields.fulfillmentMode, imageUrl: fields.imageUrl, iconEmoji: fields.iconEmoji,
        salePercentBp: Number.isFinite(pct) ? pct : 0,
        saleStartsAt: toIso(fields.saleStartsAt), saleEndsAt: toIso(fields.saleEndsAt),
      };
      return apiData(`/products/${id}`, { method: "PATCH", body });
    },
    onSuccess: () => { toast("Saved"); void qc.invalidateQueries({ queryKey: ["product", id] }); },
    onError: (e) => toast(errorMessage(e), "error"),
  });

  const upload = useMutation({
    mutationFn: (file: File) => uploadFile<{ url: string }>("/media/upload", file),
    onSuccess: (r) => { setFields((f) => ({ ...f, imageUrl: r.url })); toast("Image uploaded — click Save to keep it"); },
    onError: (e) => toast(errorMessage(e), "error"),
  });

  const announce = useMutation({
    mutationFn: (pin: boolean) => apiData<{ targets?: number }>(`/products/${id}/announce`, { method: "POST", body: { pin } }),
    onSuccess: (r) => toast(`Announced to ${r.targets ?? 0} users`),
    onError: (e) => toast(errorMessage(e), "error"),
  });

  if (isLoading || !data) return <p className="text-slate-400">Loading…</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">{data.iconEmoji ? `${data.iconEmoji} ` : ""}{data.name}</h1>

      <Card>
        <div className="grid gap-3 md:grid-cols-2">
          <div><Label>Name</Label><Input value={fields.name} onChange={(e) => setFields({ ...fields, name: e.target.value })} /></div>
          <div><Label>Icon / emoji</Label><Input value={fields.iconEmoji} onChange={(e) => setFields({ ...fields, iconEmoji: e.target.value })} placeholder="🎮 🔑 📺" /></div>
          <div><Label>Status</Label><Select value={fields.status} onChange={(e) => setFields({ ...fields, status: e.target.value })}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</Select></div>
          <div><Label>Fulfillment</Label><Select value={fields.fulfillmentMode} onChange={(e) => setFields({ ...fields, fulfillmentMode: e.target.value })}><option>AUTOMATIC</option><option>MANUAL</option></Select></div>
          <div className="md:col-span-2"><Label>Description</Label><Textarea rows={3} value={fields.description} onChange={(e) => setFields({ ...fields, description: e.target.value })} /></div>

          <div className="md:col-span-2">
            <Label>Product image</Label>
            <div className="flex items-center gap-2">
              <Input value={fields.imageUrl} onChange={(e) => setFields({ ...fields, imageUrl: e.target.value })} placeholder="Upload or paste an image URL" />
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); }} />
              <Button variant="secondary" onClick={() => fileRef.current?.click()} disabled={upload.isPending}>{upload.isPending ? "Uploading…" : "Upload"}</Button>
            </div>
          </div>
          {fields.imageUrl.trim() ? <div className="md:col-span-2"><img src={fields.imageUrl} alt="preview" className="max-h-44 rounded-lg border border-slate-200" /></div> : null}
        </div>
        <div className="mt-3 flex gap-2">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>
          <Button variant="secondary" onClick={() => { if (data.status !== "ACTIVE") { toast("Set status ACTIVE and Save first", "error"); return; } if (confirm("Announce this product to all bot users?")) announce.mutate(false); }} disabled={announce.isPending}>📣 Announce now</Button>
          <Button variant="secondary" onClick={() => { if (data.status !== "ACTIVE") { toast("Set status ACTIVE and Save first", "error"); return; } if (confirm("Announce AND pin the post in every chat?")) announce.mutate(true); }} disabled={announce.isPending}>📌 Announce &amp; pin</Button>
        </div>
      </Card>

      <Card>
        <div className="mb-2 text-sm font-semibold">🔥 Flash sale</div>
        <div className="grid gap-3 md:grid-cols-3">
          <div><Label>Discount %</Label><Input value={fields.salePercent} onChange={(e) => setFields({ ...fields, salePercent: e.target.value })} placeholder="e.g. 20" /></div>
          <div><Label>Starts (optional)</Label><Input type="datetime-local" value={fields.saleStartsAt} onChange={(e) => setFields({ ...fields, saleStartsAt: e.target.value })} /></div>
          <div><Label>Ends (optional)</Label><Input type="datetime-local" value={fields.saleEndsAt} onChange={(e) => setFields({ ...fields, saleEndsAt: e.target.value })} /></div>
        </div>
        <p className="mt-2 text-xs text-slate-400">Leave discount blank (or 0) for no sale. The bot shows a struck-through price + countdown; checkout charges the discounted price automatically. Click Save to apply.</p>
      </Card>

      <VariantsCard data={data} id={id} />
    </div>
  );
}

function VariantsCard({ data, id }: { data: Product; id: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [variantOpen, setVariantOpen] = useState(false);
  const [variant, setVariant] = useState({ name: "", sku: "" });
  const addVariant = useMutation({
    mutationFn: () => apiData(`/products/${id}/variants`, { method: "POST", body: variant }),
    onSuccess: () => { toast("Variant added"); setVariantOpen(false); setVariant({ name: "", sku: "" }); void qc.invalidateQueries({ queryKey: ["product", id] }); },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  return (
    <>
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
    </>
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
