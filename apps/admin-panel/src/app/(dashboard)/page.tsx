"use client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card, Select } from "@/components/ui";
import { apiData } from "@/lib/api";
import { formatMinor } from "@/lib/money";

interface Overview {
  revenue: Array<{ currency: string; grossMinor: number; orders: number; aovMinor: number }>;
  orderCount: number;
  newUsers: number;
  pendingManualCount: number;
  refundCount: number;
  refundedMinor: number;
  topProducts: Array<{ name: string; count: number }>;
  lowStockCount: number;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-400">{hint}</p> : null}
    </Card>
  );
}

export default function DashboardPage() {
  const [range, setRange] = useState("30d");
  const { data, isLoading } = useQuery({
    queryKey: ["overview", range],
    queryFn: () => apiData<Overview>("/analytics/overview", { query: { range } }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <div className="w-32">
          <Select value={range} onChange={(e) => setRange(e.target.value)}>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
          </Select>
        </div>
      </div>

      {isLoading || !data ? (
        <p className="text-slate-400">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Stat label="Orders" value={String(data.orderCount)} />
            <Stat label="New users" value={String(data.newUsers)} />
            <Stat label="Pending manual" value={String(data.pendingManualCount)} />
            <Stat label="Low stock variants" value={String(data.lowStockCount)} />
            <Stat label="Refunds" value={String(data.refundCount)} hint={formatMinor(data.refundedMinor, "INR")} />
            {data.revenue.map((r) => (
              <Stat key={r.currency} label={`Revenue (${r.currency})`} value={formatMinor(r.grossMinor, r.currency)} hint={`AOV ${formatMinor(r.aovMinor, r.currency)}`} />
            ))}
          </div>

          <Card>
            <h2 className="mb-3 text-sm font-semibold">Top products</h2>
            {data.topProducts.length === 0 ? (
              <p className="text-sm text-slate-400">No sales in this window.</p>
            ) : (
              <ul className="space-y-2">
                {data.topProducts.map((p) => (
                  <li key={p.name} className="flex items-center justify-between text-sm">
                    <span>{p.name}</span>
                    <span className="font-medium text-slate-500">{p.count} sold</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
