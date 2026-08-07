import { loadConfig } from "@gis/config";
import { encryptSecret, decryptSecret } from "@gis/shared";
import { prisma } from "@gis/database";
import { createHmac } from "node:crypto";
import { enqueueAdminAlert } from "../queues.js";
import { getRedis } from "../redis.js";
import { confirmManualPayment } from "./manual-pay.service.js";

const BINANCE_BASE = "https://api.binance.com";

export interface PayTxn {
  transactionId: string;
  transactionTime: number;
  amount: string; // signed decimal string; positive = incoming credit
  currency: string; // asset code, e.g. "USDT"
  orderType?: string;
  orderId?: string; // Binance Pay "Order ID" shown to the customer
}

function sign(query: string, secret: string): string {
  return createHmac("sha256", secret).update(query).digest("hex");
}

/** Signed GET of the account's Binance Pay transaction history (read-only). */
export async function fetchPayTransactions(apiKey: string, apiSecret: string): Promise<PayTxn[]> {
  const query = new URLSearchParams({
    timestamp: Date.now().toString(),
    recvWindow: "5000",
    limit: "100",
  }).toString();
  const signature = sign(query, apiSecret);
  const res = await fetch(`${BINANCE_BASE}/sapi/v1/pay/transactions?${query}&signature=${signature}`, {
    headers: { "X-MBX-APIKEY": apiKey },
  });
  if (!res.ok) throw new Error(`Binance Pay history ${res.status}: ${await res.text().catch(() => "")}`);
  const json = (await res.json()) as { code?: string; data?: PayTxn[] };
  return json.data ?? [];
}

/** Binance API credentials — admin-set (encrypted in DB) preferred, else .env. */
export async function getBinanceCreds(): Promise<{ key: string; secret: string } | null> {
  const cfg = loadConfig();
  try {
    const row = await prisma.setting.findUnique({ where: { key: "binance.api" } });
    const v = row?.value as { keyEnc?: string; secretEnc?: string } | null | undefined;
    if (v?.keyEnc && v?.secretEnc) {
      return { key: decryptSecret(v.keyEnc, cfg.ENCRYPTION_MASTER_KEY), secret: decryptSecret(v.secretEnc, cfg.ENCRYPTION_MASTER_KEY) };
    }
  } catch { /* fall back to env */ }
  if (cfg.BINANCE_API_KEY && cfg.BINANCE_API_SECRET) return { key: cfg.BINANCE_API_KEY, secret: cfg.BINANCE_API_SECRET };
  return null;
}

/** Admin: set the Binance API key/secret from the bot (stored encrypted). */
export async function setBinanceCreds(key: string, secret: string): Promise<void> {
  const cfg = loadConfig();
  const value = { keyEnc: encryptSecret(key.trim(), cfg.ENCRYPTION_MASTER_KEY), secretEnc: encryptSecret(secret.trim(), cfg.ENCRYPTION_MASTER_KEY) };
  await prisma.setting.upsert({ where: { key: "binance.api" }, create: { key: "binance.api", value }, update: { value } });
}

async function alertApiFailureThrottled(msg: string): Promise<void> {
  try {
    const first = await getRedis().set("binance:apierr", "1", "EX", 1800, "NX"); // once / 30 min
    if (first) await enqueueAdminAlert(`⚠️ Binance API problem — auto-verify is OFF until fixed:\n${msg.slice(0, 400)}`);
  } catch { /* ignore */ }
}

/** Diagnostic: verify the Binance API key can read Pay history. */
export async function testBinanceApi(): Promise<{ ok: boolean; detail: string }> {
  const creds = await getBinanceCreds();
  if (!creds) {
    return { ok: false, detail: "No Binance API key/secret set. Set them in /Shriji → 🔗 Binance API (or .env)." };
  }
  try {
    const txns = await fetchPayTransactions(creds.key, creds.secret);
    const sample = txns.slice(0, 3).map((t) => `${t.amount} ${t.currency}`).join("; ");
    return { ok: true, detail: `OK ✅ — read ${txns.length} recent Pay transaction(s). ${sample ? `Latest: ${sample}` : "(none yet)"}` };
  } catch (e) {
    return { ok: false, detail: String(e instanceof Error ? e.message : e).slice(0, 400) };
  }
}

/**
 * A credit can only pay for an order that already existed when it arrived.
 * Small allowance for clock skew between Binance and this server.
 */
const CLOCK_SKEW_MS = 2 * 60_000;

/** Transaction types that are not a customer paying us. */
const NOT_A_PAYMENT = /refund|reversal|revoke|cancel|payout|withdraw/i;

/**
 * Has this Binance transaction already settled ANYTHING?
 *
 * Order.binanceTxnId and WalletTopup.binanceTxnId are each @unique, but only
 * within their own table — so a transaction that topped up a wallet could still
 * be spent again to settle an order. Both tables must be checked together.
 */
async function txnAlreadyUsed(txnId: string): Promise<boolean> {
  const [order, topup] = await Promise.all([
    prisma.order.findFirst({ where: { binanceTxnId: txnId }, select: { id: true } }),
    prisma.walletTopup.findFirst({ where: { binanceTxnId: txnId }, select: { id: true } }),
  ]);
  return Boolean(order ?? topup);
}

interface PendingBinanceOrder {
  id: string;
  orderNumber: string;
  binanceAmount: string | null;
  createdAt: Date;
}

/**
 * Poll Binance Pay history and auto-confirm any PENDING_PAYMENT Binance order
 * whose exact USDT amount has arrived. Uses a READ-ONLY API key; never moves
 * funds.
 *
 * A credit is only accepted when ALL of these hold:
 *   1. it arrived AFTER the order was created,
 *   2. it has never settled another order or wallet top-up,
 *   3. exactly one pending order matches it.
 *
 * Guard 1 is the one that matters most. Without it the poller matched purely on
 * amount against the last 100 Pay transactions, so any older credit of the same
 * size — and prices repeat, every buyer of a product owes the identical amount —
 * would silently settle a brand-new order that nobody had paid for. Each stale
 * credit in the window could hand over one order's goods for free.
 */
export async function pollBinancePayments(): Promise<number> {
  const creds = await getBinanceCreds();
  if (!creds) return 0;

  const pending: PendingBinanceOrder[] = await prisma.order.findMany({
    where: { status: "PENDING_PAYMENT", binanceAsset: "USDT", expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "asc" },
    select: { id: true, orderNumber: true, binanceAmount: true, createdAt: true },
    take: 500,
  });
  if (pending.length === 0) return 0;

  let txns: PayTxn[];
  try {
    txns = await fetchPayTransactions(creds.key, creds.secret);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("binance poll failed", { error: String(e) });
    await alertApiFailureThrottled(String(e instanceof Error ? e.message : e));
    return 0;
  }

  const credits = txns.filter(
    (t) => t.currency === "USDT" && parseFloat(t.amount) > 0 && !NOT_A_PAYMENT.test(String(t.orderType ?? "")),
  );

  // Orders settled in this pass, so one order cannot take two credits.
  const settled = new Set<string>();
  let confirmed = 0;

  for (const txn of credits) {
    const txnId = String(txn.transactionId);
    const txnTime = Number(txn.transactionTime);
    // No usable timestamp means guard 1 cannot be enforced — refuse rather than
    // fall back to matching on amount alone.
    if (!Number.isFinite(txnTime) || txnTime <= 0) continue;
    if (await txnAlreadyUsed(txnId)) continue;

    const amount = parseFloat(txn.amount);
    const candidates = pending.filter(
      (o: PendingBinanceOrder) =>
        !settled.has(o.id) &&
        o.binanceAmount &&
        Math.abs(parseFloat(o.binanceAmount) - amount) < 0.01 &&
        txnTime >= o.createdAt.getTime() - CLOCK_SKEW_MS,
    );

    if (candidates.length === 0) continue;

    if (candidates.length > 1) {
      // Two people owe the same amount and both were waiting when this landed.
      // Picking one would rob the other, so this needs a human.
      await enqueueAdminAlert(
        `⚠️ Binance payment needs manual review — ${amount} USDT (txn ${txnId}) matches ${candidates.length} pending orders: ` +
          `${candidates.map((c: PendingBinanceOrder) => c.orderNumber).join(", ")}. Confirm the right one in the panel.`,
      ).catch(() => undefined);
      continue;
    }

    const order = candidates[0]!;

    // The database decides the claim: binanceTxnId is @unique, so a race between
    // two pollers cannot double-settle.
    let claimedOk = false;
    try {
      const claimed = await prisma.order.updateMany({
        where: { id: order.id, status: "PENDING_PAYMENT", binanceTxnId: null },
        data: { binanceTxnId: txnId },
      });
      claimedOk = claimed.count > 0;
    } catch {
      claimedOk = false; // unique violation: this txn already settled something
    }
    if (!claimedOk) continue;
    settled.add(order.id);

    try {
      await confirmManualPayment(order.id);
      await enqueueAdminAlert(
        `✅ Binance auto-confirmed ${order.orderNumber} — ${order.binanceAmount} USDT (txn ${txnId}).`,
      );
      confirmed++;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("binance auto-confirm failed", { orderId: order.id, error: String(e) });
    }
  }
  return confirmed;
}


export type BinanceVerifyResult =
  | { ok: true; orderNumber: string }
  | { ok: false; reason: "NOT_FOUND" | "AMOUNT_MISMATCH" | "ALREADY_USED" | "NO_API" | "ORDER_NOT_PENDING" | "WRONG_USER" | "TOO_OLD" };

/**
 * Verify a specific Binance Pay transaction ID against an order and confirm it.
 * Used when the customer/admin pastes the transaction ID (e.g. auto-poll missed
 * it, or two orders shared a base amount). Requires the read-only API key; with
 * no key it returns { ok:false, reason:"NO_API" } so the caller can fall back.
 */
export async function verifyBinanceByTxnId(orderId: string, txnId: string, expectedUserId?: string): Promise<BinanceVerifyResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { orderNumber: true, status: true, binanceAsset: true, binanceAmount: true, userId: true, createdAt: true },
  });
  if (!order) return { ok: false, reason: "NOT_FOUND" };
  if (expectedUserId && order.userId !== expectedUserId) return { ok: false, reason: "WRONG_USER" };
  if (order.status !== "PENDING_PAYMENT") return { ok: false, reason: "ORDER_NOT_PENDING" };

  const clean = txnId.trim();
  // Checks orders AND wallet top-ups — a txn already spent on a top-up used to
  // pass this check and settle an order as well.
  if (await txnAlreadyUsed(clean)) return { ok: false, reason: "ALREADY_USED" };

  const creds = await getBinanceCreds();
  if (!creds) return { ok: false, reason: "NO_API" };

  let txns: PayTxn[];
  try {
    txns = await fetchPayTransactions(creds.key, creds.secret);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("binance verify fetch failed", { error: String(e) });
    return { ok: false, reason: "NOT_FOUND" };
  }

  const txn = txns.find((t) => String(t.transactionId) === clean || String(t.orderId ?? "") === clean);
  if (!txn || txn.currency !== "USDT" || !(parseFloat(txn.amount) > 0)) return { ok: false, reason: "NOT_FOUND" };
  if (NOT_A_PAYMENT.test(String(txn.orderType ?? ""))) return { ok: false, reason: "NOT_FOUND" };

  // Same rule as the poller: a credit that predates the order cannot be paying
  // for it. Otherwise anyone could paste an old transaction id from any earlier
  // payment and have a new, unpaid order released.
  const txnTime = Number(txn.transactionTime);
  if (!Number.isFinite(txnTime) || txnTime <= 0) return { ok: false, reason: "NOT_FOUND" };
  if (txnTime < order.createdAt.getTime() - CLOCK_SKEW_MS) return { ok: false, reason: "TOO_OLD" };

  const want = parseFloat(order.binanceAmount ?? "0");
  if (!(want > 0) || Math.abs(parseFloat(txn.amount) - want) >= 0.01) return { ok: false, reason: "AMOUNT_MISMATCH" };

  const claimed = await prisma.order.updateMany({
    where: { id: orderId, status: "PENDING_PAYMENT", binanceTxnId: null },
    data: { binanceTxnId: clean },
  });
  if (claimed.count === 0) return { ok: false, reason: "ORDER_NOT_PENDING" };

  await confirmManualPayment(orderId);
  await enqueueAdminAlert(`✅ Binance verified by txn ${clean} — ${order.orderNumber} (${order.binanceAmount} USDT).`);
  return { ok: true, orderNumber: order.orderNumber };
}
