import { loadConfig } from "@gis/config";
import { prisma } from "@gis/database";
import { encryptSecret, decryptSecret } from "@gis/shared";
import { invalidate, getRedis } from "./redis.js";
import { logWallet } from "./logs.service.js";
import { enqueueAdminAlert } from "./queues.js";
import { manualFulfillItem } from "./orders/manual-pay.service.js";
import { announceProduct, sendBroadcast } from "./broadcast.service.js";
import { usdtRate } from "./fx.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface SupplierRow { id: string; name: string; baseUrl: string; apiKeyEnc: string; markupBp: number; active: boolean; docsConfig?: unknown }
export interface SupplierProduct { ref: string; name: string; description: string; note: string; priceMinor: number; stock: number | null; variantRef?: string }

/**
 * Send the key every common way at once. `apikey` matters for Supabase Edge
 * Functions — their gateway rejects a request without it before your function
 * ever runs, which looks exactly like a broken endpoint.
 */
const authHeaders = (key: string): Record<string, string> => ({
  Authorization: `Bearer ${key}`,
  "X-API-Key": key,
  apikey: key, // Supabase gateway
  "X-Api-Token": key,
  Accept: "application/json",
});

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
    const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(8000) });
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
/**
 * Do newly synced products go straight into the shop, or arrive hidden?
 *
 * Default HIDDEN. Auto-sync imports everything a supplier offers, and a vendor
 * with 2,000 SKUs would otherwise flood the shop and broadcast all of it to every
 * customer the moment they were connected. Hidden-by-default means the sync is
 * still automatic but you decide what appears, in bulk.
 */
const NEWVIS = (id: string) => `supplier.newvisible.${id}`;

export async function getSupplierNewVisible(supplierId: string): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key: NEWVIS(supplierId) } }).catch(() => null);
  const v = row?.value as { on?: boolean } | null;
  return v?.on === true;
}

export async function setSupplierNewVisible(supplierId: string, on: boolean): Promise<void> {
  await prisma.setting.upsert({
    where: { key: NEWVIS(supplierId) },
    create: { key: NEWVIS(supplierId), value: { on } as never },
    update: { value: { on } as never },
  });
}

export type RemoveSupplierMode = "keep" | "hide" | "delete";

/** How many shop products came from this supplier (for the delete confirmation). */
export async function countSupplierProducts(supplierId: string): Promise<{ total: number; visible: number }> {
  const [total, visible] = await Promise.all([
    prisma.product.count({ where: { supplierId, deletedAt: null } }),
    prisma.product.count({ where: { supplierId, deletedAt: null, status: "ACTIVE" } }),
  ]);
  return { total, visible };
}

/**
 * Remove a vendor, and decide what happens to the products they brought in.
 *
 * Product.supplierId has no foreign key, so deleting the supplier row used to
 * leave their products in the shop forever, pointing at a vendor that no longer
 * exists and impossible to fulfil — a customer could still buy one.
 *
 *   "delete" — soft-delete them (default; recoverable, history intact)
 *   "hide"   — keep the rows but pull them from the shop
 *   "keep"   — leave them listed, unlinked from any supplier
 */
export async function removeSupplier(id: string, mode: RemoveSupplierMode = "delete"): Promise<{ affected: number; removed: boolean; error?: string }> {
  const now = new Date();
  let affected = 0;
  if (mode === "delete") {
    // Soft delete: never destroy a product row that orders may reference.
    const r = await prisma.product.updateMany({
      where: { supplierId: id, deletedAt: null },
      data: { deletedAt: now, status: "ARCHIVED", supplierId: null, supplierRef: null },
    });
    affected = r.count;
  } else if (mode === "hide") {
    const r = await prisma.product.updateMany({
      where: { supplierId: id, deletedAt: null },
      // Unlink too, or a later sync from a re-added vendor could resurrect them.
      data: { status: "PAUSED", supplierId: null, supplierRef: null },
    });
    affected = r.count;
  } else {
    // Keep them on sale but detach — they become ordinary manual products.
    const r = await prisma.product.updateMany({
      where: { supplierId: id, deletedAt: null },
      data: { supplierId: null, supplierRef: null, fulfillmentMode: "MANUAL" },
    });
    affected = r.count;
  }
  // Products that were ALREADY soft-deleted kept pointing at this supplier,
  // and nothing here cleared them. Once the supplier row was gone, any
  // still-unfulfilled order item on one of those products failed forever with
  // NO_SUPPLIER. Unlink every product of this vendor, deleted or not.
  await prisma.product.updateMany({
    where: { supplierId: id },
    data: { supplierId: null, supplierRef: null },
  });

  // The delete used to be `.catch(() => undefined)`, so a failure was invisible:
  // the products were unlinked, the panel said "Vendor removed", and the vendor
  // was still in the list. Report it instead of lying.
  let removed = true;
  let error: string | undefined;
  try {
    await prisma.supplier.delete({ where: { id } });
  } catch (e) {
    removed = false;
    error = String(e instanceof Error ? e.message : e).slice(0, 200);
    // eslint-disable-next-line no-console
    console.error("supplier delete failed", { supplierId: id, error });
  }

  await prisma.setting.delete({ where: { key: NEWVIS(id) } }).catch(() => undefined);
  await invalidate("cat:*");
  return { affected, removed, error };
}
export async function setSupplierMarkup(id: string, pct: number): Promise<void> { await prisma.supplier.update({ where: { id }, data: { markupBp: Math.max(0, Math.round(pct * 100)) } }); }

// ── HTTP (tolerant to common REST shapes) ──
async function getJson(s: SupplierRow, path: string): Promise<any> {
  const res = await supFetch(s, path);
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json();
}

const PRODUCT_PATHS = [
  // A sibling shop running this same software (its own developer API).
  "/api/v1/developer/products?all=true",
  "/developer/products?all=true",
  "/products", "/product", "/catalog", "/items", "/list",
];
/** Single-endpoint reseller APIs (Supabase functions etc.) select the operation with ?action=. */
const PRODUCT_ACTIONS = ["products", "catalog", "list_products", "products_list", "list", "stock", "get_products"];

/** Append query params to a base URL, respecting an existing query string. */
function withQuery(baseUrl: string, params: Record<string, string | number>): string {
  const b = baseUrl.replace(/\/$/, "");
  const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
  return `${b}${b.includes("?") ? "&" : "?"}${qs}`;
}

/** GET the supplier base URL with ?action=… (no path probing). */
async function actionGet(s: SupplierRow, params: Record<string, string | number>): Promise<Response> {
  return fetch(withQuery(s.baseUrl, params), { headers: authHeaders(decKey(s)), signal: AbortSignal.timeout(8000) });
}

/** Some APIs (including ours) quote prices in integer MINOR units. */
function priceMinorOf(p: any): number {
  const minor = pickNum(p, ["priceMinor", "fromPriceMinor", "amountMinor", "price_minor", "unitPriceMinor"]);
  if (minor !== null) return Math.round(minor); // already minor units — do NOT scale
  const v = pickNum(p?.variants?.[0] ?? {}, ["priceMinor", "amountMinor"]);
  if (v !== null) return Math.round(v);
  const major = pickNum(p, ["price", "amount", "cost", "priceUsd", "rate", "unit_price", "unitPrice", "sell_price", "sellPrice", "total_cost", "reseller_price", "resellerPrice"]);
  return Math.round((major ?? 0) * 100);
}

function stockOf(p: any): number | null {
  const direct = pickNum(p, ["stock", "available", "quantity", "qty", "inStock", "stock_count", "available_stock", "availableStock", "stock_available", "in_stock", "remaining", "count"]);
  if (direct !== null) return direct;
  const v = p?.variants?.[0];
  if (v) {
    if (v.unlimited === true) return null;
    const vs = pickNum(v, ["stock", "available", "quantity"]);
    if (vs !== null) return vs;
  }
  return null;
}

function parseProductArray(arr: any[]): SupplierProduct[] {
  return arr
    .map((p) => ({
      ref: pickStr(p, ["id", "product_id", "productId", "sku", "code", "uuid", "_id"]),
      name: pickStr(p, ["name", "title", "product", "label", "productName", "product_name"]) || "Product",
      description: pickStr(p, ["description", "desc", "details", "info", "about", "content", "body", "long_description", "longDescription", "summary"]),
      // NOTE: "warranty" is deliberately NOT read here — warranty is a real
      // per-product toggle in this store, and importing a supplier's warranty
      // blurb made it appear in the description even for no-warranty products.
      note: pickStr(p, ["note", "notes", "instructions", "instruction", "terms", "guide", "activation", "how_to_use", "howToUse", "delivery_note", "deliveryNote"]),
      priceMinor: priceMinorOf(p),
      stock: stockOf(p),
      // Sibling shops need the VARIANT id to place an order, not the product id.
      variantRef: pickStr(p?.variants?.[0] ?? {}, ["id", "variantId"]) || undefined,
    }))
    .filter((p) => p.ref && p.priceMinor > 0);
}

/** Try common product endpoints; return the parsed products, plus the path used and a raw sample for diagnostics. */
async function probeProducts(s: SupplierRow): Promise<{ products: SupplierProduct[]; path: string; raw: string; note: string; trail?: string[] }> {
  let lastRaw = "";
  let lastNote = "";
  const trail: string[] = [];
  const note = (t: string): void => { lastNote = t; if (trail.length < 24) trail.push(t); };
  // Strategy: whatever we learned from the supplier's own documentation wins.
  const doc = (s.docsConfig ?? null) as DocsConfig | null;
  if (doc?.productsPath) {
    for (const attempt of [doc.productsPath, `${doc.productsPath}?all=true`]) {
      try {
        const url = `${(doc.baseUrl ?? s.baseUrl).replace(/\/$/, "")}${attempt}`;
        const res = await fetch(url, { headers: authHeaders(decKey(s)) });
        const text = await res.text().catch(() => "");
        if (!res.ok) { note(`docs ${attempt} → HTTP ${res.status} ${text.slice(0, 100)}`); continue; }
        let json: any; try { json = JSON.parse(text); } catch { lastRaw = text.slice(0, 400); continue; }
        const listed = atPath(json, doc.listField);
        const arr: any[] = Array.isArray(listed)
          ? listed
          : Array.isArray(json) ? json : (json.items ?? json.data ?? json.products ?? json.result ?? json.list ?? []);
        const products = parseProductArray(Array.isArray(arr) ? arr : []);
        if (products.length > 0) return { products, path: `docs:${attempt}`, raw: text.slice(0, 400), note: "ok" };
        lastRaw = text.slice(0, 400);
        note(`docs ${attempt} → parsed 0 products`);
      } catch (e) { note(`docs → ${String(e instanceof Error ? e.message : e).slice(0, 120)}`); }
    }
  }
  for (const path of PRODUCT_PATHS) {
    try {
      const res = await supFetch(s, path);
      const text = await res.text().catch(() => "");
      if (!res.ok) { note(`${path || "/"} → HTTP ${res.status} ${text.slice(0, 120)}`); continue; }
      let json: any;
      try { json = JSON.parse(text); } catch { lastRaw = text.slice(0, 400); note(`${path || "/"} → non-JSON response`); continue; }
      const arr: any[] = Array.isArray(json) ? json : (json.data ?? json.products ?? json.result ?? json.items ?? json.list ?? []);
      const products = parseProductArray(Array.isArray(arr) ? arr : []);
      if (products.length > 0) {
        void prisma.supplier.update({ where: { id: s.id }, data: { docsConfig: { ...(doc ?? {}), productsPath: path } as never } }).catch(() => undefined);
        return { products, path: path || "/", raw: text.slice(0, 400), note: "ok" };
      }
      lastRaw = text.slice(0, 400);
      note(`${path || "/"} → parsed 0 products`);
    } catch (e) { note(`${path || "/"} → ${String(e instanceof Error ? e.message : e).slice(0, 120)}`); }
  }
  // Action-style APIs: GET <base>?action=products
  for (const action of PRODUCT_ACTIONS) {
    try {
      const res = await actionGet(s, { action });
      const text = await res.text().catch(() => "");
      if (!res.ok) { note(`?action=${action} → HTTP ${res.status} ${text.slice(0, 120)}`); continue; }
      let json: any; try { json = JSON.parse(text); } catch { lastRaw = text.slice(0, 400); note(`?action=${action} → non-JSON`); continue; }
      const arr: any[] = Array.isArray(json)
        ? json
        : (json.products ?? json.data ?? json.result ?? json.items ?? json.list ?? json.catalog ?? json.stock ?? []);
      const products = parseProductArray(Array.isArray(arr) ? arr : []);
      if (products.length > 0) return { products, path: `?action=${action}`, raw: text.slice(0, 400), note: "ok" };
      lastRaw = text.slice(0, 400);
      note(`?action=${action} → parsed 0 products`);
    } catch (e) { note(`?action=${action} → ${String(e instanceof Error ? e.message : e).slice(0, 120)}`); }
  }
  // Fallback: some reseller APIs (e.g. Supabase functions) return the catalog via POST + an action.
  for (const body of [
    { action: "products" }, { action: "list_products" }, { action: "catalog" },
    { action: "get_products" }, { action: "list" }, { action: "stock" },
    { type: "products" }, { method: "products" },
  ]) {
    try {
      const res = await supFetch(s, "", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const text = await res.text().catch(() => "");
      if (!res.ok) { note(`POST ${JSON.stringify(body)} → HTTP ${res.status} ${text.slice(0, 100)}`); continue; }
      let json: any; try { json = JSON.parse(text); } catch { lastRaw = text.slice(0, 400); continue; }
      const arr: any[] = Array.isArray(json) ? json : (json.data ?? json.products ?? json.result ?? json.items ?? json.list ?? []);
      const products = parseProductArray(Array.isArray(arr) ? arr : []);
      if (products.length > 0) return { products, path: `POST ${JSON.stringify(body)}`, raw: text.slice(0, 400), note: "ok" };
      lastRaw = text.slice(0, 400);
    } catch (e) { note(`POST → ${String(e instanceof Error ? e.message : e).slice(0, 120)}`); }
  }
  return { products: [], path: "", raw: lastRaw, note: lastNote, trail };
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
  return {
    ok: false,
    detail: [
      "Couldn't read a product list from this supplier.",
      `Tried: GET ${PRODUCT_PATHS.join(", ")}; GET ?action=${PRODUCT_ACTIONS.join("/")}; POST {action:…}.`,
      "Attempts:",
      (r.trail ?? [r.note]).map((t) => `• ${t}`).join("\n"),
      "Raw response sample:",
      r.raw || "(empty)",
      "",
      "If the raw sample above shows products, send it to support so the field mapping can be added.",
    ].join("\n"),
  };
}

export async function getSupplierBalance(s: SupplierRow): Promise<number | null> {
  const fields = ["balance", "amount", "credit", "wallet", "funds", "balance_usd"];
  try {
    const j = await getJson(s, "/balance");
    const v = pickNum(j, fields) ?? pickNum(j.data ?? {}, fields);
    if (v !== null) return v;
  } catch { /* try the action-style endpoint */ }
  for (const action of ["balance", "get_balance", "wallet"]) {
    try {
      const res = await actionGet(s, { action });
      if (!res.ok) continue;
      const j: any = await res.json();
      const v = pickNum(j, fields) ?? pickNum(j.data ?? {}, fields) ?? pickNum(j.wallet ?? {}, fields);
      if (v !== null) return v;
    } catch { /* next */ }
  }
  return null;
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
const KEY_FIELD_RE = /(licen[sc]e|serial|voucher|redeem|coupon|activation|cd[_-]?key|game[_-]?key|product[_-]?key|\bkey\b|\bcode\b|\bcodes\b|credential|secret|\btoken\b|login|username|\buser\b|email|password|\bpass\b|\bpin\b|\baccount\b|\baccounts\b|\baccount\b|\baccounts\b|delivered|download|content)/i;
// Never treat these as the delivered key even if they contain "key"/"id".
const EXCLUDE_FIELD_RE = /(idempoten|request|trace|order[_-]?id|orderid|txn|transaction|invoice|reference|\bref\b|\bid\b|status|message|success|error|created|updated|timestamp)/i;
const STATUS_WORDS = /^(true|false|ok|yes|no|success|failed|failure|error|pending|completed|done|processing|active|null|none|n\/a)$/i;

/** Deeply extract delivered credential strings from any supplier order response shape. */
function extractDeliveredKeys(j: any, exclude: string[] = []): string[] {
  const out: string[] = [];
  const bad = (v: string): boolean => v.startsWith("sup-") || exclude.some((e) => e && v === e);
  const walk = (node: any, keyName?: string): void => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      const v = node.trim();
      if (v.length >= 4 && keyName && KEY_FIELD_RE.test(keyName) && !EXCLUDE_FIELD_RE.test(keyName) && !STATUS_WORDS.test(v) && !bad(v)) out.push(v);
      return;
    }
    if (typeof node === "number") return;
    if (Array.isArray(node)) { for (const el of node) walk(el, keyName); return; }
    if (typeof node === "object") { for (const [k, val] of Object.entries(node)) walk(val, k); return; }
  };
  walk(j);
  return [...new Set(out)];
}

export async function placeSupplierOrder(
  supplierId: string,
  ref: string,
  qty = 1,
  externalOrderId?: string,
): Promise<{ ok: boolean; keys: string[]; reason?: string; raw?: string }> {
  const s = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!s) return { ok: false, keys: [], reason: "NO_SUPPLIER" };
  // "productRef|variantRef" — a sibling shop running this software needs the
  // VARIANT id to place an order.
  const [rawRef, variantRef] = ref.includes("|") ? ref.split("|") : [ref, undefined];
  const baseRef = rawRef ?? ref;
  const pid: string | number = /^\d+$/.test(baseRef) ? Number(baseRef) : baseRef;
  // A STABLE id per order line: a retry must never create a second order upstream.
  const extId = externalOrderId ?? `sup-${supplierId}-${ref}-${qty}`;
  const excl = [extId, String(ref), s.id, supplierId];
  let lastRaw = "";
  let lastReason = "";

  const readKeys = (text: string): { keys: string[]; json: any } => {
    let j: any; try { j = JSON.parse(text); } catch { j = text; }
    return { keys: extractDeliveredKeys(j, excl), json: j };
  };

  // Strategy 0 — a sibling shop running this same software.
  if (variantRef) {
    for (const path of ["/api/v1/developer/orders", "/developer/orders", "/orders"]) {
      try {
        const res = await fetch(`${s.baseUrl.replace(/\/$/, "")}${path}`, {
          method: "POST",
          headers: { ...authHeaders(decKey(s)), "Content-Type": "application/json", "Idempotency-Key": extId },
          body: JSON.stringify({ variantId: variantRef, quantity: qty }),
          signal: AbortSignal.timeout(12_000),
        });
        const text = await res.text().catch(() => "");
        if (res.status === 404) continue;
        lastRaw = text.slice(0, 500);
        if (!res.ok) { lastReason = `${res.status} ${text.slice(0, 160)}`; break; }
        const { keys } = readKeys(text);
        if (keys.length > 0) return { ok: true, keys, raw: lastRaw };
        lastReason = "ACCEPTED_NO_KEY";
        return { ok: false, keys: [], reason: lastReason, raw: lastRaw };
      } catch (e) { lastReason = String(e instanceof Error ? e.message : e).slice(0, 160); }
    }
  }

  // Strategy A — action-style API: GET <base>?action=place_order&product_id=..&quantity=..&external_order_id=..
  for (const action of ["place_order", "order", "create_order", "buy", "purchase", "new_order"]) {
    try {
      const res = await actionGet(s, { action, product_id: pid, quantity: qty, external_order_id: extId });
      const text = await res.text().catch(() => "");
      lastRaw = text.slice(0, 500);
      if (res.status === 404) continue;
      // Their documented duplicate guard: the order already exists and was NOT re-charged.
      if (res.status === 409) {
        const rec = await lookupSupplierOrder(s, extId, excl);
        if (rec.keys.length > 0) return { ok: true, keys: rec.keys, raw: rec.raw };
        lastReason = `409 duplicate, and order_status returned no accounts`;
        lastRaw = rec.raw || lastRaw;
        continue;
      }
      if (!res.ok) { lastReason = `${res.status} ${text.slice(0, 160)}`; continue; }
      const { keys } = readKeys(text);
      if (keys.length > 0) return { ok: true, keys, raw: lastRaw };
      // Accepted but still processing — poll the status endpoint once.
      const rec = await lookupSupplierOrder(s, extId, excl);
      if (rec.keys.length > 0) return { ok: true, keys: rec.keys, raw: rec.raw };
      // The supplier ACCEPTED this order (HTTP 2xx). Trying the next action name
      // would place — and pay for — a second order. Stop and let an admin look.
      return { ok: false, keys: [], reason: "ACCEPTED_NO_KEY", raw: lastRaw };
    } catch (e) { lastReason = String(e instanceof Error ? e.message : e).slice(0, 160); }
  }

  // Strategy B — conventional REST: POST /orders
  try {
    const res = await supFetch(s, "/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": extId },
      body: JSON.stringify({ product_id: pid, productId: pid, id: pid, quantity: qty, qty, external_order_id: extId, externalOrderId: extId }),
    });
    const text = await res.text().catch(() => "");
    lastRaw = text.slice(0, 500) || lastRaw;
    if (res.status === 409) {
      const rec = await lookupSupplierOrder(s, extId, excl);
      if (rec.keys.length > 0) return { ok: true, keys: rec.keys, raw: rec.raw };
    } else if (res.ok) {
      const { keys } = readKeys(text);
      if (keys.length > 0) return { ok: true, keys, raw: lastRaw };
      const rec = await lookupSupplierOrder(s, extId, excl);
      if (rec.keys.length > 0) return { ok: true, keys: rec.keys, raw: rec.raw };
      lastReason = "NO_KEY_IN_RESPONSE";
    } else {
      lastReason = `${res.status} ${text.slice(0, 160)}`;
    }
  } catch (e) { lastReason = String(e instanceof Error ? e.message : e).slice(0, 160); }

  return { ok: false, keys: [], reason: lastReason || "NO_KEY_IN_RESPONSE", raw: lastRaw };
}

/** Look an order up by our external id and pull the delivered accounts/keys out. */
async function lookupSupplierOrder(s: SupplierRow, extId: string, excl: string[]): Promise<{ keys: string[]; raw: string }> {
  for (const action of ["order_status", "order", "status", "check_order"]) {
    try {
      const res = await actionGet(s, { action, external_order_id: extId });
      const text = await res.text().catch(() => "");
      if (!res.ok) continue;
      let j: any; try { j = JSON.parse(text); } catch { continue; }
      const keys = extractDeliveredKeys(j, excl);
      if (keys.length > 0) return { keys, raw: text.slice(0, 500) };
    } catch { /* try the next action name */ }
  }
  return { keys: [], raw: "" };
}

/** Import/refresh a supplier's catalog into our products (with markup). */

/** Docs/UI suffixes that are NOT an API base. */
const DOCS_SUFFIX_RE = /\/(swagger(-ui)?|api-docs|apidocs|docs|documentation|redoc|openapi|scalar)(\.html?|\/)?$/i;

/**
 * People paste the Swagger/docs page as the "API base URL" — the connector then
 * fetches HTML and every call 401s. Detect that, strip back to the real base,
 * and read the OpenAPI spec sitting next to it so endpoints self-configure.
 */
export async function normalizeSupplierBase(supplierId: string): Promise<{ changed: boolean; detail: string }> {
  const sup = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!sup) return { changed: false, detail: "Supplier not found." };
  const raw = sup.baseUrl.replace(/\/+$/, "");
  if (!DOCS_SUFFIX_RE.test(raw)) return { changed: false, detail: "" };

  const stripped = raw.replace(DOCS_SUFFIX_RE, "");
  const specUrls = [`${raw}.json`, `${raw}/swagger.json`, `${raw}/openapi.json`, `${stripped}/swagger.json`, `${stripped}/openapi.json`, `${stripped}/v1/swagger.json`];
  let learned = "";
  await prisma.supplier.update({ where: { id: supplierId }, data: { baseUrl: stripped } });
  for (const u of specUrls) {
    try {
      const res = await fetch(u, { headers: authHeaders(decKey(sup)), signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const body = await res.text();
      if (!/"paths"\s*:/.test(body)) continue;
      const r = await learnSupplierDocs(supplierId, body);
      learned = `\n📄 Read the OpenAPI spec at <code>${u}</code>\n${r.detail}`;
      break;
    } catch { /* next candidate */ }
  }
  return {
    changed: true,
    detail: [
      "🔧 <b>That looked like a documentation page, not an API base.</b>",
      `Base URL corrected to <code>${stripped}</code>.`,
      learned || "\n⚠️ No OpenAPI spec found beside it — tap 🔎 Auto-find docs.",
    ].join("\n"),
  };
}

/** One sync at a time per supplier — repeated 🔄 taps used to stack probe storms. */
export async function syncSupplierProducts(
  supplierId: string,
): Promise<{ added: number; updated: number; busy?: boolean }> {
  const lockKey = `suplock:${supplierId}`;
  const got = await getRedis().set(lockKey, "1", "EX", 120, "NX").catch(() => "OK");
  if (got !== "OK") return { added: 0, updated: 0, busy: true };
  try {
    return await syncSupplierProductsInner(supplierId);
  } finally {
    await getRedis().del(lockKey).catch(() => undefined);
  }
}

async function syncSupplierProductsInner(supplierId: string): Promise<{ added: number; updated: number }> {
  const s = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!s) return { added: 0, updated: 0 };
  const prods = await fetchSupplierProducts(s);
  const retail = await prisma.priceTier.findUniqueOrThrow({ where: { name: "RETAIL" } });
  const rate = usdtRate("INR");
  let cat = await prisma.category.findFirst({ where: { slug: "uncategorized" } });
  if (!cat) cat = await prisma.category.create({ data: { name: "Uncategorized", slug: "uncategorized", sortOrder: 999 } });
  // Auto-sync imports everything, but new items are HIDDEN unless the operator
  // opted in — see getSupplierNewVisible.
  const goLive = await getSupplierNewVisible(supplierId);
  let added = 0, updated = 0;
  const newIds: string[] = [];
  for (const p of prods) {
    const priceMinor = Math.max(1, Math.round(p.priceMinor * (1 + s.markupBp / 10000)));
    const inrMinor = Math.round(priceMinor * rate);
    const inStock = p.stock === null || p.stock > 0; // null = API doesn't report stock → treat as available
    const refKey = p.variantRef ? `${p.ref}|${p.variantRef}` : p.ref;
    const existing = await prisma.product.findFirst({
      where: { supplierId: s.id, OR: [{ supplierRef: refKey }, { supplierRef: p.ref }] },
      include: { variants: true },
    });
    if (existing) {
      // Stock drives visibility ONLY for products the operator has already
      // published. A hidden product must stay hidden — sync bringing it back into
      // the shop on the next stock change would undo every bulk hide.
      const nextStatus = existing.status === "ARCHIVED" || existing.status === "DRAFT"
        ? existing.status
        : existing.status === "PAUSED" && !existing.supplierStockDrivenPause
          ? "PAUSED"
          : inStock ? "ACTIVE" : "PAUSED";
      await prisma.product.update({
        where: { id: existing.id },
        data: {
          name: p.name.slice(0, 200),
          description: p.description.slice(0, 4000) || null,
          activationGuide: p.note.slice(0, 2000) || null,
          supplierStock: p.stock,
          status: nextStatus,
          // Remember WHY it is paused, so the rule above can tell an out-of-stock
          // pause (sync may unpause) from a manual hide (sync must not).
          supplierStockDrivenPause: nextStatus === "PAUSED" ? !inStock : false,
        },
      });
      const v = existing.variants[0];
      if (v && !existing.priceLocked) for (const [currency, amt] of [["USD", priceMinor], ["INR", inrMinor]] as const) {
        await prisma.variantPrice.upsert({ where: { variantId_tierId_currency: { variantId: v.id, tierId: retail.id, currency } }, create: { variantId: v.id, tierId: retail.id, currency, amountMinor: amt }, update: { amountMinor: amt } });
      }
      updated++;
    } else {
      if (!inStock) continue; // don't import out-of-stock products
      const slug = `sup-${s.id.slice(0, 6)}-${p.ref}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 60);
      const created = await prisma.product.create({
        data: {
          slug, name: p.name.slice(0, 200), description: p.description.slice(0, 4000) || null,
          activationGuide: p.note.slice(0, 2000) || null,
          type: "MANUAL_SERVICE", status: goLive ? "ACTIVE" : "PAUSED", fulfillmentMode: "MANUAL", categoryId: cat.id,
          supplierId: s.id, supplierRef: p.variantRef ? `${p.ref}|${p.variantRef}` : p.ref, supplierStock: p.stock,
          variants: { create: { name: "Standard", sku: `${slug}-std`.slice(0, 64), sortOrder: 0, prices: { create: [{ tierId: retail.id, currency: "USD", amountMinor: priceMinor }, { tierId: retail.id, currency: "INR", amountMinor: inrMinor }] } } },
        },
      });
      newIds.push(created.id);
      added++;
    }
  }
  await invalidate("cat:*");
  // Only announce what customers can actually see. Broadcasting products that are
  // hidden would advertise things nobody can buy.
  if (newIds.length > 0 && goLive) {
    if (newIds.length <= 3) {
      for (const pid of newIds) await announceProduct(pid, { createdById: "supplier-sync", force: true }).catch(() => undefined);
    } else {
      const uname = loadConfig().BOT_USERNAME;
      await sendBroadcast({
        title: "",
        body: `🆕 <b>${newIds.length} new products just added!</b>\nBrowse the shop and grab them before they're gone. 🔥`,
        bodyIsHtml: true,
        segment: "all",
        buttonText: uname ? "🛒 Browse shop" : undefined,
        buttonUrl: uname ? `https://t.me/${uname}?start=menu` : undefined,
        createdById: "supplier-sync",
      }).catch(() => undefined);
    }
  }
  return { added, updated };
}

export interface SupplierProductRow {
  id: string;
  name: string;
  visible: boolean;
  priceMinor: number;
  stock: number | null;
}

/**
 * One page of a supplier's products, for the bulk picker.
 *
 * Paged because a vendor can easily have thousands: the old version took the first
 * 30 with no paging, so everything beyond that was unreachable — you could not hide
 * a product you could not see.
 */
export async function listSupplierProducts(
  supplierId: string,
  opts: { page?: number; pageSize?: number; search?: string; only?: "all" | "visible" | "hidden" } = {},
): Promise<{ items: SupplierProductRow[]; page: number; pages: number; total: number; visibleTotal: number }> {
  const pageSize = Math.min(50, Math.max(5, opts.pageSize ?? 12));
  const only = opts.only ?? "all";
  const where = {
    supplierId,
    deletedAt: null,
    ...(only === "visible" ? { status: "ACTIVE" as const } : {}),
    ...(only === "hidden" ? { status: { not: "ACTIVE" as const } } : {}),
    ...(opts.search ? { name: { contains: opts.search, mode: "insensitive" as const } } : {}),
  };
  const [total, visibleTotal] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.count({ where: { supplierId, deletedAt: null, status: "ACTIVE" } }),
  ]);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, opts.page ?? 1), pages);
  const rows = await prisma.product.findMany({
    where,
    orderBy: { name: "asc" },
    skip: (page - 1) * pageSize,
    take: pageSize,
    include: { variants: { include: { prices: { where: { currency: "USD", tier: { name: "RETAIL" } } } } } },
  });
  return {
    items: rows.map((p) => ({
      id: p.id,
      name: p.name,
      visible: p.status === "ACTIVE",
      priceMinor: p.variants[0]?.prices[0]?.amountMinor ?? 0,
      stock: p.supplierStock,
    })),
    page,
    pages,
    total,
    visibleTotal,
  };
}

/** Ids on one page — so "select all on page" doesn't need the client to know them. */
export async function supplierProductIdsOnPage(
  supplierId: string,
  opts: { page?: number; pageSize?: number; only?: "all" | "visible" | "hidden" } = {},
): Promise<string[]> {
  const r = await listSupplierProducts(supplierId, opts);
  return r.items.map((i) => i.id);
}

/** Every id matching the current filter — for "select all N". */
export async function supplierProductIdsAll(
  supplierId: string,
  only: "all" | "visible" | "hidden" = "all",
  cap = 500,
): Promise<string[]> {
  const rows = await prisma.product.findMany({
    where: {
      supplierId,
      deletedAt: null,
      ...(only === "visible" ? { status: "ACTIVE" as const } : {}),
      ...(only === "hidden" ? { status: { not: "ACTIVE" as const } } : {}),
    },
    orderBy: { name: "asc" },
    take: cap,
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Bulk show / hide / delete, scoped to ONE supplier.
 *
 * The supplierId in the where clause is not decoration: it stops a stale or
 * tampered selection from touching another vendor's products.
 */
export async function bulkSupplierProducts(
  supplierId: string,
  productIds: string[],
  action: "show" | "hide" | "delete",
): Promise<number> {
  const ids = [...new Set(productIds)].slice(0, 500);
  if (ids.length === 0) return 0;
  const where = { id: { in: ids }, supplierId, deletedAt: null };
  let count = 0;
  if (action === "show") {
    ({ count } = await prisma.product.updateMany({ where, data: { status: "ACTIVE", supplierStockDrivenPause: false } }));
  } else if (action === "hide") {
    // supplierStockDrivenPause false marks this as a MANUAL hide, so the next sync
    // will not helpfully put it back in the shop.
    ({ count } = await prisma.product.updateMany({ where, data: { status: "PAUSED", supplierStockDrivenPause: false } }));
  } else {
    // Soft delete — orders reference these rows, so they are never destroyed.
    // Unlink from the supplier at the same time: a deleted product that still
    // carries a supplierId becomes an orphan the moment that vendor is removed,
    // and its pending order items then retry against a supplier that is gone.
    ({ count } = await prisma.product.updateMany({
      where,
      data: { deletedAt: new Date(), status: "ARCHIVED", supplierId: null, supplierRef: null },
    }));
  }
  await invalidate("cat:*");
  return count;
}

/** Show/hide a supplier product in the shop. */
export async function setSupplierProductVisible(productId: string, visible: boolean): Promise<void> {
  await prisma.product.update({ where: { id: productId }, data: { status: visible ? "ACTIVE" : "PAUSED" } });
  await invalidate("cat:*");
}

/** Show or hide ALL of a supplier's products at once. */
export async function setAllSupplierProductsVisible(supplierId: string, visible: boolean): Promise<number> {
  const r = await prisma.product.updateMany({ where: { supplierId, deletedAt: null }, data: { status: visible ? "ACTIVE" : "PAUSED" } });
  await invalidate("cat:*");
  return r.count;
}

/* ── Auto-fulfilment failure handling ──────────────────────────────────────────
 * The retry sweep runs every 60 s. Without a cap it re-attempts a permanently
 * broken item forever and fires a fresh admin alert on every pass — which is
 * how one mis-configured product produced an identical "Supplier charged but no
 * key parsed" message every single minute, all night.
 */
const MAX_SUPPLIER_ATTEMPTS = 5;

/** Reasons where the request never left this server, so no money can have moved. */
const NEVER_SENT = new Set(["NO_SUPPLIER", "NOT_SUPPLIER", "SUPPLIER_INACTIVE", "NO_REF"]);

async function bumpAttempts(orderItemId: string): Promise<number> {
  try {
    const r = getRedis();
    const key = `sup:attempt:${orderItemId}`;
    const n = await r.incr(key);
    if (n === 1) await r.expire(key, 86_400);
    return n;
  } catch {
    return 1; // Redis down — behave as before rather than blocking delivery
  }
}

async function clearAttempts(orderItemId: string): Promise<void> {
  try { await getRedis().del(`sup:attempt:${orderItemId}`); } catch { /* ignore */ }
}

/** True the FIRST time this key is seen within `ttl` — used to alert once, not 1 440 times a day. */
async function alertOnce(key: string, ttl = 86_400): Promise<boolean> {
  try {
    return (await getRedis().set(`sup:alerted:${key}`, "1", "EX", ttl, "NX")) !== null;
  } catch {
    return true;
  }
}

/** Has this item exhausted its retries? The sweep skips it; a human must act. */
export async function isSupplierItemGivenUp(orderItemId: string): Promise<boolean> {
  try {
    const n = Number(await getRedis().get(`sup:attempt:${orderItemId}`));
    return Number.isFinite(n) && n >= MAX_SUPPLIER_ATTEMPTS;
  } catch {
    return false;
  }
}

/** Admin action: clear the circuit breaker so the sweep will try this item again. */
export async function resetSupplierItemAttempts(orderItemId: string): Promise<void> {
  await clearAttempts(orderItemId);
  try { await getRedis().del(`sup:alerted:item:${orderItemId}`); } catch { /* ignore */ }
}

/** Fulfill an order item by buying from its linked supplier and delivering the key. */
export async function fulfillFromSupplier(orderItemId: string): Promise<{ ok: boolean; reason?: string }> {
  const item = await prisma.orderItem.findUnique({ where: { id: orderItemId }, include: { variant: { include: { product: true } } } });
  if (!item) return { ok: false, reason: "NOT_FOUND" };
  if (item.fulfilledAt) return { ok: true }; // already delivered — never buy twice
  const { supplierId, supplierRef } = item.variant.product;
  if (!supplierId || !supplierRef) return { ok: false, reason: "NOT_SUPPLIER" };

  // The supplier row this product points at may have been deleted. Detect that
  // HERE, before any network call, so the failure is reported as the
  // configuration problem it is instead of as a possible double-charge.
  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId }, select: { id: true, name: true, active: true } });
  if (!supplier) {
    await handleDeadSupplierLink(item, supplierId);
    return { ok: false, reason: "NO_SUPPLIER" };
  }
  if (!supplier.active) return { ok: false, reason: "SUPPLIER_INACTIVE" };

  // Stable per-order-line id → the supplier de-dupes retries instead of double-charging.
  const r = await placeSupplierOrder(supplierId, supplierRef, item.quantity, `oi-${orderItemId}`);
  if (r.ok && r.keys.length > 0) {
    await manualFulfillItem(orderItemId, r.keys.join("\n"));
    await clearAttempts(orderItemId);
    return { ok: true };
  }

  const reason = r.reason ?? "NO_KEY";
  const attempts = await bumpAttempts(orderItemId);
  const sent = !NEVER_SENT.has(reason);
  const givingUp = attempts >= MAX_SUPPLIER_ATTEMPTS;

  void logWallet("supplier.fulfil", `Supplier fulfilment failed: ${item.productNameSnap}`, {
    orderItemId, reason, attempts, mayHaveCharged: sent,
  });

  // One alert per item per day, and only when we are actually giving up or the
  // money may genuinely have moved. Silence while the retries are still running
  // is the point: the sweep is expected to recover most of these on its own.
  if ((givingUp || sent) && (await alertOnce(`item:${orderItemId}`))) {
    const head = sent
      ? "⚠️ <b>Supplier may have been charged but no key was parsed</b>"
      : "⚠️ <b>Auto-fulfilment failed — supplier was NOT contacted, no money moved</b>";
    await enqueueAdminAlert(
      [
        head,
        `Product: ${item.productNameSnap}`,
        `Reason: ${reason} (attempt ${attempts}/${MAX_SUPPLIER_ATTEMPTS})`,
        givingUp ? "Auto-retry has STOPPED. Deliver this order manually." : "Auto-retry continues in the background.",
        r.raw ? `Raw supplier response (send to support to fix mapping):\n<code>${escapeForHtml(r.raw)}</code>` : "",
      ].filter(Boolean).join("\n"),
      [{ text: "📦 Deliver manually", callbackData: `adm:deliver:${item.orderId}`, style: "primary" as const }],
    ).catch(() => undefined);
  }

  return { ok: false, reason };
}

function escapeForHtml(raw: string): string {
  return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").slice(0, 400);
}

/**
 * A product pointing at a supplier row that no longer exists can never be
 * fulfilled automatically. Pause it so nobody else can buy an item the shop
 * cannot deliver, and tell the admin once.
 */
async function handleDeadSupplierLink(
  item: { id: string; orderId: string; productNameSnap: string; variant: { productId: string } },
  supplierId: string,
): Promise<void> {
  await bumpAttempts(item.id);
  try {
    await prisma.product.updateMany({
      where: { id: item.variant.productId, status: "ACTIVE" },
      data: { status: "PAUSED", supplierStockDrivenPause: false },
    });
    await invalidate("cat:*");
  } catch { /* pausing is best-effort */ }

  if (await alertOnce(`deadsupplier:${supplierId}`, 21_600)) {
    await enqueueAdminAlert(
      [
        "🛑 <b>Broken supplier link — auto-fulfilment disabled for this product</b>",
        `Product: ${item.productNameSnap}`,
        `It is linked to supplier <code>${supplierId}</code>, which no longer exists.`,
        "",
        "No supplier was contacted and <b>no money was charged</b> — the earlier wording was wrong.",
        "The product has been PAUSED. Re-link it to a live supplier (or set it to manual) and un-pause it.",
        "Pending orders for it must be delivered by hand.",
      ].join("\n"),
      [{ text: "📦 Deliver manually", callbackData: `adm:deliver:${item.orderId}`, style: "primary" as const }],
    ).catch(() => undefined);
  }
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

/* ── Learn a supplier's API from their own documentation ───────────────────── */

export interface DocsConfig {
  baseUrl?: string;
  authHeader?: string; // "Authorization: Bearer" | "X-API-Key"
  productsPath?: string;
  orderPath?: string;
  balancePath?: string;
  listField?: string; // e.g. "data.items"
  idField?: string;
  priceField?: string;
  stockField?: string;
}

/** Read a nested field path like "data.items" off a parsed JSON body. */
function atPath(obj: any, path?: string): any {
  if (!path) return undefined;
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * Parse a supplier's API docs (pasted text or a URL) and extract everything the
 * connector needs. Deliberately tolerant: anything it cannot find is left unset
 * and the normal probing still applies.
 */
export async function learnSupplierDocs(supplierId: string, input: string): Promise<{ ok: boolean; detail: string; config: DocsConfig }> {
  const sup = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!sup) return { ok: false, detail: "Supplier not found.", config: {} };

  let text = input.trim();
  let source = "text";
  if (/^https?:\/\//i.test(text)) {
    try {
      const res = await fetch(text, { headers: { Accept: "text/html,text/plain,application/json" }, signal: AbortSignal.timeout(12_000) });
      const body = await res.text();
      text = body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
      source = `url (${body.length} chars)`;
    } catch {
      return { ok: false, detail: "Couldn't download that docs URL. Paste the documentation text instead.", config: {} };
    }
  }

  const cfg: DocsConfig = {};
  // OpenAPI/Swagger: turn "paths" into the METHOD /path lines the parser expects.
  try {
    const spec = JSON.parse(text) as any;
    if (spec && typeof spec === "object" && spec.paths) {
      const lines: string[] = [];
      for (const [pth, ops] of Object.entries(spec.paths as Record<string, any>)) {
        for (const method of Object.keys(ops ?? {})) {
          if (["get", "post", "put", "patch"].includes(method.toLowerCase())) lines.push(`${method.toUpperCase()} ${pth}`);
        }
      }
      const servers: string[] = (spec.servers ?? []).map((sv: any) => String(sv?.url ?? "")).filter(Boolean);
      const schemes = JSON.stringify(spec.components?.securitySchemes ?? spec.securityDefinitions ?? {});
      text = [servers.length ? `Base URL: ${servers[0]}` : "", /bearer/i.test(schemes) ? "Authorization: Bearer KEY" : /apikey|api_key/i.test(schemes) ? "X-API-Key: KEY" : "", ...lines].filter(Boolean).join("\n");
    }
  } catch { /* not JSON — use the text as-is */ }
  // Base URL: first absolute URL that isn't an image/asset.
  const urls = [...text.matchAll(/https?:\/\/[^\s"'`<>)]+/gi)].map((m) => m[0]);
  const apiUrl = urls.find((u) => /\/api\b|\/v\d\b|\/functions\/|developer/i.test(u)) ?? urls[0];
  if (apiUrl) {
    try {
      const u = new URL(apiUrl);
      // Keep the whole documented path when it is versioned (…/api/v1/developer);
      // slicing at a fixed offset dropped the trailing segment.
      const path = u.pathname.replace(/\/+$/, "");
      cfg.baseUrl = /\/api\/v\d/.test(path)
        ? `${u.origin}${path.replace(/\/(products|orders|balance|docs(\.txt)?|manifest|openapi\.json|swagger\.json|api-docs|documentation|llms\.txt).*$/i, "")}`
        : u.origin;
    } catch { /* ignore */ }
  }
  // Auth style.
  if (/bearer/i.test(text)) cfg.authHeader = "Authorization: Bearer";
  else if (/x-api-key/i.test(text)) cfg.authHeader = "X-API-Key";

  // Endpoint paths.
  const findPath = (re: RegExp): string | undefined => {
    const m = text.match(re);
    return m?.[1]?.trim();
  };
  cfg.productsPath = findPath(/GET\s+\/?((?:api\/)?[\w/{}.\-]*products[\w/{}.\-]*)/i)
    ?? findPath(/\/?((?:api\/)?[\w/{}.\-]*(?:products|catalog|stock)[\w/{}.\-]*)/i);
  cfg.orderPath = findPath(/POST\s+\/?((?:api\/)?[\w/{}.\-]*orders?[\w/{}.\-]*)/i);
  cfg.balancePath = findPath(/GET\s+\/?((?:api\/)?[\w/{}.\-]*balance[\w/{}.\-]*)/i);
  for (const k of ["productsPath", "orderPath", "balancePath"] as const) {
    let v = cfg[k];
    if (!v) continue;
    if (v.includes("://")) { cfg[k] = undefined; continue; } // an absolute URL is not a path
    if (!v.startsWith("/")) v = `/${v}`;
    cfg[k] = v;
  }
  // Field mapping hints.
  // Prefer an actual JSON key ("items": [ … ]) over a word that merely appears
  // in a URL — matching "products" from "GET /products" picked the wrong field.
  cfg.listField =
    findPath(/"(items|products|data|results|list)"\s*:\s*\[/i) ??
    findPath(/\b(data\.items|data\.products|data\.data|results|list)\b/i) ??
    undefined;
  cfg.idField = /variant_?id/i.test(text) ? "variantId" : /product_?id/i.test(text) ? "product_id" : "id";
  if (/price_?minor|amount_?minor/i.test(text)) cfg.priceField = "priceMinor";

  await prisma.supplier.update({ where: { id: supplierId }, data: { docsConfig: cfg as never } });

  // Live check: does the products endpoint actually return items?
  const probe = await probeProducts({ ...sup, docsConfig: cfg } as never).catch(() => null);
  const found = probe?.products.length ?? 0;

  const lines = [
    "📄 <b>Docs processed</b>",
    `• source: ${source}`,
    cfg.baseUrl ? `• base URL: <code>${cfg.baseUrl}</code>` : "• base URL: not found (using the one you entered)",
    cfg.authHeader ? `• auth: <code>${cfg.authHeader} KEY</code>` : "• auth: assuming Bearer + X-API-Key",
    cfg.productsPath ? `• products: <code>${cfg.productsPath}</code>` : "• products: will auto-probe",
    cfg.orderPath ? `• order: <code>${cfg.orderPath}</code>` : "• order: will auto-probe",
    cfg.balancePath ? `• balance: <code>${cfg.balancePath}</code>` : "",
    cfg.listField ? `• list field: <code>${cfg.listField}</code>` : "",
    "",
    found > 0
      ? `✅ <b>Live check passed</b> — ${found} product(s) readable. Tap 🔄 Sync to import them.`
      : "⚠️ <b>Live check found 0 products.</b> The key may lack permission, or the catalogue is empty. Tap 🔍 Diagnose for the raw response.",
  ].filter(Boolean);
  return { ok: found > 0, detail: lines.join("\n"), config: cfg };
}

/** Doc locations worth trying on a supplier's host, best-first. */
const DOC_PATHS = [
  "/api/v1/developer/docs.txt", "/api/v1/developer/manifest", "/api/v1/developer",
  "/docs.txt", "/llms.txt", "/manifest",
  "/openapi.json", "/swagger.json", "/api-docs", "/api/docs", "/docs", "/documentation",
  "/api/v1/docs", "/developer", "/developers", "/api",
];

/**
 * Auto-discover a supplier's API docs when the connector is not working. Tries
 * the usual documentation locations on their host, picks the most informative
 * response, and feeds it through learnSupplierDocs.
 */
export async function autoFetchSupplierDocs(supplierId: string): Promise<{ ok: boolean; detail: string }> {
  const sup = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!sup) return { ok: false, detail: "Supplier not found." };

  let origin = sup.baseUrl.replace(/\/$/, "");
  try { origin = new URL(sup.baseUrl).origin; } catch { /* keep as-is */ }

  const tried: string[] = [];
  let best: { url: string; text: string; score: number } | null = null;

  for (const path of DOC_PATHS) {
    const url = `${origin}${path}`;
    try {
      const res = await fetch(url, {
        headers: { ...authHeaders(decKey(sup)), Accept: "text/plain,application/json,text/html" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) { tried.push(`${path} → ${res.status}`); continue; }
      const raw = await res.text();
      const text = raw.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
      // Score by how much the parser will actually be able to use.
      let score = 0;
      if (/\b(GET|POST)\s+\//.test(text)) score += 5;
      if (/products|catalog/i.test(text)) score += 3;
      if (/orders?/i.test(text)) score += 2;
      if (/balance/i.test(text)) score += 1;
      if (/bearer|x-api-key/i.test(text)) score += 2;
      if (/"paths"\s*:/.test(raw)) score += 6; // OpenAPI
      if (text.length < 40) score = 0;
      tried.push(`${path} → ${res.status}, ${raw.length} chars, score ${score}`);
      if (score > 0 && (!best || score > best.score)) best = { url, text: (/"paths"\s*:/.test(raw) ? raw : text).slice(0, 60_000), score };
      if (score >= 10) break; // good enough
    } catch {
      tried.push(`${path} → unreachable`);
    }
  }

  if (!best) {
    return {
      ok: false,
      detail: [
        "🔎 <b>Couldn't find any documentation</b>",
        "",
        "Tried on <code>" + origin + "</code>:",
        tried.slice(0, 14).map((t) => `• ${t}`).join("\n"),
        "",
        "Use 📄 <b>Read API docs</b> and paste the documentation link or text instead.",
      ].join("\n"),
    };
  }

  const learned = await learnSupplierDocs(supplierId, best.text);
  return {
    ok: learned.ok,
    detail: [`🔎 <b>Found docs at</b> <code>${best.url}</code>`, "", learned.detail].join("\n"),
  };
}

/**
 * Safety net: retry supplier fulfilment for paid orders whose items are still
 * undelivered. Supplier purchase happens fire-and-forget right after checkout
 * (so a slow vendor cannot stall the customer), which means a crash, restart or
 * transient vendor error would otherwise leave a paid item never delivered —
 * the customer sees "being prepared" forever and has to check My Orders.
 */
export async function retryPendingSupplierFulfilment(maxOrders = 20): Promise<{ scanned: number; delivered: number }> {
  const items = await prisma.orderItem.findMany({
    where: {
      fulfilledAt: null,
      variant: { product: { supplierId: { not: null } } },
      order: { status: { in: ["PAID", "PENDING_FULFILLMENT"] } },
      createdAt: { lt: new Date(Date.now() - 60_000) }, // give the first attempt a minute
    },
    orderBy: { createdAt: "asc" },
    take: maxOrders,
    select: { id: true },
  });
  let delivered = 0;
  let skipped = 0;
  for (const it of items) {
    // Permanently-failing items are dropped from the sweep instead of being
    // retried (and re-alerted) every 60 s forever. An admin clears the breaker
    // with resetSupplierItemAttempts once the cause is fixed.
    if (await isSupplierItemGivenUp(it.id)) { skipped++; continue; }
    const r = await fulfillFromSupplier(it.id).catch(() => ({ ok: false }));
    if (r.ok) delivered++;
  }
  if (delivered > 0) {
    await logWallet("supplier.retry", `Recovered ${delivered} undelivered supplier item(s)`, { scanned: items.length, skipped });
  }
  return { scanned: items.length, delivered };
}
