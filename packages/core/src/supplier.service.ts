import { loadConfig } from "@gis/config";
import { prisma } from "@gis/database";
import { encryptSecret, decryptSecret } from "@gis/shared";
import { invalidate } from "./redis.js";
import { manualFulfillItem } from "./orders/manual-pay.service.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface SupplierRow { id: string; name: string; baseUrl: string; apiKeyEnc: string; markupBp: number; active: boolean }
export interface SupplierProduct { ref: string; name: string; description: string; priceMinor: number; stock: number | null }

const authHeaders = (key: string): Record<string, string> => ({ Authorization: `Bearer ${key}`, "X-API-Key": key, Accept: "application/json" });

/** URL candidates: as given, and with an /api/v1 prefix if the base has no version segment. */
function urlCandidates(baseUrl: string, path: string): string[] {
  const b = baseUrl.replace(/\/$/, "");
  const hasVersion = /\/api\/v\d+/.test(b);
  return hasVersion ? [`${b}${path}`] : [`${b}${path}`, `${b}/api/v1${path}`];
}

/** Fetch that tolerates a missing /api/v1 prefix (retries the versioned URL on 404). */
async function supFetch(s: SupplierRow, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = { ...authHeaders(decKey(s)), ...(init.headers as Record<string, string> | undefined) };
  let last: Response | null = null;
  for (const url of urlCandidates(s.baseUrl, path)) {
    const res = await fetch(url, { ...init, headers });
    if (res.status !== 404) return res;
    last = res;
  }
  return last as Response;
}
const decKey = (s: SupplierRow): string => decryptSecret(s.apiKeyEnc, loadConfig().ENCRYPTION_MASTER_KEY);

function pickStr(o: any, keys: string[]): string {
  for (const k of keys) { const v = o?.[k]; if (typeof v === "string" && v.trim()) return v; if (typeof v === "number") return String(v); }
  return "";
}
function pickNum(o: any, keys: string[]): number | null {
  for (const k of keys) { const v = o?.[k]; if (typeof v === "number") return v; if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v); }
  return null;
}

// ── CRUD ──
export async function addSupplier(name: string, baseUrl: string, apiKey: string, markupPct = 20): Promise<{ id: string }> {
  const enc = encryptSecret(apiKey.trim(), loadConfig().ENCRYPTION_MASTER_KEY);
  const s = await prisma.supplier.create({ data: { name: name.slice(0, 80), baseUrl: baseUrl.trim().replace(/\/$/, ""), apiKeyEnc: enc, markupBp: Math.max(0, Math.round(markupPct * 100)) } });
  return { id: s.id };
}
export async function listSuppliers(): Promise<Array<{ id: string; name: string; markupBp: number; active: boolean; baseUrl: string }>> {
  const rows = await prisma.supplier.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map((r) => ({ id: r.id, name: r.name, markupBp: r.markupBp, active: r.active, baseUrl: r.baseUrl }));
}
export async function removeSupplier(id: string): Promise<void> { await prisma.supplier.delete({ where: { id } }).catch(() => undefined); }
export async function setSupplierMarkup(id: string, pct: number): Promise<void> { await prisma.supplier.update({ where: { id }, data: { markupBp: Math.max(0, Math.round(pct * 100)) } }); }

// ── HTTP (tolerant to common REST shapes) ──
async function getJson(s: SupplierRow, path: string): Promise<any> {
  const res = await supFetch(s, path);
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json();
}

const PRODUCT_PATHS = ["/products", "/product", "/catalog", "/items", "/list"];

function parseProductArray(arr: any[]): SupplierProduct[] {
  return arr
    .map((p) => ({
      ref: pickStr(p, ["id", "product_id", "productId", "sku", "code", "uuid", "_id"]),
      name: pickStr(p, ["name", "title", "product", "label", "productName"]) || "Product",
      description: pickStr(p, ["description", "desc", "details", "info"]),
      priceMinor: Math.round((pickNum(p, ["price", "amount", "cost", "priceUsd", "rate", "unit_price", "sell_price", "sellPrice"]) ?? 0) * 100),
      stock: pickNum(p, ["stock", "available", "quantity", "qty", "inStock", "stock_count"]),
    }))
    .filter((p) => p.ref && p.priceMinor > 0);
}

/** Try common product endpoints; return the parsed products, plus the path used and a raw sample for diagnostics. */
async function probeProducts(s: SupplierRow): Promise<{ products: SupplierProduct[]; path: string; raw: string; note: string }> {
  let lastRaw = "";
  let lastNote = "";
  for (const path of PRODUCT_PATHS) {
    try {
      const res = await supFetch(s, path);
      const text = await res.text().catch(() => "");
      if (!res.ok) { lastNote = `${path || "/"} → HTTP ${res.status} ${text.slice(0, 120)}`; continue; }
      let json: any;
      try { json = JSON.parse(text); } catch { lastRaw = text.slice(0, 400); lastNote = `${path || "/"} → non-JSON response`; continue; }
      const arr: any[] = Array.isArray(json) ? json : (json.data ?? json.products ?? json.result ?? json.items ?? json.list ?? []);
      const products = parseProductArray(Array.isArray(arr) ? arr : []);
      if (products.length > 0) return { products, path: path || "/", raw: text.slice(0, 400), note: "ok" };
      lastRaw = text.slice(0, 400);
      lastNote = `${path || "/"} → parsed 0 products`;
    } catch (e) { lastNote = `${path || "/"} → ${String(e instanceof Error ? e.message : e).slice(0, 120)}`; }
  }
  // Fallback: some reseller APIs (e.g. Supabase functions) return the catalog via POST + an action.
  for (const body of [{ action: "products" }, { action: "list_products" }, { action: "catalog" }, { action: "list" }, { type: "products" }]) {
    try {
      const res = await supFetch(s, "", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const text = await res.text().catch(() => "");
      if (!res.ok) { lastNote = `POST ${JSON.stringify(body)} → HTTP ${res.status} ${text.slice(0, 100)}`; continue; }
      let json: any; try { json = JSON.parse(text); } catch { lastRaw = text.slice(0, 400); continue; }
      const arr: any[] = Array.isArray(json) ? json : (json.data ?? json.products ?? json.result ?? json.items ?? json.list ?? []);
      const products = parseProductArray(Array.isArray(arr) ? arr : []);
      if (products.length > 0) return { products, path: `POST ${JSON.stringify(body)}`, raw: text.slice(0, 400), note: "ok" };
      lastRaw = text.slice(0, 400);
    } catch (e) { lastNote = `POST → ${String(e instanceof Error ? e.message : e).slice(0, 120)}`; }
  }
  return { products: [], path: "", raw: lastRaw, note: lastNote };
}

export async function fetchSupplierProducts(s: SupplierRow): Promise<SupplierProduct[]> {
  return (await probeProducts(s)).products;
}

/** Diagnostic for the admin: which endpoint worked, or the raw response so we can map fields. */
export async function diagnoseSupplier(id: string): Promise<{ ok: boolean; detail: string }> {
  const s = await prisma.supplier.findUnique({ where: { id } });
  if (!s) return { ok: false, detail: "Supplier not found." };
  const r = await probeProducts(s);
  if (r.products.length > 0) {
    return { ok: true, detail: `OK ✅ — endpoint ${r.path} returned ${r.products.length} product(s). e.g. ${r.products.slice(0, 2).map((p) => `${p.name} @ ${(p.priceMinor / 100).toFixed(2)}`).join("; ")}` };
  }
  return { ok: false, detail: `Couldn't read products. Last attempt: ${r.note}\nRaw response sample:\n${r.raw || "(empty)"}` };
}

export async function getSupplierBalance(s: SupplierRow): Promise<number | null> {
  try { const j = await getJson(s, "/balance"); return pickNum(j, ["balance", "amount", "credit", "wallet", "funds"]) ?? pickNum(j.data ?? {}, ["balance", "amount"]); }
  catch { return null; }
}

export async function testSupplier(id: string): Promise<{ ok: boolean; detail: string }> {
  const s = await prisma.supplier.findUnique({ where: { id } });
  if (!s) return { ok: false, detail: "Supplier not found." };
  const probe = await probeProducts(s);
  const bal = await getSupplierBalance(s).catch(() => null);
  if (probe.products.length > 0) {
    return { ok: true, detail: `OK ✅ — endpoint ${probe.path}, ${probe.products.length} product(s)${bal !== null ? ` · balance ${bal}` : ""}.` };
  }
  return { ok: false, detail: `No products read. ${probe.note}\nRaw sample:\n${(probe.raw || "(empty)").slice(0, 300)}` };
}

/** Place an order at the supplier and return the delivered key(s). Deducts the supplier-side balance. */
export async function placeSupplierOrder(supplierId: string, ref: string, qty = 1): Promise<{ ok: boolean; keys: string[]; reason?: string }> {
  const s = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!s) return { ok: false, keys: [], reason: "NO_SUPPLIER" };
  try {
    const pid: string | number = /^\d+$/.test(ref) ? Number(ref) : ref;
    const res = await supFetch(s, "/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": `sup-${supplierId}-${ref}-${Date.now()}` },
      body: JSON.stringify({ product_id: pid, productId: pid, id: pid, quantity: qty, qty }),
    });
    if (!res.ok) return { ok: false, keys: [], reason: `${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}` };
    const j: any = await res.json();
    const out: string[] = [];
    const collect = (v: any): void => {
      if (!v) return;
      if (typeof v === "string") { if (v.trim()) out.push(v.trim()); return; }
      if (Array.isArray(v)) { v.forEach(collect); return; }
      if (typeof v === "object") collect(v.key ?? v.code ?? v.serial ?? v.license ?? v.credentials ?? v.data ?? v.result);
    };
    collect(j.key ?? j.code ?? j.keys ?? j.codes ?? j.data ?? j.result ?? j);
    return { ok: out.length > 0, keys: out, reason: out.length ? undefined : "NO_KEY_IN_RESPONSE" };
  } catch (e) { return { ok: false, keys: [], reason: String(e instanceof Error ? e.message : e).slice(0, 200) }; }
}

/** Import/refresh a supplier's catalog into our products (with markup). */
export async function syncSupplierProducts(supplierId: string): Promise<{ added: number; updated: number }> {
  const s = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!s) return { added: 0, updated: 0 };
  const prods = await fetchSupplierProducts(s);
  const retail = await prisma.priceTier.findUniqueOrThrow({ where: { name: "RETAIL" } });
  const rate = loadConfig().BINANCE_USDT_INR_RATE || 90;
  let cat = await prisma.category.findFirst({ where: { slug: "uncategorized" } });
  if (!cat) cat = await prisma.category.create({ data: { name: "Uncategorized", slug: "uncategorized", sortOrder: 999 } });
  let added = 0, updated = 0;
  for (const p of prods) {
    const priceMinor = Math.max(1, Math.round(p.priceMinor * (1 + s.markupBp / 10000)));
    const inrMinor = Math.round(priceMinor * rate);
    const inStock = p.stock === null || p.stock > 0; // null = API doesn't report stock → treat as available
    const existing = await prisma.product.findFirst({ where: { supplierId: s.id, supplierRef: p.ref }, include: { variants: true } });
    if (existing) {
      // Visibility follows supplier stock: shown when >0, hidden when 0.
      await prisma.product.update({ where: { id: existing.id }, data: { name: p.name.slice(0, 200), description: p.description.slice(0, 4000) || null, status: inStock ? "ACTIVE" : "PAUSED" } });
      const v = existing.variants[0];
      if (v) for (const [currency, amt] of [["USD", priceMinor], ["INR", inrMinor]] as const) {
        await prisma.variantPrice.upsert({ where: { variantId_tierId_currency: { variantId: v.id, tierId: retail.id, currency } }, create: { variantId: v.id, tierId: retail.id, currency, amountMinor: amt }, update: { amountMinor: amt } });
      }
      updated++;
    } else {
      if (!inStock) continue; // don't import out-of-stock products
      const slug = `sup-${s.id.slice(0, 6)}-${p.ref}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 60);
      await prisma.product.create({
        data: {
          slug, name: p.name.slice(0, 200), description: p.description.slice(0, 4000) || null,
          type: "MANUAL_SERVICE", status: "ACTIVE", fulfillmentMode: "MANUAL", categoryId: cat.id,
          supplierId: s.id, supplierRef: p.ref,
          variants: { create: { name: "Standard", sku: `${slug}-std`.slice(0, 64), sortOrder: 0, prices: { create: [{ tierId: retail.id, currency: "USD", amountMinor: priceMinor }, { tierId: retail.id, currency: "INR", amountMinor: inrMinor }] } } },
        },
      });
      added++;
    }
  }
  await invalidate("cat:*");
  return { added, updated };
}

/** List a supplier's imported products (for the show/hide picker). */
export async function listSupplierProducts(supplierId: string, limit = 30): Promise<Array<{ id: string; name: string; visible: boolean; priceMinor: number }>> {
  const rows = await prisma.product.findMany({
    where: { supplierId, deletedAt: null },
    orderBy: { name: "asc" }, take: limit,
    include: { variants: { include: { prices: { where: { currency: "USD", tier: { name: "RETAIL" } } } } } },
  });
  return rows.map((p) => ({ id: p.id, name: p.name, visible: p.status === "ACTIVE", priceMinor: p.variants[0]?.prices[0]?.amountMinor ?? 0 }));
}

/** Show/hide a supplier product in the shop. */
export async function setSupplierProductVisible(productId: string, visible: boolean): Promise<void> {
  await prisma.product.update({ where: { id: productId }, data: { status: visible ? "ACTIVE" : "PAUSED" } });
  await invalidate("cat:*");
}

/** Fulfill an order item by buying from its linked supplier and delivering the key. */
export async function fulfillFromSupplier(orderItemId: string): Promise<{ ok: boolean; reason?: string }> {
  const item = await prisma.orderItem.findUnique({ where: { id: orderItemId }, include: { variant: { include: { product: true } } } });
  if (!item) return { ok: false, reason: "NOT_FOUND" };
  const { supplierId, supplierRef } = item.variant.product;
  if (!supplierId || !supplierRef) return { ok: false, reason: "NOT_SUPPLIER" };
  const r = await placeSupplierOrder(supplierId, supplierRef, item.quantity);
  if (!r.ok || r.keys.length === 0) return { ok: false, reason: r.reason ?? "NO_KEY" };
  await manualFulfillItem(orderItemId, r.keys.join("\n"));
  return { ok: true };
}

/** Auto-buy + deliver every supplier-linked, still-unfulfilled item in an order. Returns count delivered. */
export async function autoFulfillSupplierItems(orderId: string): Promise<number> {
  const items = await prisma.orderItem.findMany({ where: { orderId, fulfilledAt: null }, include: { variant: { include: { product: true } } } });
  let done = 0;
  for (const it of items) {
    if (!it.variant.product.supplierId) continue;
    const r = await fulfillFromSupplier(it.id);
    if (r.ok) done++;
  }
  return done;
}
