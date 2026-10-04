import { loadConfig } from "@gis/config";
import { prisma } from "@gis/database";
import { randomBytes } from "node:crypto";
import { enqueueAdminAlert, enqueueTelegramDocument } from "./queues.js";

/**
 * Operations helpers the admin panel drives:
 *   FAQ      — quick answers shown in Help and before a ticket is opened
 *   agents   — support-only admins (orders, tickets, replacements; no money)
 *   backup   — a JSON export of the shop's tables, sent to the admin chat
 *   report   — the daily extras (top sellers, low stock, terminal state)
 */

// ── FAQ ──────────────────────────────────────────────────────────────────────

export interface FaqItem {
  id: string;
  q: string;
  a: string;
}

const FAQ_KEY = "faq.items";

export async function listFaq(): Promise<FaqItem[]> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: FAQ_KEY } });
    const v = row?.value;
    if (Array.isArray(v)) {
      return v
        .map((x) => x as Partial<FaqItem>)
        .filter((x) => typeof x.id === "string" && typeof x.q === "string" && typeof x.a === "string")
        .map((x) => ({ id: x.id as string, q: x.q as string, a: x.a as string }));
    }
  } catch { /* empty */ }
  return [];
}

async function saveFaq(items: FaqItem[]): Promise<void> {
  const value = items.map((i) => ({ id: i.id, q: i.q, a: i.a }));
  await prisma.setting.upsert({ where: { key: FAQ_KEY }, create: { key: FAQ_KEY, value }, update: { value } });
}

export async function addFaq(q: string, a: string): Promise<FaqItem> {
  const items = await listFaq();
  const item: FaqItem = { id: randomBytes(4).toString("hex"), q: q.trim().slice(0, 120), a: a.trim().slice(0, 2000) };
  items.push(item);
  await saveFaq(items.slice(-40));
  return item;
}

export async function removeFaq(id: string): Promise<void> {
  await saveFaq((await listFaq()).filter((i) => i.id !== id));
}

/** Best-matching FAQ entries for free text (word overlap), for the pre-ticket hint. */
export async function matchFaq(text: string, limit = 3): Promise<FaqItem[]> {
  const words = new Set(text.toLowerCase().split(/[^a-z0-9ऀ-ॿ]+/).filter((w) => w.length >= 3));
  if (words.size === 0) return [];
  const scored = (await listFaq()).map((i) => {
    const hay = `${i.q} ${i.a}`.toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score++;
    return { i, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.i);
}

// ── Support agents ───────────────────────────────────────────────────────────

const AGENTS_KEY = "admin.agents";

/** Telegram ids that may use the admin panel's support side only. */
export async function listAgents(): Promise<string[]> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: AGENTS_KEY } });
    const v = row?.value;
    if (Array.isArray(v)) return v.map(String).filter((x) => /^\d+$/.test(x));
  } catch { /* none */ }
  return [];
}

export async function setAgents(ids: string[]): Promise<void> {
  const value = [...new Set(ids.filter((x) => /^\d+$/.test(x)))];
  await prisma.setting.upsert({ where: { key: AGENTS_KEY }, create: { key: AGENTS_KEY, value }, update: { value } });
}

export async function isAgentId(tgId: number | bigint | string | undefined): Promise<boolean> {
  if (tgId === undefined) return false;
  return (await listAgents()).includes(String(tgId));
}

// ── Backup ───────────────────────────────────────────────────────────────────

const BACKUP_KEY = "backup.cfg";

export async function getBackupConfig(): Promise<{ daily: boolean }> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: BACKUP_KEY } });
    const v = row?.value as { daily?: boolean } | null | undefined;
    return { daily: v?.daily === true };
  } catch {
    return { daily: false };
  }
}

export async function setBackupDaily(daily: boolean): Promise<void> {
  const value = { daily };
  await prisma.setting.upsert({ where: { key: BACKUP_KEY }, create: { key: BACKUP_KEY, value }, update: { value } });
}

/**
 * Export the shop as one JSON document. Secrets stay as they are stored —
 * encrypted with ENCRYPTION_MASTER_KEY — so the file is useless without the
 * key and the key must be backed up separately (and never in the same place).
 */
export async function buildBackupJson(): Promise<{ json: string; counts: Record<string, number> }> {
  const bigintSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
  const [categories, products, variants, prices, keys, accounts, users, wallets, walletTx, orders, items, payments, coupons, settings, suppliers, reviews, terminal] = await Promise.all([
    prisma.category.findMany(),
    prisma.product.findMany(),
    prisma.productVariant.findMany(),
    prisma.variantPrice.findMany(),
    prisma.licenseKey.findMany({ where: { deletedAt: null } }),
    prisma.digitalAccount.findMany({ where: { deletedAt: null } }),
    prisma.user.findMany({ select: { id: true, telegramId: true, telegramHandle: true, firstName: true, lastName: true, email: true, currency: true, locale: true, status: true, createdAt: true, firstPurchaseAt: true, referredById: true } }),
    prisma.wallet.findMany(),
    prisma.walletTransaction.findMany({ orderBy: { createdAt: "desc" }, take: 20_000 }),
    prisma.order.findMany({ orderBy: { createdAt: "desc" }, take: 20_000 }),
    prisma.orderItem.findMany({ orderBy: { id: "desc" }, take: 40_000 }),
    prisma.payment.findMany({ orderBy: { createdAt: "desc" }, take: 20_000 }),
    prisma.coupon.findMany(),
    prisma.setting.findMany(),
    prisma.supplier.findMany(),
    prisma.review.findMany(),
    prisma.terminalPayment.findMany({ orderBy: { createdAt: "desc" }, take: 5000 }),
  ]);
  const data = {
    meta: { store: loadConfig().STORE_NAME, exportedAt: new Date().toISOString(), note: "Secrets are encrypted with ENCRYPTION_MASTER_KEY — keep that key safe and separate." },
    categories, products, variants, prices, licenseKeys: keys, digitalAccounts: accounts, users, wallets, walletTransactions: walletTx,
    orders, orderItems: items, payments, coupons, settings, suppliers, reviews, terminalPayments: terminal,
  };
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(data)) if (Array.isArray(v)) counts[k] = v.length;
  return { json: JSON.stringify(data, bigintSafe), counts };
}

/** Build the export and send it to the admin alert chat / admins as a document. */
export async function sendBackup(reason = "manual"): Promise<{ bytes: number; counts: Record<string, number> }> {
  const { json, counts } = await buildBackupJson();
  const cfg = loadConfig();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const filename = `gisbot-backup-${stamp}.json`;
  const caption = `💾 Backup (${reason}) — ${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(", ")}. Encrypted fields need ENCRYPTION_MASTER_KEY.`;
  const targets = new Set<string>();
  if (cfg.ADMIN_ALERT_CHAT_ID) targets.add(String(cfg.ADMIN_ALERT_CHAT_ID));
  for (const id of (cfg.BOT_ADMIN_IDS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) targets.add(id);
  if (targets.size === 0) throw new Error("No ADMIN_ALERT_CHAT_ID or BOT_ADMIN_IDS to send the backup to");
  if (Buffer.byteLength(json) > 45 * 1024 * 1024) {
    await enqueueAdminAlert("⚠️ Backup is over 45 MB — too large to send through Telegram. Export from the server instead (pg_dump).").catch(() => undefined);
    throw new Error("backup too large for Telegram");
  }
  for (const t of targets) await enqueueTelegramDocument(t, filename, json, caption);
  return { bytes: Buffer.byteLength(json), counts };
}

// ── Daily report extras ──────────────────────────────────────────────────────

export async function dailyReportExtras(): Promise<string[]> {
  const since = new Date(Date.now() - 86_400_000);
  const lines: string[] = [];
  try {
    const top = await prisma.orderItem.groupBy({
      by: ["productNameSnap"], where: { order: { status: { in: ["COMPLETED", "PAID", "PENDING_FULFILLMENT"] }, createdAt: { gte: since } } },
      _count: { _all: true }, orderBy: { _count: { productNameSnap: "desc" } }, take: 3,
    });
    if (top.length > 0) lines.push(`🏆 Top sellers: ${top.map((t) => `${t.productNameSnap} ×${t._count._all}`).join(" · ")}`);
  } catch { /* skip */ }
  try {
    const low = await prisma.$queryRaw<Array<{ name: string; stock: bigint }>>`
      SELECT p."name", COUNT(k."id") AS stock
      FROM "Product" p
      JOIN "ProductVariant" v ON v."productId" = p."id" AND v."deletedAt" IS NULL AND v."isActive" = true
      LEFT JOIN "LicenseKey" k ON k."variantId" = v."id" AND k."status" = 'AVAILABLE' AND k."deletedAt" IS NULL
      WHERE p."status" = 'ACTIVE' AND p."deletedAt" IS NULL AND p."type" = 'LICENSE_KEY' AND p."fulfillmentMode" = 'AUTOMATIC'
      GROUP BY p."id", p."name" HAVING COUNT(k."id") <= 3 ORDER BY stock ASC LIMIT 5`;
    if (low.length > 0) lines.push(`📉 Low stock: ${low.map((l) => `${l.name} (${Number(l.stock)})`).join(", ")}`);
  } catch { /* skip */ }
  try {
    const [open, unswept, newUsers, tickets] = await Promise.all([
      prisma.terminalPayment.count({ where: { status: { in: ["WAITING", "CONFIRMING", "PARTIAL"] }, expiresAt: { gt: new Date() } } }),
      prisma.terminalPayment.count({ where: { sweepStatus: { in: ["PENDING", "RETRY", "SWEEPING"] } } }),
      prisma.user.count({ where: { createdAt: { gte: since } } }),
      prisma.supportTicket.count({ where: { status: { in: ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER"] } } }).catch(() => 0),
    ]);
    lines.push(`👥 New customers: ${newUsers}   ·   🎫 Open tickets: ${tickets}`);
    if (open > 0 || unswept > 0) lines.push(`🔐 Terminal: ${open} payment(s) open, ${unswept} awaiting sweep`);
  } catch { /* skip */ }
  return lines;
}
