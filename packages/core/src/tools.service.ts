import { prisma } from "@gis/database";
import { loadConfig } from "@gis/config";
import { sha256Hex, normalizeLicenseKey } from "@gis/shared";
import { priceInrFromUsd, inrSurchargeBp, usdtRate } from "./fx.js";
import { invalidate } from "./redis.js";

/* ── 1. Bulk price tools ──────────────────────────────────────────────────── */

export interface PriceChange { productId: string; name: string; usdMinor: number; oldInrMinor: number | null; newInrMinor: number }

/**
 * Re-derive every INR price from its USD price at the current rate + surcharge.
 * Always call with dryRun first — the preview is the point.
 */
export async function rederiveInrPrices(dryRun = true, categoryId?: string): Promise<{ changes: PriceChange[]; applied: number }> {
  const retail = await prisma.priceTier.findUniqueOrThrow({ where: { name: "RETAIL" } });
  const products = await prisma.product.findMany({
    where: { deletedAt: null, ...(categoryId ? { categoryId } : {}) },
    select: {
      id: true, name: true,
      variants: { where: { deletedAt: null }, select: { id: true, prices: { where: { tierId: retail.id }, select: { currency: true, amountMinor: true } } } },
    },
  });
  const changes: PriceChange[] = [];
  for (const p of products) {
    for (const v of p.variants) {
      const usd = v.prices.find((x) => x.currency === "USD")?.amountMinor;
      if (!usd || usd <= 0) continue;
      const oldInr = v.prices.find((x) => x.currency === "INR")?.amountMinor ?? null;
      const newInr = priceInrFromUsd(usd);
      if (oldInr === newInr) continue;
      changes.push({ productId: p.id, name: p.name, usdMinor: usd, oldInrMinor: oldInr, newInrMinor: newInr });
      if (!dryRun) {
        await prisma.variantPrice.upsert({
          where: { variantId_tierId_currency: { variantId: v.id, tierId: retail.id, currency: "INR" } },
          create: { variantId: v.id, tierId: retail.id, currency: "INR", amountMinor: newInr },
          update: { amountMinor: newInr },
        });
      }
    }
  }
  if (!dryRun && changes.length > 0) await invalidate("cat:*");
  return { changes, applied: dryRun ? 0 : changes.length };
}

/** Apply ±pct to every price (both currencies). Dry-run by default. */
export async function bulkAdjustPrices(pct: number, dryRun = true, categoryId?: string): Promise<{ changed: number; sample: string[] }> {
  const retail = await prisma.priceTier.findUniqueOrThrow({ where: { name: "RETAIL" } });
  const rows = await prisma.variantPrice.findMany({
    where: { tierId: retail.id, variant: { deletedAt: null, product: { deletedAt: null, ...(categoryId ? { categoryId } : {}) } } },
    select: { id: true, amountMinor: true, currency: true, variant: { select: { product: { select: { name: true } } } } },
  });
  const factor = (100 + pct) / 100;
  const sample: string[] = [];
  let changed = 0;
  for (const r of rows) {
    const next = Math.max(1, Math.round(r.amountMinor * factor));
    if (next === r.amountMinor) continue;
    changed++;
    if (sample.length < 5) {
      const sym = r.currency === "INR" ? "₹" : "$";
      sample.push(`${r.variant.product.name.slice(0, 22)}: ${sym}${(r.amountMinor / 100).toFixed(2)} → ${sym}${(next / 100).toFixed(2)}`);
    }
    if (!dryRun) await prisma.variantPrice.update({ where: { id: r.id }, data: { amountMinor: next } });
  }
  if (!dryRun && changed > 0) await invalidate("cat:*");
  return { changed, sample };
}

/* ── 2. Find an order by a delivered key ──────────────────────────────────── */

export interface KeyTrace {
  found: boolean;
  kind?: "LICENSE_KEY" | "DIGITAL_ACCOUNT";
  status?: string;
  product?: string;
  orderNumber?: string;
  buyer?: string;
  buyerTelegramId?: string;
  deliveredAt?: Date | null;
}

/**
 * Trace a delivered key/account back to its order and buyer. Matches by HASH,
 * so the plaintext is never compared or logged.
 */
export async function findOrderByKey(input: string): Promise<KeyTrace> {
  const raw = input.trim();
  if (!raw) return { found: false };

  const keyHash = sha256Hex(normalizeLicenseKey(raw));
  const lk = await prisma.licenseKey.findFirst({
    where: { keyHash },
    select: {
      status: true, soldAt: true,
      variant: { select: { product: { select: { name: true } } } },
      orderItem: { select: { order: { select: { orderNumber: true, user: { select: { firstName: true, telegramHandle: true, telegramId: true } } } } } },
    },
  });
  if (lk) {
    const o = lk.orderItem?.order;
    return {
      found: true, kind: "LICENSE_KEY", status: lk.status,
      product: lk.variant.product.name,
      orderNumber: o?.orderNumber,
      buyer: o ? (o.user.telegramHandle ? `@${o.user.telegramHandle}` : (o.user.firstName ?? "customer")) : undefined,
      buyerTelegramId: o?.user.telegramId ? String(o.user.telegramId) : undefined,
      deliveredAt: lk.soldAt,
    };
  }

  // Accounts: match the username half of "id|pass".
  const username = raw.split(/[|:,]/)[0]?.trim().toLowerCase() ?? "";
  const usernameHash = sha256Hex(username);
  const da = await prisma.digitalAccount.findFirst({
    where: { usernameHash },
    include: {
      variant: { select: { product: { select: { name: true } } } },
      assignments: {
        take: 1, orderBy: { assignedAt: "desc" },
        select: { assignedAt: true, orderItem: { select: { order: { select: { orderNumber: true, user: { select: { firstName: true, telegramHandle: true, telegramId: true } } } } } } },
      },
    },
  });
  if (da) {
    const a = da.assignments[0];
    const o = a?.orderItem?.order;
    return {
      found: true, kind: "DIGITAL_ACCOUNT", status: da.status,
      product: da.variant.product.name,
      orderNumber: o?.orderNumber,
      buyer: o ? (o.user.telegramHandle ? `@${o.user.telegramHandle}` : (o.user.firstName ?? "customer")) : undefined,
      buyerTelegramId: o?.user.telegramId ? String(o.user.telegramId) : undefined,
      deliveredAt: a?.assignedAt ?? null,
    };
  }
  return { found: false };
}

/* ── 3. Stock health ──────────────────────────────────────────────────────── */

export interface StockHealth {
  low: Array<{ name: string; left: number }>;
  dead: Array<{ name: string; units: number; ageDays: number }>;
  outOfStock: Array<{ name: string; waiting: number }>;
  totalUnits: number;
}

export async function stockHealth(lowThreshold = 3): Promise<StockHealth> {
  const products = await prisma.product.findMany({
    where: { deletedAt: null, status: "ACTIVE", type: { in: ["LICENSE_KEY", "DIGITAL_ACCOUNT"] } },
    select: { id: true, name: true, type: true, createdAt: true, variants: { where: { deletedAt: null }, select: { id: true } } },
  });
  const ids = products.flatMap((p) => p.variants.map((v) => v.id));
  const [keys, accts, sold, waits] = await Promise.all([
    ids.length ? prisma.licenseKey.groupBy({ by: ["variantId"], where: { variantId: { in: ids }, status: "AVAILABLE", deletedAt: null }, _count: { _all: true } }) : [],
    ids.length ? prisma.digitalAccount.groupBy({ by: ["variantId"], where: { variantId: { in: ids }, status: "AVAILABLE", deletedAt: null }, _count: { _all: true } }) : [],
    prisma.orderItem.groupBy({ by: ["variantId"], where: { fulfilledAt: { not: null } }, _count: { _all: true } }),
    prisma.productWatch.groupBy({ by: ["productId"], where: { type: "RESTOCK" }, _count: { _all: true } }),
  ]);
  const stock = new Map<string, number>();
  for (const r of [...keys, ...accts]) stock.set(r.variantId, (stock.get(r.variantId) ?? 0) + r._count._all);
  const soldBy = new Map(sold.map((r) => [r.variantId, r._count._all]));
  const waitBy = new Map(waits.map((r) => [r.productId, r._count._all]));

  const low: StockHealth["low"] = [];
  const dead: StockHealth["dead"] = [];
  const oos: StockHealth["outOfStock"] = [];
  let total = 0;
  for (const p of products) {
    const units = p.variants.reduce((n, v) => n + (stock.get(v.id) ?? 0), 0);
    const sales = p.variants.reduce((n, v) => n + (soldBy.get(v.id) ?? 0), 0);
    total += units;
    const ageDays = Math.floor((Date.now() - p.createdAt.getTime()) / 86_400_000);
    if (units === 0) oos.push({ name: p.name, waiting: waitBy.get(p.id) ?? 0 });
    else if (units <= lowThreshold) low.push({ name: p.name, left: units });
    if (units > 0 && sales === 0 && ageDays >= 14) dead.push({ name: p.name, units, ageDays });
  }
  return {
    low: low.sort((a, b) => a.left - b.left).slice(0, 12),
    dead: dead.sort((a, b) => b.units - a.units).slice(0, 12),
    outOfStock: oos.sort((a, b) => b.waiting - a.waiting).slice(0, 12),
    totalUnits: total,
  };
}

/* ── 4. Customer risk lookup ──────────────────────────────────────────────── */

export interface RiskProfile {
  label: string;
  orders: number;
  completed: number;
  claims: number;
  claimsApproved: number;
  refunds: number;
  accountAgeDays: number;
  score: number;
  flags: string[];
}

export async function customerRisk(userId: string): Promise<RiskProfile | null> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { firstName: true, telegramHandle: true, createdAt: true, _count: { select: { orders: true } } },
  });
  if (!u) return null;
  const [completed, claims, approved, refunds] = await Promise.all([
    prisma.order.count({ where: { userId, status: "COMPLETED" } }),
    prisma.replacementRequest.count({ where: { userId } }),
    prisma.replacementRequest.count({ where: { userId, status: "APPROVED" } }),
    prisma.walletTransaction.count({ where: { wallet: { userId }, type: "REFUND" } }),
  ]);
  const ageDays = Math.floor((Date.now() - u.createdAt.getTime()) / 86_400_000);
  const flags: string[] = [];
  let score = 0;
  if (completed > 0 && claims / completed > 0.5) { score += 40; flags.push("Claims on over half their orders"); }
  if (claims >= 3 && ageDays <= 7) { score += 30; flags.push("3+ claims in the first week"); }
  if (approved >= 3) { score += 15; flags.push("3+ replacements already approved"); }
  if (refunds >= 3) { score += 15; flags.push("3+ refunds"); }
  if (ageDays <= 1 && claims >= 1) { score += 20; flags.push("Claim on a brand-new account"); }
  return {
    label: u.telegramHandle ? `@${u.telegramHandle}` : (u.firstName ?? "customer"),
    orders: u._count.orders, completed, claims, claimsApproved: approved, refunds,
    accountAgeDays: ageDays, score: Math.min(100, score), flags,
  };
}

/* ── 5. Order export ──────────────────────────────────────────────────────── */

export async function exportOrdersCsv(days = 90): Promise<string> {
  const since = new Date(Date.now() - days * 86_400_000);
  const orders = await prisma.order.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 5000,
    select: {
      orderNumber: true, status: true, currency: true, subtotalMinor: true, discountMinor: true,
      walletUsedMinor: true, totalMinor: true, createdAt: true, paidAt: true,
      user: { select: { telegramHandle: true, firstName: true, telegramId: true } },
      items: { select: { productNameSnap: true, quantity: true } },
    },
  });
  const esc = (v: unknown): string => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["order", "status", "currency", "subtotal", "discount", "wallet_used", "gateway_total", "buyer", "telegram_id", "items", "created", "paid"];
  const lines = [head.join(",")];
  for (const o of orders) {
    lines.push([
      esc(o.orderNumber), esc(o.status), esc(o.currency),
      (o.subtotalMinor / 100).toFixed(2), (o.discountMinor / 100).toFixed(2),
      ((o.walletUsedMinor ?? 0) / 100).toFixed(2), (o.totalMinor / 100).toFixed(2),
      esc(o.user.telegramHandle ? `@${o.user.telegramHandle}` : o.user.firstName), esc(o.user.telegramId ?? ""),
      esc(o.items.map((i) => `${i.productNameSnap}${i.quantity > 1 ? ` x${i.quantity}` : ""}`).join("; ")),
      esc(o.createdAt.toISOString()), esc(o.paidAt?.toISOString() ?? ""),
    ].join(","));
  }
  return lines.join("\n");
}

/** Current pricing rules, for the tools screen. */
export function pricingSummary(): { rate: number; surchargePct: number; store: string } {
  return { rate: usdtRate("INR"), surchargePct: inrSurchargeBp() / 100, store: loadConfig().STORE_NAME };
}
