"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, Select, Textarea, statusTone } from "@/components/ui";
import { useToast } from "@/components/toast";
import { apiData } from "@/lib/api";
import { cn, errorMessage, formatDateTime } from "@/lib/utils";

interface Message { id: string; authorType: string; body: string; createdAt: string }
interface Ticket { id: string; ticketNumber: string; subject: string; status: string; priority: string; messages: Message[]; user?: { telegramHandle?: string | null } }
const STATUSES = ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CLOSED"];
const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"];

export default function TicketDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const [reply, setReply] = useState("");
  const { data, isLoading } = useQuery({ queryKey: ["ticket", id], queryFn: () => apiData<Ticket>(`/tickets/${id}`) });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["ticket", id] });
  const send = useMutation({ mutationFn: () => apiData(`/tickets/${id}/messages`, { method: "POST", body: { body: reply } }), onSuccess: () => { toast("Reply sent"); setReply(""); invalidate(); }, onError: (e) => toast(errorMessage(e), "error") });
  const patch = useMutation({ mutationFn: (body: Record<string, string>) => apiData(`/tickets/${id}`, { method: "PATCH", body }), onSuccess: () => { toast("Updated"); invalidate(); }, onError: (e) => toast(errorMessage(e), "error") });

  if (isLoading || !data) return <p className="text-slate-400">Loading…</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-mono text-lg font-semibold">{data.ticketNumber}</h1>
          <p className="text-sm text-slate-500">{data.subject}</p>
        </div>
        <Badge tone={statusTone(data.status)}>{data.status}</Badge>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="w-48"><Select value={data.status} onChange={(e) => patch.mutate({ status: e.target.value })}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</Select></div>
        <div className="w-40"><Select value={data.priority} onChange={(e) => patch.mutate({ priority: e.target.value })}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</Select></div>
      </div>

      <Card>
        <div className="space-y-3">
          {data.messages.map((m) => (
            <div key={m.id} className={cn("flex", m.authorType === "ADMIN" ? "justify-end" : "justify-start")}>
              <div className={cn("max-w-[70%] rounded-2xl px-4 py-2 text-sm", m.authorType === "ADMIN" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-800")}>
                <p className="whitespace-pre-wrap">{m.body}</p>
                <p className={cn("mt-1 text-[10px]", m.authorType === "ADMIN" ? "text-slate-300" : "text-slate-400")}>{m.authorType} · {formatDateTime(m.createdAt)}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <Textarea rows={3} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Type a reply — sent to the customer in Telegram…" />
        <div className="mt-2 flex justify-end"><Button onClick={() => send.mutate()} disabled={send.isPending || !reply.trim()}>Send reply</Button></div>
      </Card>
    </div>
  );
}
