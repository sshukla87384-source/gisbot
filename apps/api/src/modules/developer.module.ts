import { addToCart, checkoutWithWallet, clearCart, getLedger, getProductView, getRedis, getWallet, listCategories, listProducts, revealOrderDeliveries, toUsdt, usdtRate, UNLIMITED_STOCK } from "@gis/core";
import { loadConfig } from "@gis/config";
import { prisma, type Currency } from "@gis/database";
import { Body, Controller, Get, Header, Module, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { isCoreError } from "@gis/shared";
import { z } from "zod";
import { ApiError, forbidden, notFound } from "../common/errors.js";
import { DeveloperApiGuard, Scopes, type DeveloperRequest } from "../common/developer.guard.js";
import { Public } from "../common/permissions.decorator.js";

/** Every price the API returns is expressed in USDT. */
function usdtOf(minor: number | null, currency: Currency): string | null {
  return minor === null ? null : toUsdt(minor, currency);
}

/** UNLIMITED_STOCK is an internal sentinel — never leak 9007199254740991 to API clients. */
function stockOut(n: number): { stock: number | null; unlimited: boolean; inStock: boolean } {
  if (n >= UNLIMITED_STOCK) return { stock: null, unlimited: true, inStock: true };
  return { stock: n, unlimited: false, inStock: n > 0 };
}

function currencyOf(q: unknown): Currency {
  const c = String((q as { currency?: string })?.currency ?? "INR").toUpperCase();
  return (c === "USD" ? "USD" : "INR") as Currency;
}

/**
 * Public Developer API (v1) — API-key authenticated, scoped, rate-limited.
 * Base path: /api/v1/developer   ·   Docs: /api/v1/developer/docs
 * Auth: send your key as the `X-API-Key` header (or `Authorization: Bearer`).
 */

const purchaseSchema = z.object({
  variantId: z.string().min(1),
  quantity: z.number().int().min(1).max(99).optional().default(1),
});

@ApiTags("developer")
@ApiSecurity("apiKey")
@Public()
@UseGuards(DeveloperApiGuard)
@Controller("developer")
export class DeveloperController {
  /** Verify your key and see its scopes. */
  @Get("ping")
  ping(@Req() req: DeveloperRequest) {
    return { ok: true, key: req.apiKey?.name, scopes: req.apiKey?.scopes ?? [] };
  }

  @Scopes("catalog:read")
  @Get("categories")
  async categories() {
    return listCategories(null);
  }

  @Scopes("catalog:read")
  @Get("products")
  async products(@Query() query: Record<string, string>, @Req() req: DeveloperRequest) {
    const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
    // The shared default page size is 6 (sized for Telegram buttons) — far too
    // small for an API consumer, which is why integrations only ever saw 6
    // products. Default to 100 here, allow up to 200, and support all=true.
    const wantAll = query.all === "true" || query.all === "1";
    const limit = Math.min(200, Math.max(1, Number.parseInt(query.limit ?? query.per_page ?? "100", 10) || 100));
    const currency = currencyOf(query);
    const baseOpts = {
      currency,
      search: query.search,
      categoryId: query.categoryId,
      featuredOnly: query.featured === "true",
      userId: req.apiKey?.ownerUserId ?? undefined,
      channel: "API" as const,
    };
    let res = await listProducts({ ...baseOpts, page: wantAll ? 1 : page, pageSize: wantAll ? 200 : limit });
    if (wantAll && res.pages > 1) {
      // Walk the remaining pages (hard-capped) so one call returns the catalogue.
      const items = [...res.items];
      for (let pg = 2; pg <= Math.min(res.pages, 10); pg++) {
        const more = await listProducts({ ...baseOpts, page: pg, pageSize: 200 });
        items.push(...more.items);
      }
      res = { ...res, items, page: 1, pages: 1 };
    }
    const inStockOnly = query.inStock === "true";
    const src = query.source; // "own" | "supplier" | undefined (both)
    const items = res.items
      .filter((p) => (inStockOnly ? p.inStock : true))
      .filter((p) => (src === "own" ? !p.supplierBacked : src === "supplier" ? p.supplierBacked : true))
      .map((p) => ({
        id: p.id,
        name: p.name,
        emoji: p.iconEmoji,
        // Prices are ALWAYS USDT for API consumers.
        currency: "USDT",
        fromPrice: usdtOf(p.fromPriceMinor, currency),
        fromPriceUsdt: usdtOf(p.fromPriceMinor, currency),
        nativeCurrency: currency,
        fromPriceMinor: p.fromPriceMinor,
        onSale: p.onSale,
        inStock: p.inStock,
        // true = fulfilled by an upstream supplier; still bought the same way.
        supplierBacked: p.supplierBacked,
        // Order with any of these: POST /orders { "variantId": ... }
        variants: p.variants.map((v) => ({
          id: v.id,
          name: v.name,
          price: usdtOf(v.priceMinor, currency),
          priceUsdt: usdtOf(v.priceMinor, currency),
          currency: "USDT",
          priceMinor: v.priceMinor,
          nativeCurrency: currency,
          ...stockOut(v.stock),
        })),
      }));
    return {
      items,
      page: res.page,
      pages: res.pages,
      pageSize: wantAll ? items.length : limit,
      total: res.total,
      hasMore: res.page < res.pages,
      currency: "USDT",
      nativeCurrency: currency,
      rate: { inrPerUsdt: usdtRate("INR") },
    };
  }

  @Scopes("catalog:read")
  @Get("products/:id")
  async product(@Param("id") id: string, @Query() query: Record<string, string>, @Req() req: DeveloperRequest) {
    try {
      const p = await getProductView(id, currencyOf(query), req.apiKey?.ownerUserId ?? undefined, "API");
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        emoji: p.iconEmoji,
        imageUrl: p.imageUrl,
        currency: "USDT",
        nativeCurrency: currencyOf(query),
        type: p.type,
        onSale: p.onSale,
        salePercentBp: p.salePercentBp,
        saleEndsAt: p.saleEndsAt,
        activationGuide: p.activationGuide,
        // true = stocked and fulfilled by an upstream supplier, delivered automatically
        supplierBacked: p.supplierBacked,
        variants: p.variants.map((v) => ({
          id: v.id,
          name: v.name,
          price: usdtOf(v.priceMinor, currencyOf(query)),
          priceUsdt: usdtOf(v.priceMinor, currencyOf(query)),
          originalPriceUsdt: usdtOf(v.originalPriceMinor, currencyOf(query)),
          currency: "USDT",
          priceMinor: v.priceMinor,
          originalPriceMinor: v.originalPriceMinor,
          ...stockOut(v.stock),
        })),
      };
    } catch {
      throw notFound("Product");
    }
  }

  @Scopes("catalog:read")
  @Get("products/:id/stock")
  async stock(@Param("id") id: string, @Query() query: Record<string, string>, @Req() req: DeveloperRequest) {
    try {
      const p = await getProductView(id, currencyOf(query), req.apiKey?.ownerUserId ?? undefined, "API");
      return {
        productId: p.id,
        name: p.name,
        onSale: p.onSale,
        currency: "USDT",
        variants: p.variants.map((v) => ({
          id: v.id, name: v.name,
          price: usdtOf(v.priceMinor, currencyOf(query)),
          priceUsdt: usdtOf(v.priceMinor, currencyOf(query)),
          currency: "USDT",
          priceMinor: v.priceMinor,
          originalPriceMinor: v.originalPriceMinor, ...stockOut(v.stock),
        })),
      };
    } catch {
      throw notFound("Product");
    }
  }

  /** Your recent orders. Probers GET the collection, so this must exist. */
  @Scopes("orders:read")
  @Get("orders")
  async orders(@Query() query: Record<string, string>, @Req() req: DeveloperRequest) {
    const ownerId = req.apiKey?.ownerUserId ?? null;
    if (!ownerId) throw forbidden("This API key isn't linked to a user account.");
    const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? "20", 10) || 20));
    const rows = await prisma.order.findMany({
      where: { userId: ownerId },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { items: { select: { productNameSnap: true, variantNameSnap: true, quantity: true } } },
    });
    return {
      items: rows.map((o) => ({
        orderNumber: o.orderNumber,
        status: o.status,
        total: toUsdt(o.totalMinor, o.currency as Currency),
        totalUsdt: toUsdt(o.totalMinor, o.currency as Currency),
        walletUsedUsdt: toUsdt(o.walletUsedMinor ?? 0, o.currency as Currency),
        currency: "USDT",
        nativeCurrency: o.currency,
        totalMinor: o.totalMinor,
        walletUsedMinor: o.walletUsedMinor,
        createdAt: o.createdAt,
        paidAt: o.paidAt,
        items: o.items.map((i) => ({ product: i.productNameSnap, variant: i.variantNameSnap, quantity: i.quantity })),
      })),
      total: rows.length,
    };
  }

  @Scopes("orders:read")
  @Get("orders/:orderNumber")
  async order(@Param("orderNumber") orderNumber: string, @Req() req: DeveloperRequest) {
    const ownerId = req.apiKey?.ownerUserId ?? null;
    const o = await prisma.order.findFirst({
      where: { orderNumber, ...(ownerId ? { userId: ownerId } : {}) },
      include: { items: { select: { productNameSnap: true, variantNameSnap: true, quantity: true } } },
    });
    if (!o) throw notFound("Order");
    return {
      orderNumber: o.orderNumber,
      status: o.status,
      total: toUsdt(o.totalMinor, o.currency as Currency),
      totalUsdt: toUsdt(o.totalMinor, o.currency as Currency),
      currency: "USDT",
      nativeCurrency: o.currency,
      totalMinor: o.totalMinor,
      createdAt: o.createdAt,
      paidAt: o.paidAt,
      items: o.items.map((i) => ({ product: i.productNameSnap, variant: i.variantNameSnap, quantity: i.quantity })),
    };
  }

  /** Your wallet balance, always expressed in USDT. */
  @Scopes("wallet:read")
  @Get("wallet")
  async wallet(@Req() req: DeveloperRequest) {
    const userId = req.apiKey?.ownerUserId;
    if (!userId) throw forbidden("This API key isn't linked to a user account.");
    const w = await getWallet(userId);
    const native = Number(w.balanceMinor);
    const usdt = toUsdt(native, w.currency);
    return {
      // Primary, and what integrations should read: always USDT.
      balance: usdt,
      balanceUsdt: usdt,
      currency: "USDT",
      // The underlying wallet, for reference.
      nativeBalanceMinor: native,
      nativeCurrency: w.currency,
      rate: { inrPerUsdt: usdtRate("INR") },
    };
  }

  /** Balance + your recent wallet ledger (last 10 entries). */
  @Scopes("wallet:read")
  @Get("balance")
  async balance(@Req() req: DeveloperRequest) {
    const userId = req.apiKey?.ownerUserId;
    if (!userId) throw forbidden("This API key isn't linked to a user account.");
    const [w, ledger] = await Promise.all([getWallet(userId), getLedger(userId, 1, 10)]);
    const native = Number(w.balanceMinor);
    const usdt = toUsdt(native, w.currency);
    return {
      // Always USDT — integrations should read `balance` / `balanceUsdt`.
      balance: usdt,
      balanceUsdt: usdt,
      currency: "USDT",
      nativeBalanceMinor: native,
      nativeCurrency: w.currency,
      rate: { inrPerUsdt: usdtRate("INR") },
      ledger: ledger.entries.map((e) => ({
        type: e.type,
        amountUsdt: toUsdt(Number(e.amountMinor), w.currency),
        balanceAfterUsdt: toUsdt(Number(e.balanceAfterMinor), w.currency),
        amountMinor: Number(e.amountMinor),
        balanceAfterMinor: Number(e.balanceAfterMinor),
        note: e.note,
        at: e.createdAt,
      })),
    };
  }

  /**
   * Purchase a variant, paid from your wallet balance. Delivers instantly for
   * auto-fulfilled products (secrets are returned in the response).
   * Body: { "variantId": "...", "quantity": 1 }
   */
  @Scopes("orders:write")
  @Post("orders")
  async purchase(@Body() body: unknown, @Req() req: DeveloperRequest) {
    const userId = req.apiKey?.ownerUserId;
    if (!userId) throw forbidden("This API key isn't linked to a user account, so it can't purchase.");
    const parsed = purchaseSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(400, "VALIDATION_FAILED", parsed.error.issues[0]?.message ?? "Invalid body.");
    const { variantId, quantity } = parsed.data;
    const idemRaw = req.headers["idempotency-key"];
    const idem = (Array.isArray(idemRaw) ? idemRaw[0] : idemRaw)?.trim();
    const idemKey = idem ? `apiidem:${req.apiKey?.id}:${idem}` : null;
    if (idemKey) {
      const prev = await getRedis().get(idemKey);
      if (prev) {
        const o = await prisma.order.findFirst({ where: { orderNumber: prev, userId } });
        if (o) return { orderNumber: o.orderNumber, status: o.status, currency: o.currency, totalMinor: o.totalMinor, replayed: true, items: [] };
      }
    }
    try {
      await clearCart(userId);
      await addToCart(userId, variantId, quantity);
      const r = await checkoutWithWallet(userId, "API");
      if (idemKey) await getRedis().set(idemKey, r.orderNumber, "EX", 86400);

      let items: Array<{ product: string; variant: string; kind: string; secret: unknown; activationGuide?: string | null }> =
        r.deliveries.map((d) => ({
          product: d.productName,
          variant: d.variantName,
          kind: d.kind as string,
          secret: d.secret as unknown,
          activationGuide: d.activationGuide,
        }));
      let status: string = r.status;
      let pending = r.pendingManualItems;

      // Supplier-backed items are fulfilled right after the order transaction
      // commits, so they are missing from `r.deliveries`. Re-read what was
      // actually delivered so API clients get their keys in this response.
      if (pending > 0) {
        try {
          // Supplier-backed lines are bought upstream immediately after the order
          // tx commits; give a slow supplier a moment before reading deliveries.
          for (let attempt = 0; attempt < 3; attempt++) {
            const done = await prisma.orderItem.count({ where: { orderId: r.orderId, fulfilledAt: null } });
            if (done === 0) break;
            await new Promise((res) => setTimeout(res, 1200));
          }
          const delivered = await revealOrderDeliveries(userId, r.orderId);
          if (delivered.length > items.length) {
            items = delivered.map((d) => ({
              product: d.productName,
              variant: d.variantName,
              kind: d.payload.kind,
              secret: d.payload as unknown,
            }));
            const fresh = await prisma.order.findUnique({ where: { id: r.orderId }, select: { status: true } });
            if (fresh) status = fresh.status;
            pending = Math.max(0, pending - (delivered.length - r.deliveries.length));
          }
        } catch {
          // fall back to the transaction-time deliveries
        }
      }

      return {
        orderNumber: r.orderNumber,
        status,
        charged: toUsdt(r.totalMinor, r.currency as Currency),
        chargedUsdt: toUsdt(r.totalMinor, r.currency as Currency),
        currency: "USDT",
        nativeCurrency: r.currency,
        totalMinor: r.totalMinor,
        pendingManualItems: pending,
        items,
      };
    } catch (e) {
      if (isCoreError(e)) {
        const status = e.code === "INSUFFICIENT_BALANCE" ? 402 : 400;
        throw new ApiError(status, e.code, e.message);
      }
      throw e;
    }
  }
}


function docsPage(): string {
  const cfg = loadConfig();
  const base = `${(cfg.PUBLIC_API_URL ?? "").replace(/\/$/, "")}/api/v1/developer`;
  const store = cfg.STORE_NAME;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${store} — Developer API</title>
<style>
  :root{--bg:#0b0e14;--card:#131824;--line:#232a3a;--fg:#e6e9f0;--mut:#9aa4b2;--acc:#4ade80;--acc2:#38bdf8;--code:#0f1420;}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
  .wrap{max-width:900px;margin:0 auto;padding:32px 20px 80px}
  h1{font-size:28px;margin:0 0 4px}h2{font-size:19px;margin:34px 0 12px;border-bottom:1px solid var(--line);padding-bottom:8px}
  .sub{color:var(--mut);margin:0 0 24px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:12px 0}
  code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  code{background:var(--code);padding:2px 6px;border-radius:6px;color:var(--acc2)}
  pre{background:var(--code);border:1px solid var(--line);border-radius:10px;padding:14px;overflow:auto;color:#d7dbe6}
  .ep{display:flex;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)}
  .ep:last-child{border-bottom:0}
  .m{font-weight:700;font-size:12px;padding:3px 8px;border-radius:6px;min-width:52px;text-align:center}
  .get{background:rgba(56,189,248,.15);color:var(--acc2)}.post{background:rgba(74,222,128,.15);color:var(--acc)}
  .path{color:var(--fg)}.desc{color:var(--mut);margin-left:auto;text-align:right;font-size:13px}
  a{color:var(--acc2)}.pill{display:inline-block;background:rgba(74,222,128,.12);color:var(--acc);border-radius:999px;padding:2px 10px;font-size:12px;margin-left:8px}
  ul{margin:8px 0;padding-left:20px}li{margin:4px 0;color:var(--mut)}li b{color:var(--fg)}
</style></head><body><div class="wrap">
<h1>${store} — Developer API <span class="pill">v1</span></h1>
<p class="sub">REST API for programmatic catalog access and order placement.</p>

<div class="card"><b>Base URL</b><br/><code>${base}</code><br/><br/>\n<b>Importing this API into another shop?</b> Point your importer at:<br/>\n<code>${base}/docs.txt</code> (plain text) or <code>${base}/manifest</code> (JSON)</div>

<h2>Authentication</h2>
<div class="card">Send your key on every request (except <code>/health</code>) as a header:
<pre>Authorization: Bearer YOUR_API_KEY
# or
X-API-Key: YOUR_API_KEY</pre>
Create a key in the bot: open the menu → <b>🧑‍💻 Developer API</b> → <b>Create API key</b>.</div>

<h2>Endpoints</h2>
<div class="card">
  <div class="ep"><span class="m get">GET </span><code class="path">/health</code><span class="desc">liveness (no auth)</span></div>
  <div class="ep"><span class="m get">GET </span><code class="path">/products</code><span class="desc">buyable catalog (incl. variantIds)</span></div>
  <div class="ep"><span class="m get">GET </span><code class="path">/products?all=true</code><span class="desc">entire catalogue, one call</span></div>
  <div class="ep"><span class="m get">GET </span><code class="path">/products?limit=200&amp;page=2</code><span class="desc">paged (limit 1-200, default 100)</span></div>
  <div class="ep"><span class="m get">GET </span><code class="path">/products?inStock=true</code><span class="desc">in-stock only</span></div>
  <div class="ep"><span class="m get">GET </span><code class="path">/products/{id}</code><span class="desc">one product</span></div>
  <div class="ep"><span class="m get">GET </span><code class="path">/products/{id}/stock</code><span class="desc">live stock & price</span></div>
  <div class="ep"><span class="m get">GET </span><code class="path">/categories</code><span class="desc">categories</span></div>
  <div class="ep"><span class="m get">GET </span><code class="path">/balance</code><span class="desc">balance in USDT + ledger</span></div>
  <div class="ep"><span class="m post">POST </span><code class="path">/orders</code><span class="desc">place an order</span></div>
  <div class="ep"><span class="m get">GET </span><code class="path">/orders</code><span class="desc">your recent orders</span></div>
  <div class="ep"><span class="m get">GET </span><code class="path">/orders/{orderNumber}</code><span class="desc">a single order</span></div>
  <div class="ep"><span class="m get">GET </span><code class="path">/wallet</code><span class="desc">balance only</span></div>
  <div class="ep"><span class="m get">GET </span><code class="path">/ping</code><span class="desc">verify key + see its scopes</span></div>
</div>

<h2>Place an order</h2>
<div class="card">
Body:
<pre>{ "variantId": "VARIANT_ID", "quantity": 2 }</pre>
Paid from your wallet balance — top up via the bot's <b>💳 Deposit</b> menu. Always send an
<code>Idempotency-Key</code> header so a retry never double-charges. Delivered codes/credentials are returned in the response on success.
<pre>curl -X POST "${base}/orders" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"variantId":"VARIANT_ID","quantity":1}'</pre>
</div>

<h2>Catalog response</h2>
<div class="card">
<code>/products</code> returns every buyable variant inline, so you can order straight from the list — no second call needed:
<pre>{
  "items": [
    { "id": "PRODUCT_ID", "name": "Youtube 3M", "currency": "INR",
      "fromPriceMinor": 15920, "onSale": false, "inStock": true,
      "variants": [
        { "id": "VARIANT_ID", "name": "Standard",
          "priceMinor": 15920, "stock": 42, "unlimited": false, "inStock": true }
      ] }
  ], "page": 1, "pages": 3, "total": 54, "currency": "INR"
}</pre>
<ul>
<li><b>variants[].id</b> is what you send as <code>variantId</code> to <code>POST /orders</code>.</li>
<li><b>All prices are USDT.</b> Every product, variant and order returns <code>price</code>/<code>priceUsdt</code> (2dp string) with <code>currency: "USDT"</code>. Raw <code>priceMinor</code> and <code>nativeCurrency</code> are also included for reference.</li>
<li><b>stock</b> is the real number available. For supplier-backed products this is the upstream supplier stock.</li>
<li><b>unlimited: true</b> means the item is not unit-stocked (<code>stock</code> is <code>null</code>); it is always orderable.</li>
<li>Add <code>?inStock=true</code> to receive only orderable products.</li>
<li><b>Supplier-backed items are included and fully purchasable</b> — they carry <code>supplierBacked: true</code>, are bought with the same <code>POST /orders</code> call, and their keys come back in that response. Filter with <code>?source=supplier</code> or <code>?source=own</code>.</li>
<li><b>Getting only a handful of products?</b> Pass <code>?all=true</code> for the whole catalogue in one call, or page with <code>?limit=200&amp;page=N</code>. Default page size is <b>100</b>; the response carries <code>total</code>, <code>pages</code> and <code>hasMore</code>.</li>
</ul>
</div>

<h2>Notes</h2>
<div class="card"><ul>
<li><b>Supplier-backed products</b> — items flagged <code>supplierBacked: true</code> are stocked upstream and delivered automatically; your keys come back in the <code>POST /orders</code> response just like local stock.</li>
<li><b>Balance is always USDT</b> — <code>/balance</code> and <code>/wallet</code> return <code>balance</code> / <code>balanceUsdt</code> as a 2dp USDT string with <code>currency: "USDT"</code>, whatever currency the wallet is held in. The underlying values are also included as <code>nativeBalanceMinor</code> / <code>nativeCurrency</code>, plus the <code>inrPerUsdt</code> rate used.</li>
<li><b>Single balance</b> — API orders are paid from your main wallet; top up via the Deposit menu.</li>
<li><b>Rate limit</b> — 60 requests/min per key (configurable per key).</li>
<li>All monetary amounts are integer <b>minor units</b> (e.g. cents); currency is on each response.</li>
<li>All timestamps are <b>ISO-8601 UTC</b>.</li>
<li><b>Getting 403 on /balance or /orders?</b> Your key is missing a scope. Call <code>GET /ping</code> — it lists the scopes the key actually has. <code>/balance</code> needs <code>wallet:read</code>, <code>/orders</code> needs <code>orders:read</code>, placing an order needs <code>orders:write</code>. Regenerate the key in the bot (🧑‍💻 Developer API) to get all of them.</li>
<li><b>Full endpoint paths</b> — every route is under <code>${base}</code>, e.g. balance is <code>${base}/balance</code> (needs the <code>wallet:read</code> scope), not <code>/balance</code> at the domain root.</li>
<li>Interactive reference: <a href="${base}/docs">${base}/docs</a></li>
</ul></div>

<h2>Example</h2>
<div class="card"><pre>curl -H "Authorization: Bearer YOUR_API_KEY" \
  "${base}/products"</pre></div>
</div></body></html>`;
}

/** Public developer-API docs page + health check (no auth). */
@ApiTags("developer")
@Public()
@Controller("developer")
export class DeveloperDocsController {
  @Get("health")
  health() {
    return { ok: true, service: "developer-api", ts: new Date().toISOString() };
  }

  @Get()
  @Header("Content-Type", "text/html; charset=utf-8")
  docsRoot(): string {
    return docsPage();
  }

  @Get("guide")
  @Header("Content-Type", "text/html; charset=utf-8")
  guide(): string {
    return docsPage();
  }

  /** Machine-readable integration manifest — importers should use this. */
  @Get("manifest")
  manifest() {
    const base = `${(loadConfig().PUBLIC_API_URL ?? "").replace(/\/$/, "")}/api/v1/developer`;
    return {
      name: loadConfig().STORE_NAME,
      version: "1",
      base_url: base,
      auth: { type: "bearer", header: "Authorization", format: "Bearer {API_KEY}", alt_header: "X-API-Key" },
      endpoints: {
        products: { method: "GET", path: "/products", query: { all: "true", limit: "1-200", page: "N", inStock: "true", source: "own|supplier" } },
        product: { method: "GET", path: "/products/{id}" },
        stock: { method: "GET", path: "/products/{id}/stock" },
        balance: { method: "GET", path: "/balance", scope: "wallet:read", returns: { balance: "USDT string", currency: "USDT" } },
        wallet: { method: "GET", path: "/wallet", scope: "wallet:read" },
        orders_list: { method: "GET", path: "/orders", scope: "orders:read" },
        order_detail: { method: "GET", path: "/orders/{orderNumber}", scope: "orders:read" },
        place_order: { method: "POST", path: "/orders", scope: "orders:write", body: { variantId: "string", quantity: "number" }, headers: { "Idempotency-Key": "unique per order" } },
        ping: { method: "GET", path: "/ping" },
      },
      response_fields: {
        products_list: "items",
        product_id: "id",
        variant_id: "variants[].id",
        price: "variants[].priceUsdt",
        price_unit: "USDT (2dp string)",
        price_raw: "variants[].priceMinor",
        stock: "variants[].stock",
        unlimited_flag: "variants[].unlimited",
        currency: "currency",
      },
      notes: [
        "All prices, balances and order totals are reported in USDT (price/priceUsdt/total, currency=USDT).",
        "priceMinor/nativeCurrency are the underlying values, in integer MINOR units.",
        "Order using variants[].id as variantId.",
        "supplierBacked=true items are fulfilled upstream but bought identically.",
        "A 403 means the key lacks a scope — GET /ping lists the key's scopes.",
        "Wallet balance is always reported in USDT (balance / balanceUsdt, currency=USDT).",
      ],
    };
  }

  /** Plain-text docs: easiest thing for a scraper or an LLM to read. */
  @Get("docs.txt")
  @Header("Content-Type", "text/plain; charset=utf-8")
  docsText(): string {
    const base = `${(loadConfig().PUBLIC_API_URL ?? "").replace(/\/$/, "")}/api/v1/developer`;
    return [
      `${loadConfig().STORE_NAME} — Developer API v1`,
      "",
      `Base URL: ${base}`,
      "",
      "Authentication:",
      "  Authorization: Bearer YOUR_API_KEY",
      "  (or) X-API-Key: YOUR_API_KEY",
      "",
      "Endpoints:",
      "  GET /ping",
      "  GET /products",
      "  GET /products?all=true",
      "  GET /products?limit=200&page=1",
      "  GET /products/{id}",
      "  GET /products/{id}/stock",
      "  GET /balance",
      "  GET /wallet",
      "  GET /orders",
      "  GET /orders/{orderNumber}",
      "  POST /orders",
      "",
      'POST /orders body: { "variantId": "VARIANT_ID", "quantity": 1 }',
      "POST /orders header: Idempotency-Key: <unique-per-order>",
      "",
      "Response fields:",
      '  products list: "items"',
      '  product id: "id"',
      '  variant id: "variants[].id"',
      '  price: "variants[].price" / "variants[].priceUsdt"  (USDT, 2dp string)',
      '  price (raw): "variants[].priceMinor" + "nativeCurrency"  (integer MINOR units)',
      '  balance: "balance" / "balanceUsdt"  (USDT, 2dp string; currency is always "USDT")',
      '  stock: "variants[].stock"  ("unlimited": true means no limit)',
      "",
      "Scopes: catalog:read, orders:read, orders:write, wallet:read",
      "A 403 response means the key is missing a scope; GET /ping lists them.",
      "",
      `Machine-readable manifest: ${base}/manifest`,
      "",
    ].join("\n");
  }
}

@Module({ controllers: [DeveloperDocsController, DeveloperController] })
export class DeveloperModule {}
