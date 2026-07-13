"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, Input, Label, Select, Textarea, statusTone } from "@/components/ui";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/toast";
import { api, apiData } from "@/lib/api";
import { formatMinor } from "@/lib/money";
import { errorMessage, formatDateTime } from "@/lib/utils";

interface Item {
  id: string;
  productNameSnap: string;
  variantNameSnap: string;
  totalMinor: number;
  fulfilledAt: string | null;
  variant?: { product?: { type?: string } };
}
interface Order {
  id: string;
  orderNumber: string;
  status: string;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  createdAt: string;
  user?: { telegramHandle?: string | null; firstName?: string | null; email?: string | null };
  items: Item[];
  payments: Array<{ provider: string; status: string; amountMinor: number }>;
  refunds: Array<{ amountMinor: number; status: string }>;
  timeline: Array<{ action: string; createdAt: string }>;
}

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const [fulfilItem, setFulfilItem] = useState<Item | null>(null);
  const [kind, setKind] = useState("LICENSE_KEY");
  const [form, setForm] = useState({ key: "", username: "", password: "", text: "" });

  const { data: order, isLoading } = useQuery({
    queryKey: ["order", id],
    queryFn: () => apiData<Order>(`/orders/${id}`),
  });

  const fulfill = useMutation({
    mutationFn: () =>
      apiData(`/orders/${id}/items/${fulfilItem!.id}/fulfill`, { method: "POST", body: { kind, ...form } }),
    onSuccess: () => {
      toast("Item fulfilled and delivered");
      setFulfilItem(null);
      setForm({ key: "", username: "", password: "", text: "" });
      void qc.invalidateQueries({ queryKey: ["order", id] });
    },
    onError: (e) => toast(errorMessage(e), "error"),
  });

  const resend = useMutation({
    mutationFn: () => apiData(`/orders/${id}/resend-delivery`, { method: "POST" }),
    onSuccess: () => toast("Delivery re-sent"),
    onError: (e) => toast(errorMessage(e), "error"),
  });

  if (isLoading || !order) return <p className="text-slate-400">Loading…</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-mono text-lg font-semibold">{order.orderNumber}</h1>
          <p className="text-sm text-slate-500">{formatDateTime(order.createdAt)}</p>
        </div>
        <div className="flex items-center gap-3">
          <Badge tone={statusTone(order.status)}>{order.status}</Badge>
          <Button variant="secondary" onClick={() => resend.mutate()} disabled={resend.isPending}>Resend delivery</Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <p className="text-xs uppercase text-slate-500">Customer</p>
          <p className="mt-1 text-sm">{order.user?.telegramHandle ? `@${order.user.telegramHandle}` : (order.user?.firstName ?? "—")}</p>
          <p className="text-sm text-slate-500">{order.user?.email ?? ""}</p>
        </Card>
        <Card>
          <p className="text-xs uppercase text-slate-500">Total</p>
          <p className="mt-1 text-lg font-semibold">{formatMinor(order.subtotalMinor - order.discountMinor, order.currency)}</p>
          {order.discountMinor > 0 ? <p className="text-xs text-slate-400">Discount {formatMinor(order.discountMinor, order.currency)}</p> : null}
        </Card>
        <Card>
          <p className="text-xs uppercase text-slate-500">Payments</p>
          {order.payments.length === 0 ? <p className="mt-1 text-sm text-slate-400">None</p> : order.payments.map((p, i) => (
            <p key={i} className="mt-1 text-sm">{p.provider} · <Badge tone={statusTone(p.status)}>{p.status}</Badge></p>
          ))}
        </Card>
      </div>

      <Card className="p-0">
        <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold">Items</div>
        <table className="w-full text-sm">
          <tbody>
            {order.items.map((it) => (
              <tr key={it.id} className="border-b border-slate-100">
                <td className="px-4 py-3">{it.productNameSnap} · <span className="text-slate-500">{it.variantNameSnap}</span></td>
                <td className="px-4 py-3">{formatMinor(it.totalMinor, order.currency)}</td>
                <td className="px-4 py-3">{it.fulfilledAt ? <Badge tone="green">Delivered</Badge> : <Badge tone="yellow">Pending</Badge>}</td>
                <td className="px-4 py-3 text-right">
                  {!it.fulfilledAt ? <Button variant="secondary" onClick={() => { setKind(it.variant?.product?.type === "DIGITAL_ACCOUNT" ? "DIGITAL_ACCOUNT" : "LICENSE_KEY"); setFulfilItem(it); }}>Fulfill</Button> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold">Timeline</h2>
        <ul className="space-y-1 text-sm">
          {order.timeline.map((t, i) => (
            <li key={i} className="flex justify-between"><span>{t.action}</span><span className="text-slate-400">{formatDateTime(t.createdAt)}</span></li>
          ))}
        </ul>
      </Card>

      <Dialog
        open={fulfilItem !== null}
        onClose={() => setFulfilItem(null)}
        title={`Fulfill: ${fulfilItem?.productNameSnap ?? ""}`}
        footer={<>
          <Button variant="secondary" onClick={() => setFulfilItem(null)}>Cancel</Button>
          <Button onClick={() => fulfill.mutate()} disabled={fulfill.isPending}>Deliver</Button>
        </>}
      >
        <div className="space-y-3">
          <div>
            <Label>Delivery type</Label>
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="LICENSE_KEY">License key</option>
              <option value="DIGITAL_ACCOUNT">Account credentials</option>
              <option value="TEXT">Free text</option>
            </Select>
          </div>
          {kind === "LICENSE_KEY" ? (
            <div><Label>Key</Label><Input value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} /></div>
          ) : kind === "DIGITAL_ACCOUNT" ? (
            <>
              <div><Label>Username</Label><Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></div>
              <div><Label>Password</Label><Input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
            </>
          ) : (
            <div><Label>Message</Label><Textarea rows={4} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} /></div>
          )}
        </div>
      </Dialog>
    </div>
  );
}
