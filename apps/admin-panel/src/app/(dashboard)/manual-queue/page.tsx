"use client";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Badge, Card } from "@/components/ui";
import { apiData } from "@/lib/api";
import { timeAgo } from "@/lib/utils";

interface QueueOrder {
  id: string;
  orderNumber: string;
  paidAt: string | null;
  user?: { telegramHandle?: string | null; firstName?: string | null };
  items: Array<{ productNameSnap: string; variantNameSnap: string }>;
}

export default function ManualQueue() {
  const router = useRouter();
  const { data, isLoading } = useQuery({ queryKey: ["manual-queue"], queryFn: () => apiData<QueueOrder[]>("/orders/queue/manual") });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Manual fulfillment queue</h1>
      {isLoading ? <p className="text-slate-400">Loading…</p> : (data ?? []).length === 0 ? (
        <Card><p className="text-sm text-slate-400">Nothing waiting. 🎉</p></Card>
      ) : (
        <div className="space-y-3">
          {data!.map((o) => {
            const age = timeAgo(o.paidAt);
            const tone = age.hours > 9 ? "red" : age.hours > 6 ? "yellow" : "green";
            return (
              <Card key={o.id}>
                <div className="flex items-center justify-between">
                  <button className="font-mono text-sm font-semibold hover:underline" onClick={() => router.push(`/orders/${o.id}`)}>{o.orderNumber}</button>
                  <Badge tone={tone}>waiting {age.label}</Badge>
                </div>
                <p className="mt-1 text-sm text-slate-500">
                  {o.user?.telegramHandle ? `@${o.user.telegramHandle}` : o.user?.firstName ?? "—"} · {o.items.map((i) => `${i.productNameSnap} (${i.variantNameSnap})`).join(", ")}
                </p>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
