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

/** Auto-confirm can be turned off entirely (then only a pasted Order ID settles an order). */
export async function isBinanceAutoConfirmEnabled(): Promise<boolean> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: "binance.autoConfirm" } });
    const v = row?.value as { enabled?: boolean } | null | undefined;
    return v?.enabled !== false;
  } catch {
    return true;
  }
}

export async function setBinanceAutoConfirm(enabled: boolean): Promise<void> {
  await prisma.setting.upsert({
    where: { key: "binance.autoConfirm" },
    create: { key: "binance.autoConfirm", value: { enabled } },
    update: { value: { enabled } },
  });
}

/** Amounts are quoted to the cent, so a settling credit must match to the cent. */
const CENT = 0.005;

/** Alert admins about an ambiguous credit at most once an hour per amount. */
async function alertAmbiguousThrottled(amount: string, count: number): Promise<void> {
  try {
    const first = await getRedis().set(`binance:ambig:${amount}`, "1", "EX", 3600, "NX");
    if (first) {
      await enqueueAdminAlert(
        `⚠️ <b>Binance credit not auto-confirmed</b>\n${amount} USDT matches ${count} pending orders, so it is impossible to tell whose payment it is.\nOpen the order and use 🔎 <b>Verify by Order ID</b> to settle the right one.`,
      );
    }
  } catch { /* ignore */ }
}

/**
 * Poll Binance Pay history and auto-confirm any PENDING_PAYMENT Binance order
 * whose exact USDT amount has arrived. Uses a READ-ONLY API key; never moves
 * funds.
 *
 * A credit may settle an order only if ALL of these hold:
 *   1. it arrived AFTER the order was created (a payment cannot precede its
 *      order — this is what stops old history, including already-credited
 *      wallet top-ups and admin-approved payments, from buying free goods);
 *   2. it is not already recorded against another order OR a wallet top-up;
 *   3. exactly ONE pending order expects that amount (otherwise we cannot know
 *      whose money it is, and the admin is asked to settle it by Order ID);
 *   4. the amount matches to the cent.
 * The claim itself is decided by the database via the @unique binanceTxnId.
 */
export async function pollBinancePayments(): Promise<number> {
  if (!(await isBinanceAutoConfirmEnabled())) return 0;
  const creds = await getBinanceCreds();
  if (!creds) return 0;

  const pending = await prisma.order.findMany({
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

  let credits = txns.filter((t) => t.currency === "USDT" && parseFloat(t.amount) > 0); // incoming only
  if (credits.length === 0) return 0;

  // A transaction that has ALREADY paid for something — another order, or a
  // wallet top-up — must never settle a second thing. The top-up half of this
  // check was missing, so a customer could top their wallet up with 10 USDT,
  // keep the balance, and have that same credit silently deliver a 10 USDT
  // order for free.
  const ids = credits.map((t) => String(t.transactionId));
  const [usedOrders, usedTopups] = await Promise.all([
    prisma.order.findMany({ where: { binanceTxnId: { in: ids } }, select: { binanceTxnId: true } }),
    prisma.walletTopup.findMany({ where: { binanceTxnId: { in: ids } }, select: { binanceTxnId: true } }),
  ]);
  const spent = new Set<string>([
    ...usedOrders.map((o) => o.binanceTxnId ?? ""),
    ...usedTopups.map((t) => t.binanceTxnId ?? ""),
  ]);
  credits = credits.filter((t) => !spent.has(String(t.transactionId)));
  if (credits.length === 0) return 0;

  // How many pending orders expect each amount — used for the ambiguity guard.
  const expecting = (amount: number): number =>
    pending.filter((o) => o.binanceAmount && Math.abs(parseFloat(o.binanceAmount) - amount) < CENT).length;

  let confirmed = 0;

  for (const order of pending) {
    if (!order.binanceAmount) continue;
    const want = parseFloat(order.binanceAmount);
    if (!(want > 0)) continue;

    // The payment must be newer than the order. 60 s of slack absorbs clock
    // skew between the VPS and Binance, nothing more.
    const notBefore = order.createdAt.getTime() - 60_000;
    const match = credits.find(
      (t) => Math.abs(parseFloat(t.amount) - want) < CENT && Number(t.transactionTime) >= notBefore,
    );
    if (!match) continue;

    // Two customers owing the identical amount is not something a bank transfer
    // can disambiguate. Settling "the oldest" is a coin flip that delivers one
    // person's goods against another person's money, so refuse and escalate.
    const rivals = expecting(parseFloat(match.amount));
    if (rivals > 1) {
      await alertAmbiguousThrottled(order.binanceAmount, rivals);
      continue;
    }

    let claimedOk = false;
    try {
      const claimed = await prisma.order.updateMany({
        where: { id: order.id, status: "PENDING_PAYMENT", binanceTxnId: null },
        data: { binanceTxnId: match.transactionId },
      });
      claimedOk = claimed.count > 0;
    } catch {
      claimedOk = false; // unique violation: this txn already settled something
    }
    if (!claimedOk) continue;

    // A top-up verification running concurrently could have taken this same
    // credit between our check above and the claim. Re-read, and hand it back
    // if we lost — the customer keeps the wallet credit, the order stays open.
    const topupRace = await prisma.walletTopup.findFirst({
      where: { binanceTxnId: String(match.transactionId) },
      select: { id: true },
    });
    if (topupRace) {
      await prisma.order
        .updateMany({ where: { id: order.id, status: "PENDING_PAYMENT" }, data: { binanceTxnId: null } })
        .catch(() => undefined);
      continue;
    }

    credits = credits.filter((c) => c !== match);

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
  // A transaction already spent on another order OR on a wallet top-up cannot
  // pay for this one. The top-up half was missing, which made every credited
  // top-up reusable as free payment for an order of the same size.
  const [dupOrder, dupTopup] = await Promise.all([
    prisma.order.findFirst({ where: { binanceTxnId: clean }, select: { id: true } }),
    prisma.walletTopup.findFirst({ where: { binanceTxnId: clean }, select: { id: true } }),
  ]);
  if (dupOrder || dupTopup) return { ok: false, reason: "ALREADY_USED" };

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

  // A payment cannot predate the order it pays for.
  if (Number(txn.transactionTime) < order.createdAt.getTime() - 60_000) return { ok: false, reason: "TOO_OLD" };

  const want = parseFloat(order.binanceAmount ?? "0");
  if (!(want > 0) || Math.abs(parseFloat(txn.amount) - want) >= CENT) return { ok: false, reason: "AMOUNT_MISMATCH" };

  let claimed: { count: number };
  try {
    claimed = await prisma.order.updateMany({
      where: { id: orderId, status: "PENDING_PAYMENT", binanceTxnId: null },
      data: { binanceTxnId: clean },
    });
  } catch {
    return { ok: false, reason: "ALREADY_USED" }; // unique violation, lost the race
  }
  if (claimed.count === 0) return { ok: false, reason: "ORDER_NOT_PENDING" };

  await confirmManualPayment(orderId);
  await enqueueAdminAlert(`✅ Binance verified by txn ${clean} — ${order.orderNumber} (${order.binanceAmount} USDT).`);
  return { ok: true, orderNumber: order.orderNumber };
}
