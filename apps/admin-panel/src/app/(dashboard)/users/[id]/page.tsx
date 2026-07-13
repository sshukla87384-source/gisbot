"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, Input, Label, Select, statusTone } from "@/components/ui";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/toast";
import { apiData } from "@/lib/api";
import { formatMinor, toMinor } from "@/lib/money";
import { errorMessage } from "@/lib/utils";

interface UserDetail {
  id: string; telegramHandle: string | null; email: string | null; firstName: string | null; lastName: string | null;
  status: string; currency: string; roles: string[];
  wallet: { balanceMinor: string; currency: string } | null;
  stats: { orderCount: number; ticketCount: number; referralCount: number };
}
const ASSIGNABLE = ["ADMIN", "SUPPORT", "FINANCE", "RESELLER"];

export default function UserDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ["user", id], queryFn: () => apiData<UserDetail>(`/users/${id}`) });

  const [adjustOpen, setAdjustOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [sign, setSign] = useState<"credit" | "debit">("credit");
  const [note, setNote] = useState("");
  const [role, setRole] = useState("ADMIN");

  const invalidate = () => qc.invalidateQueries({ queryKey: ["user", id] });
  const wrap = (fn: () => Promise<unknown>, ok: string) => async () => {
    try { await fn(); toast(ok); invalidate(); } catch (e) { toast(errorMessage(e), "error"); }
  };

  const setStatus = useMutation({ mutationFn: (status: string) => apiData(`/users/${id}/status`, { method: "PATCH", body: { status } }), onSuccess: () => { toast("Status updated"); invalidate(); }, onError: (e) => toast(errorMessage(e), "error") });
  const addRole = useMutation({ mutationFn: () => apiData(`/users/${id}/roles`, { method: "POST", body: { role } }), onSuccess: () => { toast("Role added"); invalidate(); }, onError: (e) => toast(errorMessage(e), "error") });
  const removeRole = useMutation({ mutationFn: (r: string) => apiData(`/users/${id}/roles/${r}`, { method: "DELETE" }), onSuccess: () => { toast("Role removed"); invalidate(); }, onError: (e) => toast(errorMessage(e), "error") });
  const adjust = useMutation({
    mutationFn: () => {
      const minor = toMinor(amount);
      if (minor === null) throw new Error("Enter a valid amount");
      return apiData(`/wallets/${id}/adjust`, { method: "POST", body: { amountMinor: sign === "debit" ? -minor : minor, note } });
    },
    onSuccess: () => { toast("Wallet adjusted"); setAdjustOpen(false); setAmount(""); setNote(""); invalidate(); },
    onError: (e) => toast(errorMessage(e), "error"),
  });

  if (isLoading || !data) return <p className="text-slate-400">Loading…</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{data.firstName ?? data.telegramHandle ?? "User"}</h1>
        <Badge tone={statusTone(data.status)}>{data.status}</Badge>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <p className="text-xs uppercase text-slate-500">Profile</p>
          <p className="mt-1 text-sm">{data.telegramHandle ? `@${data.telegramHandle}` : "—"}</p>
          <p className="text-sm text-slate-500">{data.email ?? "no email"}</p>
          <p className="mt-2 text-xs text-slate-400">Orders {data.stats.orderCount} · Tickets {data.stats.ticketCount} · Referrals {data.stats.referralCount}</p>
        </Card>
        <Card>
          <p className="text-xs uppercase text-slate-500">Wallet</p>
          <p className="mt-1 text-lg font-semibold">{data.wallet ? formatMinor(Number(data.wallet.balanceMinor), data.wallet.currency) : "—"}</p>
          <Button variant="secondary" className="mt-2" onClick={() => setAdjustOpen(true)}>Adjust balance</Button>
        </Card>
        <Card>
          <p className="text-xs uppercase text-slate-500">Moderation</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setStatus.mutate("ACTIVE")}>Activate</Button>
            <Button variant="secondary" onClick={() => setStatus.mutate("SUSPENDED")}>Suspend</Button>
            <Button variant="danger" onClick={() => setStatus.mutate("BANNED")}>Ban</Button>
          </div>
        </Card>
      </div>

      <Card>
        <p className="mb-2 text-sm font-semibold">Roles</p>
        <div className="mb-3 flex flex-wrap gap-2">
          {data.roles.length === 0 ? <span className="text-sm text-slate-400">CUSTOMER</span> : data.roles.map((r) => (
            <span key={r} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 text-xs">
              {r}
              {r !== "CUSTOMER" ? <button className="text-slate-400 hover:text-red-500" onClick={() => removeRole.mutate(r)}>✕</button> : null}
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <div className="w-40"><Select value={role} onChange={(e) => setRole(e.target.value)}>{ASSIGNABLE.map((r) => <option key={r}>{r}</option>)}</Select></div>
          <Button variant="secondary" onClick={() => addRole.mutate()}>Add role</Button>
        </div>
      </Card>

      <Dialog open={adjustOpen} onClose={() => setAdjustOpen(false)} title="Adjust wallet"
        footer={<><Button variant="secondary" onClick={() => setAdjustOpen(false)}>Cancel</Button><Button onClick={() => adjust.mutate()} disabled={adjust.isPending}>Apply</Button></>}>
        <div className="space-y-3">
          <div><Label>Direction</Label><Select value={sign} onChange={(e) => setSign(e.target.value as "credit" | "debit")}><option value="credit">Credit (+)</option><option value="debit">Debit (−)</option></Select></div>
          <div><Label>Amount ({data.wallet?.currency ?? "INR"})</Label><Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="100.00" /></div>
          <div><Label>Note (required)</Label><Input value={note} onChange={(e) => setNote(e.target.value)} /></div>
        </div>
      </Dialog>
    </div>
  );
}
