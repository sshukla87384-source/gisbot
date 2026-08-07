import { prisma } from "@gis/database";
import { encryptSecret, decryptSecret } from "@gis/shared";
import { loadConfig } from "@gis/config";
import { logEvent } from "./logs.service.js";
import { enqueueAdminAlert } from "./queues.js";

/**
 * Reads confirmed incoming credits from the merchant account.
 *
 * BharatPe publishes no developer API, so this talks to the same endpoint the
 * merchant dashboard uses, authenticated with a session cookie and token. Two
 * consequences follow from that and are handled deliberately below:
 *
 *  - The session EXPIRES, typically within days. When it does, verification
 *    must fail loudly. Silently falling back to manual approval would look
 *    identical to "no customers today" and could go unnoticed for a week.
 *  - The cookie is full account access, so it is encrypted at rest exactly like
 *    the Binance secret, never logged, and never displayed in full.
 */
const KEY = "upi.provider";

/** Same master key the Binance and supplier secrets already use. */
const masterKey = (): string => loadConfig().ENCRYPTION_MASTER_KEY;
const enc = (v: string): string => (v ? encryptSecret(v, masterKey()) : "");
const dec = (v: string): string => {
  if (!v) return "";
  try { return decryptSecret(v, masterKey()); } catch { return ""; }
};

export interface UpiProviderConfig {
  endpoint: string;
  merchantId: string;
  upiId: string;
  cookie: string;
  token: string;
}

export async function setUpiProvider(cfg: Partial<UpiProviderConfig>): Promise<void> {
  const cur = (await getUpiProvider()) ?? { endpoint: "", merchantId: "", upiId: "", cookie: "", token: "" };
  const next = { ...cur, ...cfg };
  await prisma.setting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: { ...next, cookie: enc(next.cookie), token: enc(next.token) } as never },
    update: { value: { ...next, cookie: enc(next.cookie), token: enc(next.token) } as never },
  });
}

export async function getUpiProvider(): Promise<UpiProviderConfig | null> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  const v = row?.value as Record<string, string> | null;
  if (!v?.endpoint) return null;
  try {
    return { endpoint: v.endpoint, merchantId: v.merchantId ?? "", upiId: v.upiId ?? "", cookie: dec(v.cookie ?? ""), token: dec(v.token ?? "") };
  } catch {
    return null;
  }
}

/** Digits only — providers format the reference inconsistently. */
const normUtr = (v: unknown): string => String(v ?? "").replace(/\D/g, "");

/**
 * Pull a UTR, amount and timestamp out of a provider row.
 *
 * Field names differ between providers and undocumented endpoints change, so
 * this accepts the usual spellings rather than assuming one shape. A row it
 * cannot read is skipped and logged instead of throwing, so one odd record
 * cannot stop the rest of the batch being recorded.
 */
export function mapCreditRow(row: Record<string, unknown>): { utr: string; amountMinor: number; creditedAt: Date } | null {
  const utr = normUtr(
    row.utr ?? row.rrn ?? row.RRN ?? row.referenceId ?? row.refId ?? row.reference ??
    row.transactionId ?? row.txnId ?? row.upiTransactionId ?? row.bankReferenceNo,
  );
  if (utr.length !== 12) return null;

  const rawAmt = row.amount ?? row.amt ?? row.txnAmount ?? row.transactionAmount ?? row.credit;
  const amt = typeof rawAmt === "number" ? rawAmt : Number.parseFloat(String(rawAmt ?? "").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(amt) || amt <= 0) return null;
  // Providers report either rupees ("78.75") or paise (7875). A value with a
  // decimal point is rupees; a bare integer from a field named *Minor/paise is
  // already minor units.
  const looksMinor = /minor|paise/i.test(Object.keys(row).find((k) => row[k] === rawAmt) ?? "");
  const amountMinor = looksMinor ? Math.round(amt) : Math.round(amt * 100);

  const rawTime = row.creditedAt ?? row.transactionTime ?? row.txnDate ?? row.createdAt ?? row.date ?? row.timestamp;
  const t = typeof rawTime === "number" ? new Date(rawTime < 1e12 ? rawTime * 1000 : rawTime) : new Date(String(rawTime ?? ""));
  if (Number.isNaN(t.getTime())) return null;

  return { utr, amountMinor, creditedAt: t };
}

export class UpiSessionExpired extends Error {}

/** Fetch recent credits. Throws UpiSessionExpired when the cookie has died. */
/** How many recent transactions to pull per poll. */
export const UPI_PAGE_SIZE = 50;

/**
 * Build the request URL.
 *
 * pageSize is forced up. Merchant dashboards hand out sample URLs with
 * pageSize=1, and polling with that would only ever see the single most recent
 * transaction — two customers paying between cron ticks means one credit is
 * never recorded, and that order waits for manual approval forever.
 *
 * merchantId is filled in from the saved setting when the URL does not already
 * carry one, so either form works.
 */
export function buildCreditsUrl(cfg: UpiProviderConfig): string {
  const u = new URL(cfg.endpoint);
  const size = Number(u.searchParams.get("pageSize") ?? 0);
  if (!Number.isFinite(size) || size < UPI_PAGE_SIZE) u.searchParams.set("pageSize", String(UPI_PAGE_SIZE));
  if (cfg.merchantId && !u.searchParams.get("merchantId")) u.searchParams.set("merchantId", cfg.merchantId);
  return u.toString();
}

export async function fetchUpiCredits(cfg: UpiProviderConfig): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(buildCreditsUrl(cfg), {
    method: "GET",
    headers: {
      cookie: cfg.cookie,
      token: cfg.token,
      authorization: cfg.token.startsWith("Bearer ") ? cfg.token : `Bearer ${cfg.token}`,
      ...(cfg.merchantId ? { merchantid: cfg.merchantId } : {}),
      accept: "application/json",
    },
  });
  // A dead session usually answers 401/403, but these dashboards often answer
  // 200 with an HTML login page, so content-type is checked too.
  const ctype = res.headers.get("content-type") ?? "";
  if (res.status === 401 || res.status === 403 || !ctype.includes("json")) throw new UpiSessionExpired(`status ${res.status}`);
  const body = (await res.json()) as unknown;
  const rows =
    Array.isArray(body) ? body
    : Array.isArray((body as { data?: unknown }).data) ? (body as { data: unknown[] }).data
    : Array.isArray((body as { transactions?: unknown }).transactions) ? (body as { transactions: unknown[] }).transactions
    : Array.isArray(((body as { data?: { transactions?: unknown } }).data ?? {}).transactions) ? ((body as { data: { transactions: unknown[] } }).data).transactions
    : [];
  return rows as Array<Record<string, unknown>>;
}

/** Poll and record credits. Returns how many new ones were stored. */
export async function pollUpiCredits(): Promise<number> {
  const cfg = await getUpiProvider();
  if (!cfg) return 0;
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await fetchUpiCredits(cfg);
  } catch (e) {
    if (e instanceof UpiSessionExpired) {
      // Loud on purpose. A silent fallback to manual approval is
      // indistinguishable from a quiet day and can go unnoticed for a week.
      await enqueueAdminAlert(
        "🔴 <b>BharatPe session expired.</b>\n\nUPI payments cannot be verified automatically and are all waiting for your approval.\n\nPaste a fresh Cookie and Token in Payments → 🏦 BharatPe verification.",
      ).catch(() => undefined);
    }
    await logEvent("payment", "error", "upi.poll", `UPI credit poll failed: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`).catch(() => undefined);
    return 0;
  }
  let stored = 0;
  for (const row of rows) {
    // PAYMENT_ALL returns outgoing rows too. A payout or refund carries a
    // reference and an amount just like a credit does, and settling an order
    // against one would hand over goods for money that LEFT the account.
    const dir = String(row.type ?? row.txnType ?? row.transactionType ?? row.direction ?? "").toUpperCase();
    if (/DEBIT|PAYOUT|WITHDRAW|REFUND|REVERSAL|SETTLEMENT/.test(dir)) continue;
    const status = String(row.status ?? row.txnStatus ?? row.transactionStatus ?? "").toUpperCase();
    if (status && !/SUCCESS|COMPLETED|CAPTURED|CREDIT|PAID/.test(status)) continue;
    const c = mapCreditRow(row);
    if (!c) continue;
    try {
      await prisma.upiCredit.create({
        data: { utr: c.utr, amountMinor: c.amountMinor, creditedAt: c.creditedAt, raw: row as never },
      });
      stored++;
    } catch {
      // @unique on utr: already recorded on an earlier poll.
    }
  }
  return stored;
}
