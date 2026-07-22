import { addToCart, checkoutWithWallet, clearCart, getLedger, getProductView, getRedis, getWallet, listCategories, listProducts } from "@gis/core";
import { loadConfig } from "@gis/config";
import { prisma, type Currency } from "@gis/database";
import { Body, Controller, Get, Header, Module, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { isCoreError } from "@gis/shared";
import { z } from "zod";
import { ApiError, forbidden, notFound } from "../common/errors.js";
import { DeveloperApiGuard, Scopes, type DeveloperRequest } from "../common/developer.guard.js";
import { Public } from "../common/permissions.decorator.js";

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
    return listProducts({
      currency: currencyOf(query),
      page,
      search: query.search,
      categoryId: query.categoryId,
      featuredOnly: query.featured === "true",
      userId: req.apiKey?.ownerUserId ?? undefined,
      channel: "API",
    });
  }

  @Scopes("catalog:read")
  @Get("products/:id")
  async product(@Param("id") id: string, @Query() query: Record<string, string>, @Req() req: DeveloperRequest) {
    try {
      return await getProductView(id, currencyOf(query), req.apiKey?.ownerUserId ?? undefined, "API");
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
        variants: p.variants.map((v) => ({
          id: v.id, name: v.name, priceMinor: v.priceMinor,
          originalPriceMinor: v.originalPriceMinor, inStock: v.stock > 0, stock: v.stock,
        })),
      };
    } catch {
      throw notFound("Product");
    }
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
      currency: o.currency,
      totalMinor: o.totalMinor,
      createdAt: o.createdAt,
      paidAt: o.paidAt,
      items: o.items.map((i) => ({ product: i.productNameSnap, variant: i.variantNameSnap, quantity: i.quantity })),
    };
  }

  /** Your wallet balance (the account this key is linked to). */
  @Scopes("wallet:read")
  @Get("wallet")
  async wallet(@Req() req: DeveloperRequest) {
    const userId = req.apiKey?.ownerUserId;
    if (!userId) throw forbidden("This API key isn't linked to a user account.");
    const w = await getWallet(userId);
    return { balanceMinor: Number(w.balanceMinor), currency: w.currency };
  }

  /** Balance + your recent wallet ledger (last 10 entries). */
  @Scopes("wallet:read")
  @Get("balance")
  async balance(@Req() req: DeveloperRequest) {
    const userId = req.apiKey?.ownerUserId;
    if (!userId) throw forbidden("This API key isn't linked to a user account.");
    const [w, ledger] = await Promise.all([getWallet(userId), getLedger(userId, 1, 10)]);
    return {
      balanceMinor: Number(w.balanceMinor),
      currency: w.currency,
      ledger: ledger.entries.map((e) => ({
        type: e.type,
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
      return {
        orderNumber: r.orderNumber,
        status: r.status,
        currency: r.currency,
        totalMinor: r.totalMinor,
        pendingManualItems: r.pendingManualItems,
        items: r.deliveries.map((d) => ({
          product: d.productName,
          variant: d.variantName,
          kind: d.kind,
          secret: d.secret,
          activationGuide: d.activationGuide,
        })),
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

<div class="card"><b>Base URL</b><br/><code>${base}</code></div>

<h2>Authentication</h2>
<div class="card">Send your key on every request (except <code>/health</code>) as a header:
<pre>Authorization: Bearer YOUR_API_KEY
# or
X-API-Key: YOUR_API_KEY</pre>
Create a key in the bot: open the menu → <b>🧑‍💻 Developer API</b> → <b>Create API key</b>.</div>

<h2>Endpoints</h2>
<div class="card">
  <div class="ep"><span class="m get">GET</span><code class="path">/health</code><span class="desc">liveness (no auth)</span></div>
  <div class="ep"><span class="m get">GET</span><code class="path">/products</code><span class="desc">buyable catalog</span></div>
  <div class="ep"><span class="m get">GET</span><code class="path">/products/{id}</code><span class="desc">one product</span></div>
  <div class="ep"><span class="m get">GET</span><code class="path">/products/{id}/stock</code><span class="desc">live stock & price</span></div>
  <div class="ep"><span class="m get">GET</span><code class="path">/categories</code><span class="desc">categories</span></div>
  <div class="ep"><span class="m get">GET</span><code class="path">/balance</code><span class="desc">balance + recent ledger</span></div>
  <div class="ep"><span class="m post">POST</span><code class="path">/orders</code><span class="desc">place an order</span></div>
  <div class="ep"><span class="m get">GET</span><code class="path">/orders/{orderNumber}</code><span class="desc">a single order</span></div>
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

<h2>Notes</h2>
<div class="card"><ul>
<li><b>Single balance</b> — API orders are paid from your main wallet; top up via the Deposit menu.</li>
<li><b>Rate limit</b> — 60 requests/min per key (configurable per key).</li>
<li>All monetary amounts are integer <b>minor units</b> (e.g. cents); currency is on each response.</li>
<li>All timestamps are <b>ISO-8601 UTC</b>.</li>
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
}

@Module({ controllers: [DeveloperDocsController, DeveloperController] })
export class DeveloperModule {}
