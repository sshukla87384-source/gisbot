"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Card } from "@/components/ui";
import { useToast } from "@/components/toast";
import { apiData } from "@/lib/api";
import { errorMessage, prettyJson } from "@/lib/utils";

interface Setting { key: string; value: unknown }

export default function SettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ["settings"], queryFn: () => apiData<Setting[]>("/settings") });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Settings</h1>
      {isLoading ? <p className="text-slate-400">Loading…</p> : (
        <div className="space-y-3">
          {(data ?? []).map((s) => <SettingRow key={s.key} setting={s} onSaved={() => qc.invalidateQueries({ queryKey: ["settings"] })} toast={toast} />)}
        </div>
      )}
    </div>
  );
}

function SettingRow({ setting, onSaved, toast }: { setting: Setting; onSaved: () => void; toast: (m: string, t?: "success" | "error") => void }) {
  const [value, setValue] = useState(prettyJson(setting.value));
  const save = useMutation({
    mutationFn: () => {
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { throw new Error("Value must be valid JSON"); }
      return apiData("/settings", { method: "PATCH", body: { key: setting.key, value: parsed } });
    },
    onSuccess: () => { toast("Saved"); onSaved(); },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  return (
    <Card>
      <div className="flex items-start gap-4">
        <code className="mt-2 w-64 shrink-0 text-sm font-medium">{setting.key}</code>
        <textarea className="flex-1 rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm" rows={1} value={value} onChange={(e) => setValue(e.target.value)} />
        <Button variant="secondary" onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>
      </div>
    </Card>
  );
}
