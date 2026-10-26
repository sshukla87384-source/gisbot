"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Badge, Button, Card, Input, Label } from "@/components/ui";
import { useToast } from "@/components/toast";
import { apiData } from "@/lib/api";
import { errorMessage, formatDateTime } from "@/lib/utils";

interface ApiKey {
  id: string; name: string; prefix: string; scopes: string[]; rateLimitPerMin: number;
  callCount: number; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null; createdAt: string;
  ownerUserId: string | null;
  owner: { id: string; label: string; handle: string | null; firstName: string | null; telegramId: string | null } | null;
  canPurchase: boolean;
}

const BUY_SCOPES = ["catalog:read", "orders:read", "orders:write", "wallet:read"];
const READ_SCOPES = ["catalog:read", "orders:read"];

const ALL_SCOPES = ["catalog:read", "orders:read", "analytics:read"];
// The Docker build sets NEXT_PUBLIC_API_URL to the empty string when its build
// ARG is unset (`??` does not catch that), which showed partners a relative
// "/api/v1/developer" as the base URL of an API they call from outside.
const ENV_BASE = process.env.NEXT_PUBLIC_API_URL || "";
const BASE = `${ENV_BASE}/api/v1/developer`;

export default function DeveloperPage() {
  // Filled in after mount so the server and first client render still match.
  const [base, setBase] = useState(BASE);
  useEffect(() => {
    if (!ENV_BASE) setBase(`${window.location.origin}/api/v1/developer`);
  }, []);
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["catalog:read"]);
  const [rate, setRate] = useState("120");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["apikeys", search],
    queryFn: () => apiData<ApiKey[]>("/apikeys", { query: { search: search.trim() || undefined } }),
  });

  const setScopesM = useMutation({
    mutationFn: (v: { id: string; scopes: string[] }) => apiData(`/apikeys/${v.id}/scopes`, { method: "POST", body: { scopes: v.scopes } }),
    onSuccess: () => { toast("Access updated"); void qc.invalidateQueries({ queryKey: ["apikeys"] }); },
    onError: (e) => toast(errorMessage(e), "error"),
  });

  const reactivate = useMutation({
    mutationFn: (id: string) => apiData<{ ok: boolean; reason?: string }>(`/apikeys/${id}/reactivate`, { method: "POST" }),
    onSuccess: (r) => {
      if (r.ok) toast("Key re-activated");
      else toast(r.reason === "OTHER_KEY_ACTIVE" ? "This reseller already has another active key — revoke it first." : r.reason === "EXPIRED" ? "That key has expired." : "Key not found.", "error");
      void qc.invalidateQueries({ queryKey: ["apikeys"] });
    },
    onError: (e) => toast(errorMessage(e), "error"),
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
          <div>Base URL: <code className="rounded bg-slate-100 px-1">{base}</code></div>
          <div>Docs: <a className="text-indigo-600 hover:underline" href={`${base}/docs`} target="_blank" rel="noreferrer">{base}/docs</a></div>
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

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-500">Keys — by reseller</h2>
        <div className="w-72"><Input placeholder="Search @username, name, Telegram ID or key…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      </div>
      {isLoading ? <p className="text-slate-400">Loading…</p> : (
        <div className="space-y-2">
          {(data ?? []).map((k) => (
            <Card key={k.id}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  {/* WHO the key belongs to comes first — the list used to show only the key name. */}
                  <p className="font-semibold">
                    {k.owner ? k.owner.label : "Shop key (no customer)"}
                    {k.owner?.handle && k.owner.firstName ? <span className="font-normal text-slate-500"> · {k.owner.firstName}</span> : null}
                    {k.owner?.telegramId ? <span className="ml-2 font-mono text-xs font-normal text-slate-400">{k.owner.telegramId}</span> : null}
                    <span className="ml-2">{k.revokedAt ? <Badge tone="red">revoked</Badge> : <Badge tone="green">active</Badge>}</span>
                  </p>
                  <p className="text-xs text-slate-500">🔑 {k.name} · <code>{k.prefix}…</code> · {k.canPurchase ? "can buy" : "read-only"} · {k.rateLimitPerMin}/min · {k.callCount} calls</p>
                  <p className="text-xs text-slate-400">Last used: {k.lastUsedAt ? formatDateTime(k.lastUsedAt) : "never"} · created {formatDateTime(k.createdAt)}</p>
                </div>
                <Button variant="secondary" onClick={() => setOpen(open === k.id ? null : k.id)}>{open === k.id ? "Close" : "Manage"}</Button>
              </div>
              {open === k.id ? (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3">
                  {k.owner ? <a className="text-sm text-indigo-600 hover:underline" href={`/users/${k.owner.id}`}>Open customer →</a> : null}
                  <span className="text-xs text-slate-400">Scopes: {k.scopes.join(", ")}</span>
                  {!k.revokedAt ? (
                    <>
                      <Button variant="secondary" disabled={setScopesM.isPending} onClick={() => setScopesM.mutate({ id: k.id, scopes: k.canPurchase ? READ_SCOPES : BUY_SCOPES })}>
                        {k.canPurchase ? "Make read-only" : "Allow buying (wallet)"}
                      </Button>
                      <button onClick={() => { if (confirm(`Revoke the key of ${k.owner?.label ?? k.name}? Their apps stop working at once.`)) revoke.mutate(k.id); }} className="text-sm text-red-500 hover:underline">Revoke</button>
                    </>
                  ) : (
                    <Button variant="secondary" disabled={reactivate.isPending} onClick={() => reactivate.mutate(k.id)}>Re-activate</Button>
                  )}
                </div>
              ) : null}
            </Card>
          ))}
          {(data ?? []).length === 0 ? <p className="text-sm text-slate-400">{search ? "No key matches that." : "No keys yet."}</p> : null}
        </div>
      )}
    </div>
  );
}
