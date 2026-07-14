import { loadConfig } from "@gis/config";
import { prisma } from "@gis/database";
import { createHmac } from "node:crypto";
import { enqueueAdminAlert } from "../queues.js";
import { confirmManualPayment } from "./manual-pay.service.js";

const BINANCE_BASE = "https://api.binance.com";

interface PayTxn {
  transactionId: string;
  transactionTime: number;
  amount: string; // signed decimal string; positive = incoming credit
  currency: string; // asset code, e.g. "USDT"
  orderType?: string;
}

function sign(query: string, secret: string): string {
  return createHmac("sha256", secret).update(query).digest("hex");
}

/** Signed GET of the account's Binance Pay transaction history (read-only). */
async function fetchPayTransactions(apiKey: string, apiSecret: string): Promise<PayTxn[]> {
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
    return 0;
  }

  const credits = txns.filter((t) => t.currency === "USDT" && parseFloat(t.amount) > 0);
  let confirmed = 0;

  for (const order of pending) {
    if (!order.binanceAmount) continue;
    const want = parseFloat(order.binanceAmount);
    const match = credits.find((t) => Math.abs(parseFloat(t.amount) - want) < 0.00005);
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
