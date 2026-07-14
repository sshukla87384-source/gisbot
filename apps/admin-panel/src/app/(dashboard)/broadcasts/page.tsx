"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Button, Card, Input, Label, Select, Textarea, statusTone } from "@/components/ui";
import { useToast } from "@/components/toast";
import { apiData } from "@/lib/api";
import { errorMessage, formatDateTime } from "@/lib/utils";

interface Broadcast {
  id: string;
  title: string;
  body: string;
  status: string;
  imageUrl?: string | null;
  recurrence?: string;
  scheduledAt?: string | null;
  totalTargets: number;
  sentCount: number;
  createdAt: string;
}

const EMPTY = { title: "", body: "", segment: "all", imageUrl: "", buttonText: "", buttonUrl: "", pin: false, mode: "now", scheduledAt: "", recurrence: "none" };

export default function BroadcastsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState(EMPTY);
  const { data, isLoading } = useQuery({
    queryKey: ["broadcasts"],
    queryFn: () =>
      apiData<{ data?: Broadcast[] } | Broadcast[]>("/broadcasts").then((r) => (Array.isArray(r) ? r : r.data ?? [])),
  });

  const submit = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { title: form.title, body: form.body, segment: form.segment, pin: form.pin };
      if (form.imageUrl.trim()) body.imageUrl = form.imageUrl.trim();
      if (form.buttonText.trim() && form.buttonUrl.trim()) { body.buttonText = form.buttonText.trim(); body.buttonUrl = form.buttonUrl.trim(); }
      if (form.mode === "schedule") {
        if (!form.scheduledAt) throw new Error("Pick a date & time to schedule.");
        body.scheduledAt = new Date(form.scheduledAt).toISOString();
        body.recurrence = form.recurrence;
      }
      return apiData<{ scheduled: boolean; targets?: number }>("/broadcasts", { method: "POST", body });
    },
    onSuccess: (r) => {
      toast(r.scheduled ? "Broadcast scheduled ✅" : `Broadcast queued to ${r.targets} users`);
      setForm(EMPTY);
      void qc.invalidateQueries({ queryKey: ["broadcasts"] });
    },
    onError: (e) => toast(errorMessage(e), "error"),
  });

  const cancel = useMutation({
    mutationFn: (id: string) => apiData(`/broadcasts/${id}/cancel`, { method: "POST" }),
    onSuccess: () => { toast("Cancelled"); void qc.invalidateQueries({ queryKey: ["broadcasts"] }); },
    onError: (e) => toast(errorMessage(e), "error"),
  });

  const confirmText =
    form.mode === "schedule"
      ? "Schedule this broadcast?"
      : "Send this broadcast to the selected audience now?";

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Broadcasts</h1>
      <Card>
        <div className="space-y-3">
          <div><Label>Title (optional)</Label><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="🎉 Big sale today!" /></div>
          <div><Label>Message</Label><Textarea rows={4} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="Write your announcement…" /></div>
          <div><Label>Image URL (optional)</Label><Input value={form.imageUrl} onChange={(e) => setForm({ ...form, imageUrl: e.target.value })} placeholder="https://…/banner.jpg" /></div>
          {form.imageUrl.trim() ? <img src={form.imageUrl} alt="preview" className="max-h-40 rounded-lg border border-slate-200" /> : null}

          <div className="flex flex-wrap gap-4">
            <div className="w-56"><Label>Button text (optional)</Label><Input value={form.buttonText} onChange={(e) => setForm({ ...form, buttonText: e.target.value })} placeholder="🛍 Shop now" /></div>
            <div className="flex-1 min-w-[16rem]"><Label>Button link</Label><Input value={form.buttonUrl} onChange={(e) => setForm({ ...form, buttonUrl: e.target.value })} placeholder="https://t.me/YourBot?start=p_slug" /></div>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.checked })} /> 📌 Pin this message in each chat</label>

          <div className="flex flex-wrap gap-4">
            <div className="w-56"><Label>Audience</Label>
              <Select value={form.segment} onChange={(e) => setForm({ ...form, segment: e.target.value })}>
                <option value="all">All users</option>
                <option value="resellers">Resellers only</option>
              </Select>
            </div>
            <div className="w-56"><Label>When</Label>
              <Select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
                <option value="now">Send now</option>
                <option value="schedule">Schedule / auto-repeat</option>
              </Select>
            </div>
          </div>

          {form.mode === "schedule" ? (
            <div className="flex flex-wrap gap-4">
              <div className="w-64"><Label>Date &amp; time</Label><Input type="datetime-local" value={form.scheduledAt} onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })} /></div>
              <div className="w-56"><Label>Repeat</Label>
                <Select value={form.recurrence} onChange={(e) => setForm({ ...form, recurrence: e.target.value })}>
                  <option value="none">Once</option>
                  <option value="daily">Every day</option>
                  <option value="weekly">Every week</option>
                </Select>
              </div>
            </div>
          ) : null}

          <Button onClick={() => { if (confirm(confirmText)) submit.mutate(); }} disabled={submit.isPending || !form.body.trim()}>
            {submit.isPending ? "Working…" : form.mode === "schedule" ? "Schedule broadcast" : "Send broadcast"}
          </Button>
        </div>
      </Card>

      <h2 className="text-sm font-semibold text-slate-500">Recent &amp; scheduled</h2>
      {isLoading ? <p className="text-slate-400">Loading…</p> : (
        <div className="space-y-2">
          {(data ?? []).map((b) => (
            <Card key={b.id}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{b.title || "(no title)"}</p>
                  <p className="truncate text-sm text-slate-500">{b.body.slice(0, 80)}</p>
                  {b.scheduledAt ? <p className="text-xs text-slate-400">⏰ {formatDateTime(b.scheduledAt)}{b.recurrence && b.recurrence !== "none" ? ` · repeats ${b.recurrence}` : ""}</p> : null}
                </div>
                <div className="text-right">
                  <Badge tone={statusTone(b.status)}>{b.status}</Badge>
                  <p className="mt-1 text-xs text-slate-400">{b.sentCount}/{b.totalTargets} · {formatDateTime(b.createdAt)}</p>
                  {b.status === "SCHEDULED" ? <button onClick={() => { if (confirm("Cancel this scheduled broadcast?")) cancel.mutate(b.id); }} className="mt-1 text-xs text-red-500 hover:underline">Cancel</button> : null}
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
