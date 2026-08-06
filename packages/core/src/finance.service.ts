import { prisma } from "@gis/database";
import type { Currency } from "@gis/database";
import { convertMinor, priceUsdFromInr } from "./fx.js";

/**
 * Money truth for the operator.
 *
 * Two questions this file answers, neither of which the bot could answer before:
 *   1. Am I actually making money?  (cost, margin, loss-making products)
 *   2. Do I hold what I owe?        (wallet liability vs money taken in)
 *
 * Costs live in USD minor units everywhere, so a single currency runs through
 * the whole calculation and nothing is compared across scales by accident.
 * Revenue is converted to USD with `convertMinor` (exact — never the price
 * surcharge, which is a pricing decision, not money received).
 */

const MARGIN_SETTING = "finance.margin_floor_bp";
export const MARGIN_FLOOR_BP_DEFAULT = 1_000; // 10%

export async function getMarginFloorBp(): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: MARGIN_SETTING } }).catch(() => null);
  const v = row?.value as { bp?: number } | null;
  const bp = typeof v?.bp === "number" ? v.bp : MARGIN_FLOOR_BP_DEFAULT;
  return Math.max(0, Math.min(9_000, Math.round(bp)));
}

export async function setMarginFloorBp(bp: number): Promise<number> {
  const clean = Math.max(0, Math.min(9_000, Math.round(bp)));
  await prisma.setting.upsert({
    where: { key: MARGIN_SETTING },
    create: { key: MARGIN_SETTING, value: { bp: clean } as never },
    update: { value: { bp: clean } as never },
  });
  return clean;
}

/** What you pay per unit. Set on the variant; individual stock rows may override. */
export async function setVariantCost(variantId: string, costMinorUsd: number | null): Promise<void> {
  await prisma.productVariant.update({
    where: { id: variantId },
    data: { defaultCostMinor: costMinorUsd === null ? null : Math.max(0, Math.round(costMinorUsd)) },
  });
}

/** Cost of the unit about to be delivered: the stock row's own cost, else the variant default. */
export async function costForVariant(variantId: string, stockCostMinor: number | null): Promise<number | null> {
  if (stockCostMinor !== null && stockCostMinor !== undefined) return stockCostMinor;
  const v = await prisma.productVariant.findUnique({ where: { id: variantId }, select: { defaultCostMinor: true } }).catch(() => null);
  return v?.defaultCostMinor ?? null;
}

export interface ProfitRow {
  productId: string;
  name: string;
  units: number;
  revenueMinor: number;
  costMinor: number;
  profitMinor: number;
  marginBp: number | null;
  /** Units delivered with no cost recorded — the margin above ignores them. */
  unpriced: number;
}

export interface ProfitReport {
  days: number;
  revenueMinor: number;
  costMinor: number;
  profitMinor: number;
  marginBp: number | null;
  units: number;
  unpricedUnits: number;
  rows: ProfitRow[];
  /** Sales where the cost was HIGHER than what we charged. */
  lossMakers: Array<{ name: string; revenueMinor: number; costMinor: number; units: number }>;
}

/**
 * Profit for the last N days, from delivered items only — an unpaid or expired
 * order has earned nothing, so counting it would flatter the numbers.
 */
export async function profitReport(days = 30): Promise<ProfitReport> {
  const since = new Date(Date.now() - days * 86_400_000);
  const items = await prisma.orderItem.findMany({
    // Exclude replacement bookkeeping orders. They carry zero revenue, and the
    // replacement's cost was ALREADY added to the original sale — counting them
    // here charged every replacement twice and pushed good products into
    // lossMakers.
    where: {
      fulfilledAt: { gte: since },
      order: { status: { in: ["COMPLETED", "PAID", "PENDING_FULFILLMENT", "PARTIALLY_REFUNDED"] }, replacementOfOrderId: null },
    },
    select: {
      quantity: true,
      totalMinor: true,
      costMinor: true,
      productNameSnap: true,
      order: { select: { currency: true, discountMinor: true, subtotalMinor: true } },
      variant: { select: { productId: true, defaultCostMinor: true } },
    },
    take: 20_000,
  });

  const byProduct = new Map<string, ProfitRow>();
  let revenue = 0;
  let cost = 0;
  let units = 0;
  let unpricedUnits = 0;

  for (const it of items) {
    // OrderItem.totalMinor is the pre-discount line price; a coupon lives on the
    // ORDER. Without apportioning it, a Rs 400 coupon showed up as Rs 400 of
    // phantom profit and lossMakers could never catch a coupon selling below
    // cost. Split the discount across lines in proportion to their value.
    const gross = it.totalMinor;
    const sub = it.order.subtotalMinor;
    const disc = it.order.discountMinor ?? 0;
    const net = disc > 0 && sub > 0 ? Math.max(0, gross - Math.round((disc * gross) / sub)) : gross;
    const rev = convertMinor(net, it.order.currency as Currency, "USD");
    // Prefer the snapshot; fall back to the variant's current cost for older rows
    // delivered before cost tracking existed, so history is not simply blank.
    const unit = it.costMinor ?? it.variant.defaultCostMinor ?? null;
    const c = unit === null ? null : unit * Math.max(1, it.quantity);
    const key = it.variant.productId;
    const row = byProduct.get(key) ?? {
      productId: key,
      name: it.productNameSnap,
      units: 0,
      revenueMinor: 0,
      costMinor: 0,
      profitMinor: 0,
      marginBp: null,
      unpriced: 0,
    };
    row.units += it.quantity;
    row.revenueMinor += rev;
    units += it.quantity;
    revenue += rev;
    if (c === null) {
      row.unpriced += it.quantity;
      unpricedUnits += it.quantity;
    } else {
      row.costMinor += c;
      cost += c;
    }
    byProduct.set(key, row);
  }

  for (const row of byProduct.values()) {
    row.profitMinor = row.revenueMinor - row.costMinor;
    row.marginBp = row.revenueMinor > 0 && row.unpriced < row.units ? Math.round((row.profitMinor / row.revenueMinor) * 10_000) : null;
  }

  const rows = [...byProduct.values()].sort((a, b) => b.profitMinor - a.profitMinor);
  return {
    days,
    revenueMinor: revenue,
    costMinor: cost,
    profitMinor: revenue - cost,
    marginBp: revenue > 0 ? Math.round(((revenue - cost) / revenue) * 10_000) : null,
    units,
    unpricedUnits,
    rows,
    lossMakers: rows
      .filter((r) => r.unpriced === 0 && r.costMinor > r.revenueMinor)
      .map((r) => ({ name: r.name, revenueMinor: r.revenueMinor, costMinor: r.costMinor, units: r.units })),
  };
}

export interface ThinMarginRow {
  variantId: string;
  productId: string;
  name: string;
  priceMinor: number;
  costMinor: number;
  marginBp: number;
  belowFloor: boolean;
  underwater: boolean;
}

/**
 * Live check on the price LIST, not on history: which active products would sell
 * below the margin floor right now. This is the one that catches a supplier
 * price rise before it costs you anything.
 */
export async function thinMarginProducts(): Promise<{ floorBp: number; rows: ThinMarginRow[]; noCost: number }> {
  const floorBp = await getMarginFloorBp();
  const variants = await prisma.productVariant.findMany({
    where: { isActive: true, product: { status: "ACTIVE", deletedAt: null } },
    select: {
      id: true,
      name: true,
      defaultCostMinor: true,
      product: { select: { id: true, name: true } },
      prices: { where: { tier: { name: "RETAIL" } }, select: { amountMinor: true, currency: true } },
    },
    take: 2_000,
  });

  const rows: ThinMarginRow[] = [];
  let noCost = 0;
  for (const v of variants) {
    if (v.defaultCostMinor === null || v.defaultCostMinor === undefined) { noCost++; continue; }
    // Compare against the CHEAPEST way a customer can buy it — the worst case.
    const usdPrices = v.prices
      // priceUsdFromInr removes the INR surcharge. convertMinor would leave it
      // in, making every INR-priced product look ~5% healthier than it is and
      // letting it slip past the floor.
      .map((p) => (p.currency === "INR" ? priceUsdFromInr(p.amountMinor) : convertMinor(p.amountMinor, p.currency as Currency, "USD")))
      .filter((n) => n > 0);
    if (usdPrices.length === 0) continue;
    const priceMinor = Math.min(...usdPrices);
    const marginBp = Math.round(((priceMinor - v.defaultCostMinor) / priceMinor) * 10_000);
    if (marginBp >= floorBp) continue;
    rows.push({
      variantId: v.id,
      productId: v.product.id,
      name: `${v.product.name}${v.name.trim().toLowerCase() === "standard" ? "" : ` · ${v.name}`}`,
      priceMinor,
      costMinor: v.defaultCostMinor,
      marginBp,
      belowFloor: true,
      underwater: v.defaultCostMinor >= priceMinor,
    });
  }
  rows.sort((a, b) => a.marginBp - b.marginBp);
  return { floorBp, rows, noCost };
}

// ───────────────────────────── Daily reconciliation ─────────────────────────────

export interface Reconciliation {
  /** Customer money you are holding and owe them. Sum of all wallet balances. */
  walletLiabilityMinorUsd: number;
  walletCount: number;
  /** Ledger totals for the window, in USD. */
  depositsMinor: number;
  purchasesMinor: number;
  refundsMinor: number;
  /** Free money you granted (spins, referrals, cashback, manual adjustments). */
  grantsMinor: number;
  /** Top-ups sitting unpaid — potential revenue, not money you hold. */
  topupsPendingMinor: number;
  topupsPendingCount: number;
  /** Orders paid but with items still undelivered — your obligation right now. */
  unfulfilledPaidOrders: number;
  unfulfilledPaidValueMinor: number;
  /** Orders that expired unpaid in the window — lost sales. */
  expiredOrders: number;
  expiredValueMinor: number;
  /**
   * Ledger cross-check: wallet balance rows should equal the sum of their
   * ledger entries. A mismatch means the cached balance drifted, which is the
   * one bug in a wallet system you want to hear about immediately.
   */
  driftWallets: number;
  driftMinor: number;
  hours: number;
}

export async function reconcile(hours = 24): Promise<Reconciliation> {
  const since = new Date(Date.now() - hours * 3_600_000);

  const wallets = await prisma.wallet.findMany({ select: { id: true, currency: true, balanceMinor: true }, take: 200_000 });
  let liability = 0;
  for (const w of wallets) liability += convertMinor(Number(w.balanceMinor), w.currency as Currency, "USD");

  // Aggregate in the DATABASE. Pulling up to 50_000 rows to sum them in JS also
  // silently truncated: past 50k transactions in the window the totals were
  // simply wrong with nothing to say so.
  const grouped = await prisma.walletTransaction.groupBy({
    by: ["type", "currency"],
    where: { createdAt: { gte: since } },
    _sum: { amountMinor: true },
  });
  let deposits = 0;
  let purchases = 0;
  let refunds = 0;
  let grants = 0;
  for (const g of grouped) {
    const usd = convertMinor(Number(g._sum.amountMinor ?? 0), g.currency as Currency, "USD");
    if (g.type === "DEPOSIT") deposits += usd;
    else if (g.type === "PURCHASE") purchases += Math.abs(usd);
    else if (g.type === "REFUND" || g.type === "REVERSAL") refunds += Math.abs(usd);
    else if (g.type === "CASHBACK" || g.type === "REFERRAL_REWARD" || g.type === "ADJUSTMENT") grants += usd;
  }

  const pendingTopups = await prisma.walletTopup.findMany({
    where: { status: "PENDING", expiresAt: { gt: new Date() } },
    select: { amountMinor: true, currency: true },
    take: 5_000,
  });
  const topupsPendingMinor = pendingTopups.reduce((n, t) => n + convertMinor(t.amountMinor, t.currency as Currency, "USD"), 0);

  // A wallet-paid order stores totalMinor 0 with the money in walletUsedMinor,
  // so valuing these by totalMinor alone reported "$0.00 owed" while real paid
  // orders sat undelivered. Value = wallet + gateway.
  const unfulfilled = await prisma.order.findMany({
    where: {
      status: { in: ["PAID", "PENDING_FULFILLMENT", "AWAITING_STOCK"] },
      items: { some: { fulfilledAt: null } },
      replacementOfOrderId: null,
    },
    select: { totalMinor: true, walletUsedMinor: true, currency: true },
    take: 2_000,
  });

  const expired = await prisma.order.findMany({
    where: { status: { in: ["EXPIRED", "CANCELLED"] }, createdAt: { gte: since } },
    select: { totalMinor: true, walletUsedMinor: true, currency: true },
    take: 5_000,
  });

  // Cached balance vs the ledger it is derived from — in ONE statement with
  // HAVING, so only the mismatching rows cross the wire. The previous version
  // aggregated the entire ledger with no WHERE clause and summed it in JS, which
  // got slower every day forever.
  const drift = await prisma.$queryRaw<Array<{ id: string; currency: string; diff: bigint }>>`
    SELECT w."id", w."currency", (w."balanceMinor" - COALESCE(SUM(t."amountMinor"), 0)) AS "diff"
    FROM "Wallet" w
    LEFT JOIN "WalletTransaction" t ON t."walletId" = w."id"
    GROUP BY w."id", w."currency", w."balanceMinor"
    HAVING w."balanceMinor" <> COALESCE(SUM(t."amountMinor"), 0)
    LIMIT 500`;
  let driftWallets = drift.length;
  let driftMinor = 0;
  for (const d of drift) driftMinor += convertMinor(Number(d.diff), d.currency as Currency, "USD");

  return {
    walletLiabilityMinorUsd: liability,
    walletCount: wallets.length,
    depositsMinor: deposits,
    purchasesMinor: purchases,
    refundsMinor: refunds,
    grantsMinor: grants,
    topupsPendingMinor,
    topupsPendingCount: pendingTopups.length,
    unfulfilledPaidOrders: unfulfilled.length,
    unfulfilledPaidValueMinor: unfulfilled.reduce((n, o) => n + convertMinor(o.totalMinor + o.walletUsedMinor, o.currency as Currency, "USD"), 0),
    expiredOrders: expired.length,
    expiredValueMinor: expired.reduce((n, o) => n + convertMinor(o.totalMinor + o.walletUsedMinor, o.currency as Currency, "USD"), 0),
    driftWallets,
    driftMinor,
    hours,
  };
}

// ─────────────────────── Delivery quality / failure rate ───────────────────────

const QUALITY_SETTING = "quality.autopause";

export interface QualityConfig {
  /** Pause a product automatically, or only flag it for a human? */
  autoPause: boolean;
  /** Failure rate (basis points) at which a product is considered bad. */
  thresholdBp: number;
  /** Don't judge a product until it has this many deliveries — small samples lie. */
  minDeliveries: number;
  /** Window to measure over. */
  days: number;
}

const QUALITY_DEFAULT: QualityConfig = { autoPause: false, thresholdBp: 2_500, minDeliveries: 5, days: 14 };

export async function getQualityConfig(): Promise<QualityConfig> {
  const row = await prisma.setting.findUnique({ where: { key: QUALITY_SETTING } }).catch(() => null);
  const v = (row?.value ?? {}) as Partial<QualityConfig>;
  return {
    autoPause: typeof v.autoPause === "boolean" ? v.autoPause : QUALITY_DEFAULT.autoPause,
    thresholdBp: typeof v.thresholdBp === "number" ? v.thresholdBp : QUALITY_DEFAULT.thresholdBp,
    minDeliveries: typeof v.minDeliveries === "number" ? v.minDeliveries : QUALITY_DEFAULT.minDeliveries,
    days: typeof v.days === "number" ? v.days : QUALITY_DEFAULT.days,
  };
}

export async function saveQualityConfig(patch: Partial<QualityConfig>): Promise<QualityConfig> {
  const next = { ...(await getQualityConfig()), ...patch };
  await prisma.setting.upsert({
    where: { key: QUALITY_SETTING },
    create: { key: QUALITY_SETTING, value: next as never },
    update: { value: next as never },
  });
  return next;
}

export interface QualityRow {
  productId: string;
  name: string;
  supplierId: string | null;
  delivered: number;
  complaints: number;
  rateBp: number;
  bad: boolean;
  paused: boolean;
}

/**
 * Complaint rate per product: replacement requests plus support tickets raised
 * against delivered items. A dead batch shows up here after two complaints
 * instead of twenty, which is the whole point.
 */
export async function qualityReport(): Promise<{ cfg: QualityConfig; rows: QualityRow[] }> {
  const cfg = await getQualityConfig();
  const since = new Date(Date.now() - cfg.days * 86_400_000);

  const delivered = await prisma.orderItem.findMany({
    // Shadow replacement items would count as extra clean deliveries and dilute
    // the very failure rate this report exists to surface.
    where: { fulfilledAt: { gte: since }, order: { replacementOfOrderId: null } },
    select: { id: true, productNameSnap: true, variant: { select: { productId: true, product: { select: { supplierId: true, status: true, name: true } } } } },
    take: 20_000,
  });
  if (delivered.length === 0) return { cfg, rows: [] };

  const itemIds = delivered.map((d) => d.id);
  const [reps, tickets] = await Promise.all([
    prisma.replacementRequest.findMany({ where: { orderItemId: { in: itemIds } }, select: { orderItemId: true } }),
    prisma.supportTicket.findMany({ where: { orderItemId: { in: itemIds } }, select: { orderItemId: true } }),
  ]);
  // One complaint per item, however many ways they complained.
  const complained = new Set<string>([...reps.map((r) => r.orderItemId), ...tickets.map((t) => t.orderItemId ?? "")]);

  const map = new Map<string, QualityRow>();
  for (const d of delivered) {
    const pid = d.variant.productId;
    const row = map.get(pid) ?? {
      productId: pid,
      name: d.variant.product.name || d.productNameSnap,
      supplierId: d.variant.product.supplierId,
      delivered: 0,
      complaints: 0,
      rateBp: 0,
      bad: false,
      paused: d.variant.product.status !== "ACTIVE",
    };
    row.delivered++;
    if (complained.has(d.id)) row.complaints++;
    map.set(pid, row);
  }

  const rows = [...map.values()].map((r) => {
    const rateBp = r.delivered > 0 ? Math.round((r.complaints / r.delivered) * 10_000) : 0;
    return { ...r, rateBp, bad: r.delivered >= cfg.minDeliveries && rateBp >= cfg.thresholdBp };
  });
  rows.sort((a, b) => b.rateBp - a.rateBp || b.delivered - a.delivered);
  return { cfg, rows };
}

/**
 * Run by cron. Flags bad products to the admins, and pauses them only if the
 * operator switched auto-pause on — silently hiding someone's best seller
 * because of a threshold would be worse than the complaints.
 */
export async function runQualitySweep(): Promise<{ flagged: number; paused: number }> {
  const { cfg, rows } = await qualityReport();
  const bad = rows.filter((r) => r.bad && !r.paused);
  if (bad.length === 0) return { flagged: 0, paused: 0 };

  let paused = 0;
  if (cfg.autoPause) {
    for (const r of bad) {
      await prisma.product.update({ where: { id: r.productId }, data: { status: "PAUSED" } }).catch(() => undefined);
      paused++;
    }
  }
  return { flagged: bad.length, paused };
}
