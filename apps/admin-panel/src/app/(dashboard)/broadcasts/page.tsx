"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Button, Card, Input, Label, Select, Textarea, statusTone } from "@/components/ui";
import { useToast } from "@/components/toast";
import { apiData } from "@/lib/api";
import { errorMessage, formatDateTime } from "@/lib/utils";

interface Broadcast { id: string; title: string; body: string; status: string; totalTargets: number; sentCount: number; createdAt: string }

export default function BroadcastsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ title: "", body: "", segment: "all" });
  const { data, isLoading } = useQuery({ queryKey: ["broadcasts"], queryFn: () => apiData<{ data?: Broadcast[] } | Broadcast[]>("/broadcasts").then((r) => (Array.isArray(r) ? r : r.data ?? [])) });

  const send = useMutation({
    mutationFn: () => apiData<{ targets: number }>("/broadcasts", { method: "POST", body: form }),
    onSuccess: (r) => { toast(`Broadcast queued to ${r.targets} users`); setForm({ title: "", body: "", segment: "all" }); void qc.invalidateQueries({ queryKey: ["broadcasts"] }); },
    onError: (e) => toast(errorMessage(e), "error"),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Broadcasts</h1>
      <Card>
        <div className="space-y-3">
          <div><Label>Title (optional)</Label><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="🎉 Big sale today!" /></div>
          <div><Label>Message</Label><Textarea rows={4} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="Write your announcement…" /></div>
          <div className="w-56"><Label>Audience</Label>
            <Select value={form.segment} onChange={(e) => setForm({ ...form, segment: e.target.value })}>
              <option value="all">All users</option>
              <option value="customers">All users (customers)</option>
              <option value="resellers">Resellers only</option>
            </Select>
          </div>
          <Button onClick={() => { if (confirm("Send this broadcast to the selected audience?")) send.mutate(); }} disabled={send.isPending || !form.body.trim()}>
            {send.isPending ? "Sending…" : "Send broadcast"}
          </Button>
        </div>
      </Card>

      <h2 className="text-sm font-semibold text-slate-500">Recent broadcasts</h2>
      {isLoading ? <p className="text-slate-400">Loading…</p> : (
        <div className="space-y-2">
          {(data ?? []).map((b) => (
            <Card key={b.id}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">{b.title || "(no title)"}</p>
                  <p className="text-sm text-slate-500">{b.body.slice(0, 80)}</p>
                </div>
                <div className="text-right">
                  <Badge tone={statusTone(b.status)}>{b.status}</Badge>
                  <p className="mt-1 text-xs text-slate-400">{b.sentCount}/{b.totalTargets} · {formatDateTime(b.createdAt)}</p>
                </div>
              </div>
            </Card>
          ))}
          {(data ?? []).length === 0 ? <p className="text-sm text-slate-400">No broadcasts yet.</p> : null}
        </div>
      )}
    </div>
  );
}
