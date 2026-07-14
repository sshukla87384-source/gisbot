"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Button, Card, Input, Label } from "@/components/ui";
import { useToast } from "@/components/toast";
import { apiData } from "@/lib/api";
import { errorMessage, formatDateTime } from "@/lib/utils";

interface ApiKey {
  id: string; name: string; prefix: string; scopes: string[]; rateLimitPerMin: number;
  callCount: number; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null; createdAt: string;
}

const ALL_SCOPES = ["catalog:read", "orders:read", "analytics:read"];
const BASE = `${process.env.NEXT_PUBLIC_API_URL ?? ""}/api/v1/developer`;

export default function DeveloperPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["catalog:read"]);
  const [rate, setRate] = useState("120");
  const [newKey, setNewKey] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["apikeys"],
    queryFn: () => apiData<ApiKey[]>("/apikeys"),
  });

  const create = useMutation({
    mutationFn: () =>
      apiData<{ apiKey: string }>("/apikeys", {
        method: "POST",
        body: { name, scopes, rateLimitPerMin: Number.parseInt(rate, 10) || 120 },
      }),
    onSuccess: (r) => {
      setNewKey(r.apiKey);
      setName(""); setScopes(["catalog:read"]);
      void qc.invalidateQueries({ queryKey: ["apikeys"] });
    },
    onError: (e) => toast(errorMessage(e), "error"),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => apiData(`/apikeys/${id}/revoke`, { method: "POST" }),
    onSuccess: () => { toast("Key revoked"); void qc.invalidateQueries({ queryKey: ["apikeys"] }); },
    onError: (e) => toast(errorMessage(e), "error"),
  });

  const toggle = (s: string) =>
    setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Developer API</h1>
      <Card>
        <p className="text-sm text-slate-600">
          Give partners programmatic, read-only access to your catalog and order status. Keys are scoped and rate-limited.
        </p>
        <div className="mt-2 space-y-1 text-sm">
          <div>Base URL: <code className="rounded bg-slate-100 px-1">{BASE}</code></div>
          <div>Docs: <a className="text-indigo-600 hover:underline" href={`${BASE}/docs`} target="_blank" rel="noreferrer">{BASE}/docs</a></div>
          <div>Auth header: <code className="rounded bg-slate-100 px-1">X-API-Key: &lt;your key&gt;</code></div>
        </div>
      </Card>

      <Card>
        <div className="mb-2 text-sm font-semibold">Create a new key</div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[14rem] flex-1"><Label>Name / partner</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Integration" /></div>
          <div className="w-32"><Label>Rate/min</Label><Input value={rate} onChange={(e) => setRate(e.target.value)} /></div>
        </div>
        <div className="mt-3 flex flex-wrap gap-3">
          {ALL_SCOPES.map((s) => (
            <label key={s} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} /> {s}
            </label>
          ))}
        </div>
        <div className="mt-3">
          <Button onClick={() => create.mutate()} disabled={create.isPending || !name.trim() || scopes.length === 0}>
            {create.isPending ? "Creating…" : "Create key"}
          </Button>
        </div>
      </Card>

      {newKey ? (
        <Card className="border-amber-300 bg-amber-50">
          <div className="text-sm font-semibold text-amber-800">Copy this key now — it won't be shown again:</div>
          <code className="mt-2 block break-all rounded bg-white p-2 text-sm">{newKey}</code>
          <div className="mt-2 flex gap-2">
            <Button variant="secondary" onClick={() => { navigator.clipboard?.writeText(newKey).then(() => toast("Copied")); }}>Copy</Button>
            <Button variant="secondary" onClick={() => setNewKey(null)}>Dismiss</Button>
          </div>
        </Card>
      ) : null}

      <h2 className="text-sm font-semibold text-slate-500">Keys</h2>
      {isLoading ? <p className="text-slate-400">Loading…</p> : (
        <div className="space-y-2">
          {(data ?? []).map((k) => (
            <Card key={k.id}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{k.name} {k.revokedAt ? <Badge tone="red">revoked</Badge> : <Badge tone="green">active</Badge>}</p>
                  <p className="text-xs text-slate-500"><code>{k.prefix}…</code> · {k.scopes.join(", ")} · {k.rateLimitPerMin}/min · {k.callCount} calls</p>
                  <p className="text-xs text-slate-400">Last used: {k.lastUsedAt ? formatDateTime(k.lastUsedAt) : "never"}</p>
                </div>
                {!k.revokedAt ? (
                  <button onClick={() => { if (confirm(`Revoke "${k.name}"? Apps using it will stop working.`)) revoke.mutate(k.id); }} className="text-xs text-red-500 hover:underline">Revoke</button>
                ) : null}
              </div>
            </Card>
          ))}
          {(data ?? []).length === 0 ? <p className="text-sm text-slate-400">No keys yet.</p> : null}
        </div>
      )}
    </div>
  );
}
