"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { Badge, Button, Card, Input, Label, Textarea } from "@/components/ui";
import { useToast } from "@/components/toast";
import { apiData } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

/**
 * Store Features — the same switches the bot admin has, as forms.
 * Everything here goes through PATCH /features/:name, which reuses the core
 * setters, so a change made in the browser shows up in the bot at once.
 */
interface Features {
  rails: { upiEnabled: boolean; binanceEnabled: boolean; upiMaxInr: number | null };
  risk: { newUserMaxUsd: number; newUserHours: number; maxOrdersPerDay: number };
  renewal: { enabled: boolean; daysBefore: number; pct: number };
  combo: { enabled: boolean; pct: number; minProducts: number };
  miniapp: { enabled: boolean; url: string | null };
  shop: { hideSoldOut: boolean };
  backup: { daily: boolean };
  agents: { ids: string[] };
  alwaysAdmin: { telegramId: string | null; handle: string | null };
  faq: Array<{ id: string; q: string; a: string }>;
  referral: { firstPct: number; repeatPct: number; holdHours: number; commissionMonths: number };
  milestones: {
    enabled: boolean; mode: "purchased" | "invited"; repeatLast: boolean; tiers: Array<{ count: number; rewardUsd: number }>;
    payouts: number; paidUsd: number; eligibleReferrers: number;
    top: Array<{ userId: string; handle: string | null; firstName: string | null; invited: number; purchased: number }>;
  };
  crypto: { configured: boolean; networks: string[]; catalogue: Array<{ code: string; label: string; stable: boolean }> };
  terminal: {
    seedConfigured: boolean; enabled: string[]; payout: Record<string, string>; sweepMinUsd: Record<string, number>;
    toleranceStablePct: number; toleranceVolatilePct: number;
    chains: Array<{ code: string; label: string; defaultSweepMinUsd: number }>;
  };
}

export default function FeaturesPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ["features"], queryFn: () => apiData<Features>("/features") });
  if (isLoading) return <p className="text-slate-400">Loading…</p>;
  if (error || !data) return <p className="text-red-600">{errorMessage(error)}</p>;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Store Features</h1>
        <p className="text-sm text-slate-500">Everything the bot admin can toggle, in one place. Changes apply to the bot within seconds.</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <OrderLimits f={data} />
        <PermanentAdmin f={data} />
        <PaymentRails f={data} />
        <MiniApp f={data} />
        <Renewal f={data} />
        <Combo f={data} />
        <ShopAndBackup f={data} />
        <Agents f={data} />
        <Crypto f={data} />
        <Terminal f={data} />
      </div>
      <Referral f={data} />
      <Faq f={data} />
    </div>
  );
}

// ── plumbing ────────────────────────────────────────────────────────────────

function useFeature<T extends keyof Features>(name: T) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => apiData<Features>(`/features/${name}`, { method: "PATCH", body }),
    onSuccess: (next) => { qc.setQueryData(["features"], next); toast("Saved"); },
    onError: (e) => toast(errorMessage(e), "error"),
  });
}

function Section({ title, hint, badge, children }: { title: string; hint?: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">{title}</h2>
          {hint && <p className="text-xs text-slate-500">{hint}</p>}
        </div>
        {badge}
      </div>
      <div className="space-y-3">{children}</div>
    </Card>
  );
}

function Toggle({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={disabled}
        onClick={() => onChange(!on)}
        className={`relative h-6 w-11 rounded-full transition ${on ? "bg-emerald-500" : "bg-slate-300"} disabled:opacity-50`}
      >
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${on ? "left-[22px]" : "left-0.5"}`} />
      </button>
    </label>
  );
}

function NumberField({ label, value, onChange, step = 1, min = 0, suffix }: { label: string; value: number; onChange: (n: number) => void; step?: number; min?: number; suffix?: string }) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <Input type="number" step={step} min={min} value={Number.isFinite(value) ? value : 0} onChange={(e) => onChange(Number(e.target.value))} />
        {suffix && <span className="text-xs text-slate-500">{suffix}</span>}
      </div>
    </div>
  );
}

// ── sections ────────────────────────────────────────────────────────────────

function OrderLimits({ f }: { f: Features }) {
  const m = useFeature("risk");
  const [v, setV] = useState(f.risk);
  useEffect(() => setV(f.risk), [f.risk]);
  return (
    <Section title="🛡 Order limits" hint="Both default to off — anyone can place as many orders as they like.">
      <NumberField label="First-order cap for new accounts (USD, 0 = off)" value={v.newUserMaxUsd} step={0.5} onChange={(n) => setV({ ...v, newUserMaxUsd: n })} />
      <NumberField label="An account counts as new for (hours)" value={v.newUserHours} min={1} onChange={(n) => setV({ ...v, newUserHours: n })} />
      <NumberField label="Max orders per customer per 24 h (0 = unlimited)" value={v.maxOrdersPerDay} onChange={(n) => setV({ ...v, maxOrdersPerDay: n })} />
      <Button onClick={() => m.mutate({ newUserMaxUsd: v.newUserMaxUsd, newUserHours: Math.round(v.newUserHours), maxOrdersPerDay: Math.round(v.maxOrdersPerDay) })} disabled={m.isPending}>Save</Button>
    </Section>
  );
}

function PermanentAdmin({ f }: { f: Features }) {
  const m = useFeature("alwaysAdmin");
  const [v, setV] = useState("");
  const cur = f.alwaysAdmin;
  return (
    <Section
      title="👑 Permanent bot admin"
      hint="One Telegram account that is always logged in to the bot admin — no passcode, never logged out."
      badge={cur.telegramId ? <Badge tone="green">{cur.handle ? `@${cur.handle}` : cur.telegramId}</Badge> : <Badge>not set</Badge>}
    >
      <div>
        <Label>@username or numeric Telegram id</Label>
        <Input placeholder="@yourname" value={v} onChange={(e) => setV(e.target.value)} />
        <p className="mt-1 text-xs text-slate-500">The account must have sent /start to the bot once. Only one account can be permanent.</p>
      </div>
      <div className="flex gap-2">
        <Button onClick={() => m.mutate({ idOrHandle: v.trim() })} disabled={m.isPending || !v.trim()}>Set</Button>
        {cur.telegramId && <Button variant="danger" onClick={() => { if (confirm("Remove the permanent admin? They will need the passcode again.")) m.mutate({ idOrHandle: null }); }} disabled={m.isPending}>Remove</Button>}
      </div>
    </Section>
  );
}

function PaymentRails({ f }: { f: Features }) {
  const m = useFeature("rails");
  const [max, setMax] = useState(f.rails.upiMaxInr ?? 0);
  useEffect(() => setMax(f.rails.upiMaxInr ?? 0), [f.rails.upiMaxInr]);
  return (
    <Section title="💳 Payment methods" hint="Switch UPI / Binance Pay on or off, and cap UPI to small orders.">
      <Toggle on={f.rails.upiEnabled} label="UPI payments" onChange={(on) => m.mutate({ upiEnabled: on })} disabled={m.isPending} />
      <Toggle on={f.rails.binanceEnabled} label="Binance Pay" onChange={(on) => m.mutate({ binanceEnabled: on })} disabled={m.isPending} />
      <NumberField label="Hide UPI above this order total (INR, 0 = no cap)" value={max} onChange={setMax} />
      <Button variant="secondary" onClick={() => m.mutate({ upiMaxInr: max > 0 ? max : null })} disabled={m.isPending}>Save UPI cap</Button>
    </Section>
  );
}

function MiniApp({ f }: { f: Features }) {
  const m = useFeature("miniapp");
  return (
    <Section
      title="📱 Mini App (web shop)"
      hint="A Telegram Mini App catalogue — grid, search, categories. Buying hands back to the bot."
      badge={f.miniapp.url ? <Badge tone="green">ready</Badge> : <Badge tone="yellow">needs https PUBLIC_API_URL</Badge>}
    >
      <Toggle on={f.miniapp.enabled} label="Show 🛍 Open Shop button in the bot menu" onChange={(on) => m.mutate({ enabled: on })} disabled={m.isPending} />
      {f.miniapp.url ? (
        <p className="break-all text-xs text-slate-500">URL: <code>{f.miniapp.url}</code> — paste this in @BotFather → Bot Settings → Menu Button to make it the bot's menu button too.</p>
      ) : (
        <p className="text-xs text-amber-700">Set <code>PUBLIC_API_URL</code> on the server to your https:// API domain and restart; Telegram only opens Mini Apps over HTTPS.</p>
      )}
    </Section>
  );
}

function Renewal({ f }: { f: Features }) {
  const m = useFeature("renewal");
  const [v, setV] = useState(f.renewal);
  useEffect(() => setV(f.renewal), [f.renewal]);
  return (
    <Section title="🔁 Renewal reminders" hint="Message customers before a subscription-style item expires, with a one-tap renew.">
      <Toggle on={f.renewal.enabled} label="Enabled" onChange={(on) => m.mutate({ enabled: on })} disabled={m.isPending} />
      <NumberField label="Remind this many days before expiry" value={v.daysBefore} onChange={(n) => setV({ ...v, daysBefore: n })} />
      <NumberField label="Renewal discount (%)" value={v.pct} onChange={(n) => setV({ ...v, pct: n })} suffix="%" />
      <Button variant="secondary" onClick={() => m.mutate({ daysBefore: Math.round(v.daysBefore), pct: Math.round(v.pct) })} disabled={m.isPending}>Save</Button>
    </Section>
  );
}

function Combo({ f }: { f: Features }) {
  const m = useFeature("combo");
  const [v, setV] = useState(f.combo);
  useEffect(() => setV(f.combo), [f.combo]);
  return (
    <Section title="🎁 Combo deal" hint="Automatic cart discount once it holds enough different products.">
      <Toggle on={f.combo.enabled} label="Enabled" onChange={(on) => m.mutate({ enabled: on })} disabled={m.isPending} />
      <NumberField label="Discount (%)" value={v.pct} onChange={(n) => setV({ ...v, pct: n })} suffix="%" />
      <NumberField label="Minimum distinct products" value={v.minProducts} min={2} onChange={(n) => setV({ ...v, minProducts: n })} />
      <Button variant="secondary" onClick={() => m.mutate({ pct: Math.round(v.pct), minProducts: Math.round(v.minProducts) })} disabled={m.isPending}>Save</Button>
    </Section>
  );
}

function ShopAndBackup({ f }: { f: Features }) {
  const shop = useFeature("shop");
  const backup = useFeature("backup");
  return (
    <Section title="🏬 Shop & backups">
      <Toggle on={f.shop.hideSoldOut} label="Hide sold-out products from the shop" onChange={(on) => shop.mutate({ hideSoldOut: on })} disabled={shop.isPending} />
      <Toggle on={f.backup.daily} label="Send a daily JSON backup to the admin chat" onChange={(on) => backup.mutate({ daily: on })} disabled={backup.isPending} />
    </Section>
  );
}

function Agents({ f }: { f: Features }) {
  const m = useFeature("agents");
  const [add, setAdd] = useState("");
  return (
    <Section title="👥 Support agents" hint="Agents log in with the bot passcode but only see orders, tickets and replacements.">
      <ul className="space-y-1 text-sm">
        {f.agents.ids.length === 0 && <li className="text-slate-400">No agents yet.</li>}
        {f.agents.ids.map((id) => (
          <li key={id} className="flex items-center justify-between">
            <code>{id}</code>
            <Button variant="ghost" onClick={() => m.mutate({ ids: f.agents.ids.filter((x) => x !== id) })} disabled={m.isPending}>Remove</Button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Input placeholder="Numeric Telegram id" value={add} onChange={(e) => setAdd(e.target.value.replace(/\D/g, ""))} />
        <Button onClick={() => { if (add) { m.mutate({ ids: [...f.agents.ids, add] }); setAdd(""); } }} disabled={m.isPending || add.length < 5}>Add</Button>
      </div>
    </Section>
  );
}

function Crypto({ f }: { f: Features }) {
  const m = useFeature("crypto");
  const on = new Set(f.crypto.networks);
  return (
    <Section
      title="🪙 Crypto via NOWPayments"
      hint="Networks offered when the hosted provider is used. API keys are set from the bot admin only."
      badge={f.crypto.configured ? <Badge tone="green">API key set</Badge> : <Badge>not configured</Badge>}
    >
      <div className="grid grid-cols-2 gap-2 text-sm">
        {f.crypto.catalogue.map((n) => (
          <label key={n.code} className="flex items-center gap-2">
            <input type="checkbox" checked={on.has(n.code)} disabled={m.isPending} onChange={(e) => {
              const next = new Set(on); if (e.target.checked) next.add(n.code); else next.delete(n.code);
              m.mutate({ networks: [...next] });
            }} />
            <span>{n.label}</span>
          </label>
        ))}
      </div>
    </Section>
  );
}

function Terminal({ f }: { f: Features }) {
  const m = useFeature("terminal");
  const t = f.terminal;
  const [payout, setPayout] = useState<Record<string, string>>(t.payout);
  const [tol, setTol] = useState({ s: t.toleranceStablePct, v: t.toleranceVolatilePct });
  useEffect(() => { setPayout(t.payout); setTol({ s: t.toleranceStablePct, v: t.toleranceVolatilePct }); }, [t]);
  const on = new Set(t.enabled);
  return (
    <Section
      title="🏦 Own crypto terminal"
      hint="Your self-hosted wallet terminal: unique address per payment, auto-sweep to your payout wallet. The seed is set from the bot only."
      badge={t.seedConfigured ? <Badge tone="green">seed set</Badge> : <Badge tone="yellow">no seed — set it in bot admin</Badge>}
    >
      {t.chains.map((c) => (
        <div key={c.code} className="rounded-lg border border-slate-200 p-3">
          <Toggle on={on.has(c.code)} label={c.label} disabled={m.isPending || !t.seedConfigured} onChange={(v) => {
            const next = new Set(on); if (v) next.add(c.code); else next.delete(c.code);
            m.mutate({ enabled: [...next] });
          }} />
          <div className="mt-2 flex gap-2">
            <Input placeholder="Payout (cold wallet) address" value={payout[c.code] ?? ""} onChange={(e) => setPayout({ ...payout, [c.code]: e.target.value })} />
            <Button variant="secondary" onClick={() => m.mutate({ payout: { [c.code]: (payout[c.code] ?? "").trim() } })} disabled={m.isPending}>Save</Button>
          </div>
        </div>
      ))}
      <div className="grid grid-cols-2 gap-3">
        <NumberField label="Underpayment tolerance — stablecoins (%)" value={tol.s} step={0.1} onChange={(n) => setTol({ ...tol, s: n })} />
        <NumberField label="Underpayment tolerance — volatile coins (%)" value={tol.v} step={0.1} onChange={(n) => setTol({ ...tol, v: n })} />
      </div>
      <Button variant="secondary" onClick={() => m.mutate({ toleranceStablePct: tol.s, toleranceVolatilePct: tol.v })} disabled={m.isPending}>Save tolerances</Button>
    </Section>
  );
}

function Referral({ f }: { f: Features }) {
  const rates = useFeature("referral");
  const m = useFeature("milestones");
  const [r, setR] = useState({ first: f.referral.firstPct, repeat: f.referral.repeatPct, months: f.referral.commissionMonths });
  const [tier, setTier] = useState({ count: "", usd: "" });
  useEffect(() => setR({ first: f.referral.firstPct, repeat: f.referral.repeatPct, months: f.referral.commissionMonths }), [f.referral]);
  const ms = f.milestones;
  return (
    <Section
      title="🏆 Referral programme & milestone cashback"
      hint="Percentage rewards on every referred order, plus a ladder of one-time cashbacks (e.g. 10 referrals → $0.50)."
      badge={<Badge tone={ms.enabled ? "green" : "gray"}>{ms.enabled ? `ladder on · $${ms.paidUsd.toFixed(2)} paid` : "ladder off"}</Badge>}
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Percentage rewards</h3>
          <NumberField label="Friend's first purchase (%)" value={r.first} step={0.5} onChange={(n) => setR({ ...r, first: n })} suffix="%" />
          <NumberField label="Every purchase after (%)" value={r.repeat} step={0.5} onChange={(n) => setR({ ...r, repeat: n })} suffix="%" />
          <NumberField label="Repeat commission runs for (months after friend's first purchase, 0 = lifetime)" value={r.months} onChange={(n) => setR({ ...r, months: n })} suffix="months" />
          <p className="text-xs text-slate-500">Held {f.referral.holdHours} h against refunds, then credited to the referrer's wallet.</p>
          <Button variant="secondary" onClick={() => rates.mutate({ firstPct: r.first, repeatPct: r.repeat, commissionMonths: Math.round(r.months) })} disabled={rates.isPending}>Save rates</Button>
        </div>
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Milestone cashback ladder</h3>
          <Toggle on={ms.enabled} label="Enabled" onChange={(on) => m.mutate({ enabled: on })} disabled={m.isPending} />
          <Toggle on={ms.mode === "purchased"} label={ms.mode === "purchased" ? "Counting friends who bought" : "Counting friends invited (active accounts; default)"} onChange={(on) => m.mutate({ mode: on ? "purchased" : "invited" })} disabled={m.isPending} />
          <Toggle on={ms.repeatLast} label="Keep paying the last tier for every further batch" onChange={(on) => m.mutate({ repeatLast: on })} disabled={m.isPending} />
          <ul className="space-y-1 text-sm">
            {ms.tiers.length === 0 && <li className="text-slate-400">No milestones yet.</li>}
            {ms.tiers.map((t) => (
              <li key={t.count} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-1.5">
                <span><b>{t.count}</b> referrals → <b>${t.rewardUsd.toFixed(2)}</b> cashback</span>
                <Button variant="ghost" onClick={() => m.mutate({ tiers: ms.tiers.filter((x) => x.count !== t.count) })} disabled={m.isPending}>Remove</Button>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Input type="number" min={1} placeholder="Referrals (e.g. 10)" value={tier.count} onChange={(e) => setTier({ ...tier, count: e.target.value })} />
            <Input type="number" min={0.01} step={0.01} placeholder="Cashback USD (e.g. 0.5)" value={tier.usd} onChange={(e) => setTier({ ...tier, usd: e.target.value })} />
            <Button
              onClick={() => {
                const count = Math.round(Number(tier.count)); const usd = Number(tier.usd);
                if (!(count > 0) || !(usd > 0)) return;
                m.mutate({ tiers: [...ms.tiers.filter((x) => x.count !== count), { count, rewardUsd: usd }] });
                setTier({ count: "", usd: "" });
              }}
              disabled={m.isPending}
            >Add</Button>
          </div>
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>{ms.payouts} payouts · ${ms.paidUsd.toFixed(2)} paid · {ms.eligibleReferrers} referrers at/above the first tier</span>
            <Button variant="secondary" onClick={() => m.mutate({ runNow: true })} disabled={m.isPending || !ms.enabled}>Pay due now</Button>
          </div>
          {ms.top.length > 0 && (
            <div className="text-xs text-slate-600">
              <p className="mb-1 font-medium">Top referrers</p>
              {ms.top.map((u) => <p key={u.userId}>{u.handle ? `@${u.handle}` : (u.firstName ?? u.userId.slice(-6))} — {u.purchased} bought / {u.invited} invited</p>)}
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}

function Faq({ f }: { f: Features }) {
  const m = useFeature("faq");
  const [q, setQ] = useState("");
  const [a, setA] = useState("");
  return (
    <Section title="❓ FAQ / quick answers" hint="Shown under Help in the bot and suggested before a customer opens a ticket.">
      <div className="space-y-2">
        {f.faq.length === 0 && <p className="text-sm text-slate-400">No questions yet.</p>}
        {f.faq.map((item) => (
          <div key={item.id} className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 p-3 text-sm">
            <div>
              <p className="font-medium">{item.q}</p>
              <p className="whitespace-pre-wrap text-slate-600">{item.a}</p>
            </div>
            <Button variant="ghost" onClick={() => m.mutate({ remove: item.id })} disabled={m.isPending}>Remove</Button>
          </div>
        ))}
      </div>
      <div className="grid gap-2 md:grid-cols-[1fr_2fr_auto]">
        <Input placeholder="Question" value={q} onChange={(e) => setQ(e.target.value)} />
        <Textarea rows={2} placeholder="Answer" value={a} onChange={(e) => setA(e.target.value)} />
        <Button onClick={() => { m.mutate({ add: { q: q.trim(), a: a.trim() } }); setQ(""); setA(""); }} disabled={m.isPending || q.trim().length < 3 || !a.trim()}>Add</Button>
      </div>
    </Section>
  );
}
