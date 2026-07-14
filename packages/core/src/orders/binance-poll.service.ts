import { loadConfig } from "@gis/config";
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

async function alertApiFailureThrottled(msg: string): Promise<void> {
  try {
    const first = await getRedis().set("binance:apierr", "1", "EX", 1800, "NX"); // once / 30 min
    if (first) await enqueueAdminAlert(`⚠️ Binance API problem — auto-verify is OFF until fixed:\n${msg.slice(0, 400)}`);
  } catch { /* ignore */ }
}

/** Diagnostic: verify the Binance API key can read Pay history. */
export async function testBinanceApi(): Promise<{ ok: boolean; detail: string }> {
  const cfg = loadConfig();
  if (!cfg.BINANCE_API_KEY || !cfg.BINANCE_API_SECRET) {
    return { ok: false, detail: "BINANCE_API_KEY / BINANCE_API_SECRET are not set in .env." };
  }
  try {
    const txns = await fetchPayTransactions(cfg.BINANCE_API_KEY, cfg.BINANCE_API_SECRET);
    const sample = txns.slice(0, 3).map((t) => `${t.amount} ${t.currency}`).join("; ");
    return { ok: true, detail: `OK ✅ — read ${txns.length} recent Pay transaction(s). ${sample ? `Latest: ${sample}` : "(none yet)"}` };
  } catch (e) {
    return { ok: false, detail: String(e instanceof Error ? e.message : e).slice(0, 400) };
  }
}

/**
 * Poll Binance Pay history and auto-confirm any PENDING_PAYMENT Binance order
 * whose exact USDT amount has arrived. Uses a READ-ONLY API key; never moves
 * funds. Each transaction settles at most one order (binanceTxnId dedupe).
 */
export async function pollBinancePayments(): Promise<number> {
  const cfg = loadConfig();
  if (!cfg.BINANCE_API_KEY || !cfg.BINANCE_API_SECRET) return 0;

  const pending = await prisma.order.findMany({
    where: { status: "PENDING_PAYMENT", binanceAsset: "USDT", expiresAt: { gt: new Date() } },
    select: { id: true, orderNumber: true, binanceAmount: true },
  });
  if (pending.length === 0) return 0;

  let txns: PayTxn[];
  try {
    txns = await fetchPayTransactions(cfg.BINANCE_API_KEY, cfg.BINANCE_API_SECRET);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("binance poll failed", { error: String(e) });
    await alertApiFailureThrottled(String(e instanceof Error ? e.message : e));
    return 0;
  }

  const credits = txns.filter((t) => t.currency === "USDT" && Math.abs(parseFloat(t.amount)) > 0);
  let confirmed = 0;

  for (const order of pending) {
    if (!order.binanceAmount) continue;
    const want = parseFloat(order.binanceAmount);
    const match = credits.find((t) => Math.abs(Math.abs(parseFloat(t.amount)) - want) < 0.01);
    if (!match) continue;

    // One Binance transaction can settle only one order.
    const used = await prisma.order.findFirst({ where: { binanceTxnId: match.transactionId }, select: { id: true } });
    if (used) continue;
    const claimed = await prisma.order.updateMany({
      where: { id: order.id, status: "PENDING_PAYMENT" },
      data: { binanceTxnId: match.transactionId },
    });
    if (claimed.count === 0) continue;

    try {
      await confirmManualPayment(order.id);
      await enqueueAdminAlert(
        `✅ Binance auto-confirmed ${order.orderNumber} — ${order.binanceAmount} USDT (txn ${match.transactionId}).`,
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
  | { ok: false; reason: "NOT_FOUND" | "AMOUNT_MISMATCH" | "ALREADY_USED" | "NO_API" | "ORDER_NOT_PENDING" };

/**
 * Verify a specific Binance Pay transaction ID against an order and confirm it.
 * Used when the customer/admin pastes the transaction ID (e.g. auto-poll missed
 * it, or two orders shared a base amount). Requires the read-only API key; with
 * no key it returns { ok:false, reason:"NO_API" } so the caller can fall back.
 */
export async function verifyBinanceByTxnId(orderId: string, txnId: string): Promise<BinanceVerifyResult> {
  const cfg = loadConfig();
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { orderNumber: true, status: true, binanceAsset: true, binanceAmount: true },
  });
  if (!order) return { ok: false, reason: "NOT_FOUND" };
  if (order.status !== "PENDING_PAYMENT") return { ok: false, reason: "ORDER_NOT_PENDING" };

  const clean = txnId.trim();
  const dup = await prisma.order.findFirst({ where: { binanceTxnId: clean }, select: { id: true } });
  if (dup) return { ok: false, reason: "ALREADY_USED" };

  if (!cfg.BINANCE_API_KEY || !cfg.BINANCE_API_SECRET) return { ok: false, reason: "NO_API" };

  let txns: PayTxn[];
  try {
    txns = await fetchPayTransactions(cfg.BINANCE_API_KEY, cfg.BINANCE_API_SECRET);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("binance verify fetch failed", { error: String(e) });
    return { ok: false, reason: "NOT_FOUND" };
  }

  const txn = txns.find((t) => String(t.transactionId) === clean || String(t.orderId ?? "") === clean);
  if (!txn || txn.currency !== "USDT" || Math.abs(parseFloat(txn.amount)) <= 0) return { ok: false, reason: "NOT_FOUND" };

  const want = parseFloat(order.binanceAmount ?? "0");
  if (!(want > 0) || Math.abs(Math.abs(parseFloat(txn.amount)) - want) >= 0.01) return { ok: false, reason: "AMOUNT_MISMATCH" };

  const claimed = await prisma.order.updateMany({
    where: { id: orderId, status: "PENDING_PAYMENT" },
    data: { binanceTxnId: clean },
  });
  if (claimed.count === 0) return { ok: false, reason: "ORDER_NOT_PENDING" };

  await confirmManualPayment(orderId);
  await enqueueAdminAlert(`✅ Binance verified by txn ${clean} — ${order.orderNumber} (${order.binanceAmount} USDT).`);
  return { ok: true, orderNumber: order.orderNumber };
}
