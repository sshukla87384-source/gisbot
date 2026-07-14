"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Button, Card, Input, Label } from "@/components/ui";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/toast";
import { apiData } from "@/lib/api";
import { errorMessage, slugify } from "@/lib/utils";

interface Category { id: string; name: string; slug: string; emoji: string | null; sortOrder: number; isActive: boolean }

export default function CategoriesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", slug: "", emoji: "", sortOrder: "0" });
  const { data, isLoading } = useQuery({ queryKey: ["categories"], queryFn: () => apiData<Category[]>("/categories") });

  const create = useMutation({
    mutationFn: () => apiData("/categories", { method: "POST", body: { name: form.name, slug: form.slug || slugify(form.name), emoji: form.emoji || undefined, sortOrder: Number(form.sortOrder) || 0 } }),
    onSuccess: () => { toast("Category created"); setOpen(false); setForm({ name: "", slug: "", emoji: "", sortOrder: "0" }); void qc.invalidateQueries({ queryKey: ["categories"] }); },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  const toggle = useMutation({
    mutationFn: (c: Category) => apiData(`/categories/${c.id}`, { method: "PATCH", body: { isActive: !c.isActive } }),
    onSuccess: () => { toast("Updated"); void qc.invalidateQueries({ queryKey: ["categories"] }); },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiData(`/categories/${id}`, { method: "DELETE" }),
    onSuccess: () => { toast("Deleted"); void qc.invalidateQueries({ queryKey: ["categories"] }); },
    onError: (e) => toast(errorMessage(e), "error"),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Categories</h1>
        <Button onClick={() => setOpen(true)}>New category</Button>
      </div>
      {isLoading ? <p className="text-slate-400">Loading…</p> : (
        <div className="grid gap-3 md:grid-cols-2">
          {(data ?? []).map((c) => (
            <Card key={c.id}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xl">{c.emoji ?? "📂"}</span>
                  <div>
                    <p className="font-medium">{c.name}</p>
                    <p className="text-xs text-slate-400">{c.slug} · order {c.sortOrder}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={c.isActive ? "green" : "gray"}>{c.isActive ? "Active" : "Off"}</Badge>
                  <Button variant="ghost" onClick={() => toggle.mutate(c)}>{c.isActive ? "Disable" : "Enable"}</Button>
                  <Button variant="ghost" onClick={() => { if (confirm(`Delete ${c.name}?`)) remove.mutate(c.id); }}>🗑</Button>
                </div>
              </div>
            </Card>
          ))}
          {(data ?? []).length === 0 ? <p className="text-sm text-slate-400">No categories yet.</p> : null}
        </div>
      )}

      <Dialog open={open} onClose={() => setOpen(false)} title="New category"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => create.mutate()} disabled={create.isPending || !form.name}>Create</Button></>}>
        <div className="space-y-3">
          <div><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value, slug: slugify(e.target.value) })} placeholder="Streaming" /></div>
          <div><Label>Slug</Label><Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="streaming" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Emoji</Label><Input value={form.emoji} onChange={(e) => setForm({ ...form, emoji: e.target.value })} placeholder="📺" /></div>
            <div><Label>Sort order</Label><Input value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: e.target.value })} /></div>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
