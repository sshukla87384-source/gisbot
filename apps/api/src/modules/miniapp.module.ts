import { buildMiniAppCatalog, getMiniAppConfig, miniAppProfile, verifyInitData } from "@gis/core";
import { loadConfig } from "@gis/config";
import { Body, Controller, Get, Header, Module, Post, Query, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { ApiError } from "../common/errors.js";
import { Public, SkipEnvelope } from "../common/permissions.decorator.js";
import type { ApiResponse } from "../common/types.js";

/**
 * Telegram Mini App storefront.
 *
 *   GET  /miniapp                  the page (HTML, self-contained)
 *   GET  /miniapp/catalog?currency  public catalogue JSON (cached a minute in core)
 *   POST /miniapp/me {initData}     the viewer's name/currency/balance, HMAC-verified
 *
 * The page never sells anything itself: Buy opens the bot at the product
 * deep link, so payment rails, coupons, wallet and the order limits all run
 * through the one checkout. The CSP is route-level because helmet's default
 * forbids both the Telegram SDK and the inline script, and `frame-ancestors`
 * must admit web.telegram.org (the Web client embeds Mini Apps in an iframe).
 */
const MINIAPP_CSP =
  "default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'none'; " +
  "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org https://*.t.me; " +
  "script-src 'self' 'unsafe-inline' https://telegram.org; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'";

const currencyQ = z.enum(["USD", "INR"]).catch("USD");
const meBody = z.object({ initData: z.string().min(1).max(8192) });

@ApiTags("miniapp")
@Public()
@Controller("miniapp")
export class MiniAppController {
  @Get()
  @SkipEnvelope()
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Content-Security-Policy", MINIAPP_CSP)
  @Header("Cache-Control", "no-store")
  async page(@Res({ passthrough: true }) res: ApiResponse): Promise<string> {
    // helmet adds X-Frame-Options: SAMEORIGIN; CSP frame-ancestors is the
    // modern rule and must win, so the legacy header goes.
    res.removeHeader("X-Frame-Options");
    const cfg = await getMiniAppConfig();
    if (!cfg.enabled) return disabledPage(loadConfig().STORE_NAME);
    return storefrontPage(loadConfig().STORE_NAME);
  }

  @Get("catalog")
  @Header("Cache-Control", "public, max-age=30")
  async catalog(@Query("currency") currency?: string) {
    const cfg = await getMiniAppConfig();
    if (!cfg.enabled) throw new ApiError(404, "DISABLED", "Mini App is turned off.");
    return buildMiniAppCatalog(currencyQ.parse(currency));
  }

  @Post("me")
  async me(@Body() body: unknown) {
    const parsed = meBody.safeParse(body);
    if (!parsed.success) throw new ApiError(400, "VALIDATION", "initData required");
    const user = verifyInitData(parsed.data.initData);
    if (!user) throw new ApiError(401, "BAD_INITDATA", "Telegram signature check failed.");
    const profile = await miniAppProfile(user.telegramId);
    return { user, ...profile };
  }
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function disabledPage(store: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(store)}</title>
<style>body{font-family:system-ui,sans-serif;background:var(--tg-theme-bg-color,#fff);color:var(--tg-theme-text-color,#111);display:grid;place-items:center;height:100vh;margin:0;text-align:center}</style></head>
<body><div><div style="font-size:48px">🛍</div><h2>${esc(store)}</h2><p>The web shop is taking a short break.<br>Please use the bot menu to browse.</p></div></body></html>`;
}

function storefrontPage(store: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${esc(store)}</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{--bg:var(--tg-theme-bg-color,#f4f4f7);--sbg:var(--tg-theme-secondary-bg-color,#fff);--tx:var(--tg-theme-text-color,#111);--hint:var(--tg-theme-hint-color,#8a8a8e);--acc:var(--tg-theme-button-color,#2ea6ff);--acct:var(--tg-theme-button-text-color,#fff);--link:var(--tg-theme-link-color,#2ea6ff);--r:14px}
*{box-sizing:border-box}html,body{margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;background:var(--bg);color:var(--tx);padding-bottom:calc(24px + env(safe-area-inset-bottom))}
header{position:sticky;top:0;z-index:5;background:var(--bg);padding:12px 14px 8px}
.top{display:flex;align-items:center;justify-content:space-between;gap:10px}
.brand{font-weight:800;font-size:18px;letter-spacing:-.2px}
.me{font-size:12px;color:var(--hint);text-align:right;line-height:1.3}
.me b{color:var(--tx)}
.search{margin-top:10px;display:flex;align-items:center;background:var(--sbg);border-radius:12px;padding:0 12px;height:40px}
.search input{flex:1;border:0;background:transparent;color:var(--tx);font-size:15px;outline:0;height:100%}
.chips{display:flex;gap:8px;overflow-x:auto;padding:10px 14px 4px;scrollbar-width:none}.chips::-webkit-scrollbar{display:none}
.chip{flex:0 0 auto;padding:7px 12px;border-radius:999px;background:var(--sbg);font-size:13px;white-space:nowrap;border:1px solid transparent;cursor:pointer}
.chip.on{background:var(--acc);color:var(--acct)}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;padding:8px 14px}
.card{background:var(--sbg);border-radius:var(--r);overflow:hidden;position:relative;cursor:pointer;display:flex;flex-direction:column;min-height:170px;transition:transform .08s}
.card:active{transform:scale(.97)}
.img{aspect-ratio:1/1;background:linear-gradient(135deg,rgba(46,166,255,.18),rgba(255,120,200,.18));display:grid;place-items:center;font-size:42px;overflow:hidden}
.img img{width:100%;height:100%;object-fit:cover;display:block}
.body{padding:8px 10px 10px;display:flex;flex-direction:column;gap:3px;flex:1}
.name{font-size:13.5px;font-weight:600;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.price{font-weight:800;font-size:15px;margin-top:auto}
.was{color:var(--hint);text-decoration:line-through;font-weight:500;font-size:12px;margin-left:6px}
.meta{font-size:11.5px;color:var(--hint);display:flex;justify-content:space-between}
.badge{position:absolute;top:8px;left:8px;background:#ff3b30;color:#fff;font-size:11px;font-weight:700;padding:3px 7px;border-radius:999px}
.badge.ok{background:#34c759}.badge.out{background:#8e8e93}
.card.out .img{filter:grayscale(1);opacity:.6}
.empty{text-align:center;color:var(--hint);padding:60px 20px}
.sk{background:var(--sbg);border-radius:var(--r);min-height:200px;animation:pulse 1.2s infinite}
@keyframes pulse{0%,100%{opacity:.5}50%{opacity:1}}
.sheet-bg{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10;display:none}
.sheet{position:fixed;left:0;right:0;bottom:0;background:var(--sbg);border-radius:20px 20px 0 0;z-index:11;transform:translateY(105%);transition:transform .22s ease;max-height:88vh;overflow:auto;padding:0 16px calc(16px + env(safe-area-inset-bottom))}
.sheet.open{transform:none}.sheet-bg.open{display:block}
.handle{width:40px;height:4px;border-radius:2px;background:var(--hint);margin:10px auto 12px;opacity:.5}
.hero{height:160px;border-radius:14px;overflow:hidden;background:linear-gradient(135deg,rgba(46,166,255,.18),rgba(255,120,200,.18));display:grid;place-items:center;font-size:64px}
.hero img{width:100%;height:100%;object-fit:cover}
h2{font-size:19px;margin:14px 0 4px;line-height:1.25}
.desc{font-size:14px;color:var(--hint);white-space:pre-wrap;line-height:1.45;margin:6px 0 12px;max-height:150px;overflow:auto}
.vars{display:flex;flex-direction:column;gap:8px;margin:8px 0 14px}
.var{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-radius:12px;background:var(--bg);font-size:14px}
.var.out{opacity:.5}
.var b{font-size:15px}
.btn{display:block;width:100%;border:0;border-radius:12px;background:var(--acc);color:var(--acct);font-size:16px;font-weight:700;padding:14px;cursor:pointer}
.btn[disabled]{opacity:.5}
.rating{font-size:12.5px;color:var(--hint);margin-top:2px}
.foot{text-align:center;font-size:11.5px;color:var(--hint);padding:18px 14px 0}
</style>
</head>
<body>
<header>
  <div class="top">
    <div class="brand">🛍 ${esc(store)}</div>
    <div class="me" id="me"></div>
  </div>
  <div class="search">🔍&nbsp;<input id="q" type="search" placeholder="Search products…" autocomplete="off"></div>
</header>
<div class="chips" id="chips"></div>
<div class="grid" id="grid"><div class="sk"></div><div class="sk"></div><div class="sk"></div><div class="sk"></div></div>
<div class="foot" id="foot"></div>
<div class="sheet-bg" id="sbg"></div>
<div class="sheet" id="sheet"></div>
<script>
(function(){
  var tg = window.Telegram && Telegram.WebApp; if (tg) { tg.ready(); tg.expand(); }
  // The page lives at …/miniapp (with or without a trailing slash); its JSON sits beneath it.
  var base = location.pathname.replace(/[/]+$/, "");
  var cat = null, currency = "USD", bot = null, active = "all", q = "";
  var $ = function(id){ return document.getElementById(id); };
  function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }
  function money(minor, cur){ if (minor==null) return ""; var n = minor/100; var s = cur==="INR" ? "₹" : "$"; return s + (Number.isInteger(n) ? n.toLocaleString("en-IN") : n.toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2})); }
  function stockText(p){ if (!p.inStock) return "Sold out"; if (p.stock==null) return "In stock"; return p.stock + " left"; }
  function render(){
    var list = cat.products.filter(function(p){
      if (active !== "all" && p.categoryId !== active) return false;
      if (q) { var h = (p.name + " " + (p.description||"")).toLowerCase(); if (h.indexOf(q) < 0) return false; }
      return true;
    });
    var g = $("grid");
    if (!list.length) { g.innerHTML = '<div class="empty" style="grid-column:1/-1">Nothing here yet 🙈</div>'; return; }
    g.innerHTML = list.map(function(p, i){
      var badge = !p.inStock ? '<span class="badge out">Sold out</span>' : p.onSale ? '<span class="badge">SALE</span>' : (p.stock!=null && p.stock<=5 ? '<span class="badge">Only '+p.stock+' left</span>' : "");
      var img = p.imageUrl ? '<img loading="lazy" src="'+esc(p.imageUrl)+'" alt="">' : esc(p.iconEmoji || "🎁");
      return '<div class="card'+(p.inStock?"":" out")+'" data-i="'+i+'">'+badge+'<div class="img">'+img+'</div><div class="body"><div class="name">'+esc(p.name)+'</div>'
        + (p.rating ? '<div class="rating">⭐ '+p.rating+' ('+p.ratingCount+')</div>' : '')
        + '<div class="price">'+money(p.fromPriceMinor, cat.currency)+(p.wasPriceMinor?'<span class="was">'+money(p.wasPriceMinor, cat.currency)+'</span>':'')+'</div>'
        + '<div class="meta"><span>'+(p.variants.length>1 ? p.variants.length+' options' : '')+'</span><span>'+stockText(p)+'</span></div></div></div>';
    }).join("");
    Array.prototype.forEach.call(g.querySelectorAll(".card"), function(el){ el.onclick = function(){ open(list[+el.getAttribute("data-i")]); }; });
  }
  function chips(){
    var c = $("chips");
    var all = [{id:"all", name:"All", emoji:"✨", count: cat.products.length}].concat(cat.categories);
    c.innerHTML = all.map(function(x){ return '<div class="chip'+(active===x.id?" on":"")+'" data-id="'+esc(x.id)+'">'+esc((x.emoji?x.emoji+" ":"")+x.name)+' · '+x.count+'</div>'; }).join("");
    Array.prototype.forEach.call(c.children, function(el){ el.onclick = function(){ active = el.getAttribute("data-id"); if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged(); chips(); render(); }; });
  }
  function open(p){
    var s = $("sheet");
    var hero = p.imageUrl ? '<img src="'+esc(p.imageUrl)+'" alt="">' : esc(p.iconEmoji||"🎁");
    s.innerHTML = '<div class="handle"></div><div class="hero">'+hero+'</div><h2>'+esc(p.name)+'</h2>'
      + (p.rating ? '<div class="rating">⭐ '+p.rating+' · '+p.ratingCount+' reviews</div>' : '')
      + (p.description ? '<div class="desc">'+esc(p.description)+'</div>' : '<div style="height:8px"></div>')
      + '<div class="vars">'+p.variants.map(function(v){ return '<div class="var'+(v.inStock?"":" out")+'"><span>'+esc(v.name)+(v.inStock?"":" · sold out")+'</span><b>'+money(v.priceMinor, cat.currency)+'</b></div>'; }).join("")+'</div>'
      + '<button class="btn" id="buy"'+(p.inStock?"":" disabled")+'>'+(p.inStock ? "🛒 Buy in bot — " + money(p.fromPriceMinor, cat.currency) : "🔔 Sold out") + '</button>'
      + '<div class="foot">Checkout happens in the chat: wallet, UPI, Binance Pay &amp; crypto all work there.</div>';
    s.classList.add("open"); $("sbg").classList.add("open");
    if (tg && tg.BackButton) { tg.BackButton.show(); tg.BackButton.onClick(close); }
    var b = $("buy");
    if (b) b.onclick = function(){
      if (!bot) { alert("Bot link unavailable — open the product from the bot menu."); return; }
      var link = "https://t.me/" + bot + "?start=p_" + encodeURIComponent(p.slug);
      if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred("medium");
      if (tg && tg.openTelegramLink) { tg.openTelegramLink(link); setTimeout(function(){ tg.close(); }, 300); }
      else location.href = link;
    };
  }
  function close(){ $("sheet").classList.remove("open"); $("sbg").classList.remove("open"); if (tg && tg.BackButton) { tg.BackButton.hide(); tg.BackButton.offClick(close); } }
  $("sbg").onclick = close;
  $("q").oninput = function(e){ q = e.target.value.trim().toLowerCase(); render(); };
  function load(){
    fetch(base + "/catalog?currency=" + currency, { headers: { accept: "application/json" } })
      .then(function(r){ return r.json(); })
      .then(function(j){
        cat = j.data || j; bot = cat.botUsername;
        $("foot").textContent = cat.products.length + " products · prices in " + cat.currency + (bot ? " · @" + bot : "");
        chips(); render();
      })
      .catch(function(){ $("grid").innerHTML = '<div class="empty" style="grid-column:1/-1">Could not load the shop. Pull to retry.</div>'; });
  }
  if (tg && tg.initData) {
    fetch(base + "/me", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ initData: tg.initData }) })
      .then(function(r){ return r.json(); })
      .then(function(j){
        var d = j.data || j;
        if (d && d.known) { currency = d.currency || "USD"; $("me").innerHTML = "Hi, <b>" + esc(d.firstName || (d.user && d.user.firstName) || "there") + "</b><br>💰 " + money(d.balanceMinor, currency) + " · 📦 " + d.orders; }
        else $("me").innerHTML = "Tap /start in the bot<br>to create your wallet";
      })
      .catch(function(){})
      .then(load);
  } else load();
})();
</script>
</body>
</html>`;
}

@Module({ controllers: [MiniAppController] })
export class MiniAppModule {}
