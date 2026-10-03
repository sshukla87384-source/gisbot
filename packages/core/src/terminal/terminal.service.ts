import { prisma, type Currency } from "@gis/database";
import { CoreError, formatMinor, isCoreError, type CurrencyCode } from "@gis/shared";
import { enqueueAdminAlert, enqueueTelegramMessage } from "../queues.js";
import { usdtToMinor } from "../fx.js";
import { adjustWallet } from "../wallet/wallet.service.js";
import { confirmManualPayment } from "../orders/manual-pay.service.js";
import { clearChatClutter, clearPaymentPrompts } from "../orders/pay-prompt.service.js";
import { EvmUsdtAdapter } from "./chains/evm.js";
import { LitecoinAdapter } from "./chains/ltc.js";
import { SolanaAdapter } from "./chains/solana.js";
import { TonAdapter } from "./chains/ton.js";
import { TronUsdtAdapter } from "./chains/tron.js";
import { usdPrice } from "./prices.js";
import { hasTerminalSeed } from "./seed.js";
import type { ChainAdapter, GasInfo } from "./types.js";
import { fmtUnits, parseUnits } from "./types.js";

/**
 * The self-hosted crypto terminal. See seed.ts for the key model and the
 * chains/ folder for what each network does; this file is the lifecycle:
 *
 *   allocate  → a never-used address for one order / top-up
 *   poll      → watch every open payment; settle when enough has arrived
 *   sweep     → move settled funds to the operator's payout wallet
 *
 * Settlement goes through the same paths as every other rail
 * (confirmManualPayment / wallet credit), so delivery, receipts and chat
 * clean-up behave identically whichever way the customer paid.
 */

export const TERMINAL_CHAINS: readonly ChainAdapter[] = [
  new EvmUsdtAdapter("usdtbsc"),
  new TronUsdtAdapter(),
  new EvmUsdtAdapter("usdtmatic"),
  new TonAdapter(),
  new SolanaAdapter(),
  new LitecoinAdapter(),
];

export function terminalChain(code: string): ChainAdapter | null {
  return TERMINAL_CHAINS.find((c) => c.code === code) ?? null;
}

// ── Config ───────────────────────────────────────────────────────────────────

export interface TerminalConfig {
  /** Chains switched on by the admin. */
  enabled: string[];
  /** Payout (cold) address per chain code. */
  payout: Record<string, string>;
  /** Per-chain sweep floor in USD (defaults from the adapter). */
  sweepMinUsd: Record<string, number>;
  /** Underpayment tolerance, percent (stable / volatile). */
  toleranceStablePct: number;
  toleranceVolatilePct: number;
}

const CFG_KEY = "terminal.cfg";
const DEFAULT_CFG: TerminalConfig = { enabled: [], payout: {}, sweepMinUsd: {}, toleranceStablePct: 1, toleranceVolatilePct: 2.5 };
let cfgCache: { at: number; value: TerminalConfig } | null = null;

export async function getTerminalConfig(): Promise<TerminalConfig> {
  if (cfgCache && Date.now() - cfgCache.at < 15_000) return cfgCache.value;
  let value = DEFAULT_CFG;
  try {
    const row = await prisma.setting.findUnique({ where: { key: CFG_KEY } });
    const v = row?.value as Partial<TerminalConfig> | null | undefined;
    if (v && typeof v === "object") {
      value = {
        enabled: Array.isArray(v.enabled) ? v.enabled.map(String).filter((c) => terminalChain(c)) : [],
        payout: v.payout && typeof v.payout === "object" ? { ...v.payout } : {},
        sweepMinUsd: v.sweepMinUsd && typeof v.sweepMinUsd === "object" ? { ...v.sweepMinUsd } : {},
        toleranceStablePct: typeof v.toleranceStablePct === "number" ? v.toleranceStablePct : 1,
        toleranceVolatilePct: typeof v.toleranceVolatilePct === "number" ? v.toleranceVolatilePct : 2.5,
      };
    }
  } catch { /* defaults */ }
  cfgCache = { at: Date.now(), value };
  return value;
}

export async function setTerminalConfig(patch: Partial<TerminalConfig>): Promise<TerminalConfig> {
  const cur = await getTerminalConfig();
  const next: TerminalConfig = { ...cur, ...patch };
  const value = {
    enabled: [...next.enabled], payout: { ...next.payout }, sweepMinUsd: { ...next.sweepMinUsd },
    toleranceStablePct: next.toleranceStablePct, toleranceVolatilePct: next.toleranceVolatilePct,
  };
  await prisma.setting.upsert({ where: { key: CFG_KEY }, create: { key: CFG_KEY, value }, update: { value } });
  cfgCache = { at: Date.now(), value: next };
  return next;
}

export async function toggleTerminalChain(code: string): Promise<TerminalConfig> {
  const cur = await getTerminalConfig();
  const enabled = cur.enabled.includes(code) ? cur.enabled.filter((c) => c !== code) : [...cur.enabled, code];
  return setTerminalConfig({ enabled });
}

export async function setTerminalPayout(code: string, address: string): Promise<void> {
  const chain = terminalChain(code);
  if (!chain) throw new CoreError("VALIDATION_FAILED", "Unknown network");
  const addr = address.trim();
  if (!chain.validateAddress(addr)) throw new CoreError("VALIDATION_FAILED", `That is not a valid ${chain.chainLabel} address`);
  const cur = await getTerminalConfig();
  await setTerminalConfig({ payout: { ...cur.payout, [code]: addr } });
}

/** A chain the terminal will actually take payments on right now. */
export async function terminalHandles(code: string): Promise<boolean> {
  const chain = terminalChain(code);
  if (!chain) return false;
  if (!(await hasTerminalSeed())) return false;
  const cfg = await getTerminalConfig();
  return cfg.enabled.includes(code) && Boolean(cfg.payout[code]);
}

export async function terminalActiveChains(): Promise<ChainAdapter[]> {
  if (!(await hasTerminalSeed())) return [];
  const cfg = await getTerminalConfig();
  return TERMINAL_CHAINS.filter((c) => cfg.enabled.includes(c.code) && Boolean(cfg.payout[c.code]));
}

// ── Quotes & allocation ──────────────────────────────────────────────────────

/** How much of the asset a USD amount is right now, as units and a display string. */
export async function quoteTerminal(code: string, usd: number): Promise<{ units: bigint; amount: string; price: number }> {
  const chain = terminalChain(code);
  if (!chain) throw new CoreError("VALIDATION_FAILED", "Unknown network");
  const price = chain.stable ? 1 : await usdPrice(chain.priceId ?? "");
  const raw = usd / price;
  const amount = raw.toFixed(chain.quoteDecimals);
  const units = parseUnits(amount, chain.decimals);
  if (units <= 0n) throw new CoreError("VALIDATION_FAILED", "Amount too small for this network");
  return { units, amount: amount.replace(/\.?0+$/, "") || "0", price };
}

export interface TerminalAllocation {
  id: string;
  chain: string;
  address: string;
  /** Exact amount to send, display string. */
  amount: string;
  confirmations: number;
  expiresAt: Date;
}

/**
 * Reserve the next derivation slot on a chain for one payment. Slot 0 is the
 * main / gas address; payments start at 1. The (chain, index) unique key makes
 * two concurrent checkouts impossible to land on the same address.
 */
export async function allocateTerminalPayment(input: {
  kind: "ORDER" | "TOPUP";
  refId: string;
  userId: string;
  chain: string;
  usd: number;
  expiresAt: Date;
}): Promise<TerminalAllocation> {
  const chain = terminalChain(input.chain);
  if (!chain) throw new CoreError("VALIDATION_FAILED", "Unknown network");
  if (!(await terminalHandles(input.chain))) throw new CoreError("VALIDATION_FAILED", "That network is not enabled on the terminal");
  const q = await quoteTerminal(input.chain, input.usd);

  for (let attempt = 0; attempt < 5; attempt++) {
    const agg = await prisma.terminalPayment.aggregate({ where: { chain: input.chain }, _max: { index: true } });
    const index = Math.max(0, agg._max.index ?? 0) + 1;
    const address = await chain.address(index);
    try {
      const row = await prisma.terminalPayment.create({
        data: {
          kind: input.kind, refId: input.refId, userId: input.userId, chain: input.chain, index, address,
          expectedAmount: q.amount, expectedUsd: input.usd.toFixed(2), expiresAt: input.expiresAt,
        },
      });
      return { id: row.id, chain: input.chain, address, amount: q.amount, confirmations: chain.confirmations, expiresAt: input.expiresAt };
    } catch (e) {
      // P2002 on (chain, index): someone took the slot a moment ago — retry.
      if (!(e instanceof Error && "code" in e && (e as { code?: string }).code === "P2002")) throw e;
    }
  }
  throw new CoreError("VALIDATION_FAILED", "Could not reserve a payment address — please try again");
}

export async function terminalPaymentFor(kind: "ORDER" | "TOPUP", refId: string) {
  return prisma.terminalPayment.findFirst({ where: { kind, refId }, orderBy: { createdAt: "desc" } });
}

// ── Polling & settlement ─────────────────────────────────────────────────────

const SETTLED = ["PAID"];
const OPEN = ["WAITING", "CONFIRMING", "PARTIAL"];

function toleranceUnits(expected: bigint, chain: ChainAdapter, cfg: TerminalConfig): bigint {
  const pct = chain.stable ? cfg.toleranceStablePct : cfg.toleranceVolatilePct;
  return expected - (expected * BigInt(Math.round(pct * 100))) / 10_000n;
}

/** Look at one payment on-chain and advance its state. Returns the fresh row. */
export async function checkTerminalPayment(id: string) {
  const row = await prisma.terminalPayment.findUnique({ where: { id } });
  if (!row) throw new CoreError("VALIDATION_FAILED", "Payment not found");
  if (!OPEN.includes(row.status)) return row;
  const chain = terminalChain(row.chain);
  if (!chain) return row;
  const cfg = await getTerminalConfig();
  const expected = parseUnits(row.expectedAmount, chain.decimals);
  const enough = toleranceUnits(expected, chain, cfg);
  const scan = await chain.scan(row.address, row.index);
  const received = fmtUnits(scan.confirmed, chain.decimals);
  const pending = fmtUnits(scan.pending, chain.decimals);

  if (scan.confirmed >= enough) {
    const flipped = await prisma.terminalPayment.updateMany({
      where: { id, status: { in: OPEN } },
      data: { status: "PAID", receivedAmount: received, pendingAmount: "0", txids: scan.txids, paidAt: new Date(), lastCheckedAt: new Date(), sweepStatus: "PENDING", nextSweepAt: new Date() },
    });
    if (flipped.count > 0) await settle(row.id);
    return (await prisma.terminalPayment.findUnique({ where: { id } })) ?? row;
  }
  let status = row.status;
  if (scan.confirmed > 0n) status = "PARTIAL";
  else if (scan.pending > 0n) status = "CONFIRMING";
  else status = "WAITING";
  // Guarded: the poll and the customer's "Check payment" tap can race, and a
  // scan taken a moment before the other side flipped PAID must not write
  // the row back to open (which would settle it twice on the next tick).
  const upd = await prisma.terminalPayment.updateMany({
    where: { id, status: { in: OPEN } },
    data: { status, receivedAmount: received, pendingAmount: pending, txids: scan.txids, lastCheckedAt: new Date() },
  });
  const updated = (await prisma.terminalPayment.findUnique({ where: { id } })) ?? row;
  if (upd.count > 0 && status === "PARTIAL" && row.partialNotified !== received) await notifyPartial(updated.id, scan.confirmed, expected, chain);
  return updated;
}

async function notifyPartial(id: string, got: bigint, expected: bigint, chain: ChainAdapter): Promise<void> {
  const row = await prisma.terminalPayment.findUnique({ where: { id } });
  if (!row) return;
  const user = await prisma.user.findUnique({ where: { id: row.userId }, select: { telegramId: true } });
  const missing = expected - got;
  if (user?.telegramId != null && missing > 0n) {
    await enqueueTelegramMessage(
      user.telegramId,
      [
        `⚠️ <b>Payment received short</b>`,
        "",
        `Received <b>${fmtUnits(got, chain.decimals)} ${chain.asset}</b> of <b>${row.expectedAmount} ${chain.asset}</b>.`,
        `Send the remaining <b>${fmtUnits(missing, chain.decimals)} ${chain.asset}</b> to the <b>same address</b> and it completes automatically:`,
        `<code>${row.address}</code>`,
        "",
        "💡 Exchanges deduct a network fee from what you send — add it on top.",
      ].join("\n"),
    ).catch(() => undefined);
  }
  await prisma.terminalPayment.update({ where: { id }, data: { partialNotified: fmtUnits(got, chain.decimals) } });
}

/** Deliver the order / credit the wallet for a PAID terminal payment. */
async function settle(id: string): Promise<void> {
  const row = await prisma.terminalPayment.findUnique({ where: { id } });
  if (!row) return;
  const chain = terminalChain(row.chain);
  const label = `${row.receivedAmount} ${chain?.asset ?? row.chain} on ${chain?.chainLabel ?? row.chain}`;
  const user = await prisma.user.findUnique({ where: { id: row.userId }, select: { telegramId: true, currency: true } });

  if (row.kind === "ORDER") {
    try {
      await prisma.payment.updateMany({
        where: { orderId: row.refId, provider: "TERMINAL", status: { in: ["CREATED", "PENDING"] } },
        data: { status: "SUCCEEDED", capturedAt: new Date(), providerRef: row.txids[0] ?? row.address },
      });
      const r = await confirmManualPayment(row.refId);
      await enqueueAdminAlert(`🌐 Terminal payment confirmed — ${label} → order ${row.refId.slice(-6)} (${r.status}, ${r.delivered} delivered). Sweep queued.`).catch(() => undefined);
    } catch (e) {
      if (!(isCoreError(e) && e.code === "ORDER_NOT_FOUND")) {
        // Delivery itself failed (stock, DB…). The money is in; the admin
        // confirms the order by hand from the panel once the cause is fixed.
        await enqueueAdminAlert(`🚨 Terminal payment ${label} is IN for order ${row.refId.slice(-6)} but delivery failed: ${String(e instanceof Error ? e.message : e).slice(0, 160)}. Confirm it from the panel.`).catch(() => undefined);
        return;
      }
      // The order is gone (expired / cancelled) but the money is real: credit
      // the wallet with the USD value so nothing is lost, and tell both sides.
      const usd = Number(row.expectedUsd);
      const cur = (user?.currency ?? "USD") as Currency;
      const minor = usdtToMinor(usd.toFixed(2), cur);
      await adjustWallet({ userId: row.userId, amountMinor: BigInt(minor), type: "DEPOSIT", note: `Terminal payment after order closed (${label})`, idempotencyKey: `terminal-late:${row.id}` }).catch(() => undefined);
      if (user?.telegramId != null) {
        await enqueueTelegramMessage(
          user.telegramId,
          `ℹ️ Your ${chain?.asset ?? "crypto"} payment arrived after the order had closed, so <b>${formatMinor(minor, cur as CurrencyCode)}</b> has been added to your 💳 Wallet instead. You can place the order again and pay from the wallet instantly. 🙏`,
        ).catch(() => undefined);
      }
      await enqueueAdminAlert(`⚠️ Terminal payment landed late — ${label}; order ${row.refId.slice(-6)} was closed (${String(e instanceof Error ? e.message : e).slice(0, 80)}). Credited ${formatMinor(minor, cur as CurrencyCode)} to the customer's wallet.`).catch(() => undefined);
    }
    await clearPaymentPrompts(row.refId).catch(() => undefined);
  } else {
    const topup = await prisma.walletTopup.findUnique({ where: { id: row.refId } });
    if (topup) {
      const flipped = await prisma.walletTopup.updateMany({ where: { id: topup.id, status: "PENDING" }, data: { status: "CREDITED", creditedAt: new Date() } });
      if (flipped.count > 0) {
        const wallet = await prisma.wallet.findUnique({ where: { userId: topup.userId }, select: { currency: true } });
        const walletCur = (wallet?.currency ?? topup.currency) as Currency;
        const credit = walletCur === topup.currency ? topup.amountMinor : usdtToMinor(row.expectedUsd, walletCur);
        const bal = await adjustWallet({ userId: topup.userId, amountMinor: BigInt(credit), type: "DEPOSIT", note: `Crypto deposit (${label})`, idempotencyKey: `terminal-topup:${row.id}` });
        if (user?.telegramId != null) {
          await enqueueTelegramMessage(
            user.telegramId,
            `✅ <b>Wallet topped up!</b>\n\n💰 ${formatMinor(credit, walletCur as CurrencyCode)} added (${label}).\nNew balance: <b>${formatMinor(Number(bal), walletCur as CurrencyCode)}</b>. 🚀`,
          ).catch(() => undefined);
        }
        await enqueueAdminAlert(`💰 Terminal deposit credited — ${label} → ${formatMinor(credit, walletCur as CurrencyCode)} to user ${topup.userId.slice(-6)}. Sweep queued.`).catch(() => undefined);
      }
    }
  }
  if (user?.telegramId != null) await clearChatClutter(user.telegramId).catch(() => undefined);
}

/**
 * Cron: look at every open payment that can still be paid. Young payments are
 * checked every tick; ones past their window are checked less often for a
 * day, because late transfers do arrive and are credited to the wallet.
 */
export async function pollTerminalPayments(): Promise<number> {
  if (!(await hasTerminalSeed())) return 0;
  const now = Date.now();
  const rows = await prisma.terminalPayment.findMany({
    where: { status: { in: OPEN }, createdAt: { gte: new Date(now - 24 * 3600_000) } },
    orderBy: { createdAt: "asc" },
    take: 150,
  });
  let advanced = 0;
  for (const r of rows) {
    const late = r.expiresAt.getTime() < now;
    const lastAt = r.lastCheckedAt?.getTime() ?? 0;
    if (late && now - lastAt < 10 * 60_000) continue; // expired: every 10 min
    try {
      const before = r.status;
      const after = await checkTerminalPayment(r.id);
      if (after.status !== before) advanced++;
    } catch (e) {
      await prisma.terminalPayment.update({ where: { id: r.id }, data: { lastCheckedAt: new Date() } }).catch(() => undefined);
      // eslint-disable-next-line no-console
      console.warn("terminal poll failed", { id: r.id, chain: r.chain, error: String(e).slice(0, 200) });
    }
  }
  // Mark long-dead ones so they drop out of the active set.
  await prisma.terminalPayment.updateMany({
    where: { status: "WAITING", expiresAt: { lt: new Date(now - 24 * 3600_000) } },
    data: { status: "EXPIRED" },
  }).catch(() => undefined);
  return advanced;
}

// ── Sweeping ─────────────────────────────────────────────────────────────────

/**
 * Cron: move settled funds to the payout wallet. Also revisits PARTIAL and
 * EXPIRED slots that hold money (a short payment that was never completed),
 * so nothing is ever stranded on a payment address.
 */
export async function sweepTerminalPayments(limit = 10): Promise<number> {
  if (!(await hasTerminalSeed())) return 0;
  const cfg = await getTerminalConfig();
  const now = new Date();
  const stale = new Date(now.getTime() - 15 * 60_000);
  const rows = await prisma.terminalPayment.findMany({
    where: {
      OR: [
        { sweepStatus: { in: ["PENDING", "RETRY"] }, OR: [{ nextSweepAt: null }, { nextSweepAt: { lte: now } }] },
        // A sweep that claimed the row and never finished (process died mid-call).
        { sweepStatus: "SWEEPING", updatedAt: { lt: stale } },
        // Stranded money on slots the poll has STOPPED watching (its window is
        // 24 h). Sweeping a PARTIAL slot any earlier empties the address the
        // customer was just told to top up, and the balance-based chains then
        // never see the full amount arrive.
        {
          status: { in: ["PARTIAL", "EXPIRED"] }, sweepStatus: { in: ["NONE", "SKIPPED"] },
          createdAt: { lt: new Date(now.getTime() - 24 * 3600_000) },
          OR: [{ nextSweepAt: null }, { nextSweepAt: { lte: now } }], receivedAmount: { not: "0" },
        },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
  let swept = 0;
  for (const r of rows) {
    // Claim the row first: the worker's tick and an admin's "Sweep now" in
    // the bot process can overlap, and two full-balance transfers from one
    // address means the second one fails with the gas already spent.
    const claimed = await prisma.terminalPayment.updateMany({
      where: { id: r.id, sweepStatus: r.sweepStatus, updatedAt: r.updatedAt },
      data: { sweepStatus: "SWEEPING" },
    });
    if (claimed.count === 0) continue;
    const chain = terminalChain(r.chain);
    const payout = cfg.payout[r.chain];
    if (!chain || !payout) {
      await prisma.terminalPayment.update({ where: { id: r.id }, data: { sweepStatus: "RETRY", sweepError: "no payout address set", nextSweepAt: new Date(Date.now() + 3600_000) } });
      continue;
    }
    const minUsd = cfg.sweepMinUsd[r.chain] ?? chain.defaultSweepMinUsd;
    let minUnits = 0n;
    try {
      minUnits = (await quoteTerminal(r.chain, minUsd)).units;
    } catch { /* no price → no floor */ }
    try {
      const res = await chain.sweep(r.index, payout, minUnits);
      if (res.kind === "done") {
        swept++;
        await prisma.terminalPayment.update({ where: { id: r.id }, data: { sweepStatus: "DONE", sweepTxid: res.txid, sweepError: null, sweepAttempts: { increment: 1 }, nextSweepAt: null } });
        await enqueueAdminAlert(`🧹 Swept ${fmtUnits(res.amount, chain.decimals, chain.quoteDecimals)} ${chain.asset} (${chain.chainLabel}) → payout wallet.\n<code>${res.txid}</code>`).catch(() => undefined);
      } else if (res.kind === "pending") {
        await prisma.terminalPayment.update({ where: { id: r.id }, data: { sweepStatus: "RETRY", sweepError: res.note.slice(0, 300), sweepAttempts: { increment: 1 }, nextSweepAt: new Date(Date.now() + 2 * 60_000) } });
        if (res.note.includes("needs")) await gasAlertThrottled(r.chain, res.note);
      } else {
        await prisma.terminalPayment.update({ where: { id: r.id }, data: { sweepStatus: "SKIPPED", sweepError: res.note.slice(0, 300), nextSweepAt: new Date(Date.now() + 6 * 3600_000) } });
      }
    } catch (e) {
      const attempts = r.sweepAttempts + 1;
      const backoffMin = Math.min(6 * 60, 5 * 2 ** Math.min(attempts, 6));
      await prisma.terminalPayment.update({ where: { id: r.id }, data: { sweepStatus: "RETRY", sweepError: String(e instanceof Error ? e.message : e).slice(0, 300), sweepAttempts: attempts, nextSweepAt: new Date(Date.now() + backoffMin * 60_000) } });
      if (attempts === 3) await enqueueAdminAlert(`⚠️ Sweep keeps failing on ${chain.chainLabel} slot ${r.index}: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`).catch(() => undefined);
    }
  }
  return swept;
}

const gasAlertAt: Record<string, number> = {};
async function gasAlertThrottled(chain: string, note: string): Promise<void> {
  const last = gasAlertAt[chain] ?? 0;
  if (Date.now() - last < 6 * 3600_000) return;
  gasAlertAt[chain] = Date.now();
  await enqueueAdminAlert(`⛽ Terminal needs gas — ${note}`).catch(() => undefined);
}

/** Admin: force a sweep pass now. */
export async function sweepTerminalNow(): Promise<number> {
  await prisma.terminalPayment.updateMany({ where: { sweepStatus: { in: ["RETRY", "SKIPPED"] } }, data: { nextSweepAt: new Date() } });
  return sweepTerminalPayments(25);
}

// ── Admin views ──────────────────────────────────────────────────────────────

export async function terminalGasReport(): Promise<Array<GasInfo & { chain: string }>> {
  const out: Array<GasInfo & { chain: string }> = [];
  const seen = new Set<string>();
  for (const c of TERMINAL_CHAINS) {
    try {
      const g = await c.gas();
      if (!g) continue;
      const key = `${g.address}:${g.symbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...g, chain: c.code });
    } catch (e) {
      out.push({ chain: c.code, address: "?", symbol: c.asset, balance: "?", low: false, hint: `could not read: ${String(e).slice(0, 80)}` });
    }
  }
  return out;
}

export async function terminalStats(): Promise<{ open: number; paid24h: number; unswept: number; usd24h: number }> {
  const since = new Date(Date.now() - 24 * 3600_000);
  const [open, paid, unswept] = await Promise.all([
    prisma.terminalPayment.count({ where: { status: { in: OPEN }, expiresAt: { gt: new Date() } } }),
    prisma.terminalPayment.findMany({ where: { status: { in: SETTLED }, paidAt: { gte: since } }, select: { expectedUsd: true } }),
    prisma.terminalPayment.count({ where: { sweepStatus: { in: ["PENDING", "RETRY", "SWEEPING"] } } }),
  ]);
  return { open, paid24h: paid.length, unswept, usd24h: paid.reduce((s, p) => s + Number(p.expectedUsd), 0) };
}

export async function recentTerminalPayments(limit = 10) {
  return prisma.terminalPayment.findMany({ orderBy: { createdAt: "desc" }, take: limit });
}
