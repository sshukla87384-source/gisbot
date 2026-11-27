/**
 * The website storefront: one self-contained HTML document (CSS + JS inline,
 * no build step) served by WebShopController at /shop. It talks only to
 * /api/v1/shop/* on the same origin, plus the Telegram Login Widget.
 *
 * Inside the template literal below there must be no back-ticks and no "${"
 * except the deliberate store-name interpolations.
 */
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const jsString = (s: string): string => JSON.stringify(s).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

export function webShopClosedPage(store: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(store)}</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0d17;color:#e9ebf5;display:grid;place-items:center;height:100vh;margin:0;text-align:center}</style></head>
<body><div><div style="font-size:52px">🛍</div><h2>${esc(store)}</h2><p>The web shop is taking a short break.<br>Please shop in our Telegram bot meanwhile.</p></div></body></html>`;
}

export function webShopPage(store: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0d17">
<title>${esc(store)} — Digital store</title>
<meta name="description" content="${esc(store)}: instant digital products — accounts, keys and subscriptions, delivered in seconds.">
<meta property="og:title" content="${esc(store)}">
<meta property="og:description" content="Instant digital products, delivered in seconds.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#0b0d17;--bg2:#12152a;--card:#161a33;--card2:#1c2142;--line:rgba(255,255,255,.08);--tx:#eef0fb;--mut:#9aa0c3;--acc:#7c5cff;--acc2:#22d3ee;--ok:#22c55e;--bad:#ef4444;--warn:#f59e0b;--r:18px}
*{box-sizing:border-box}html,body{margin:0;padding:0}
body{font-family:"Plus Jakarta Sans",system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:radial-gradient(1200px 600px at 10% -10%,rgba(124,92,255,.25),transparent),radial-gradient(900px 500px at 100% 0,rgba(34,211,238,.15),transparent),var(--bg);color:var(--tx);min-height:100vh;padding-bottom:calc(76px + env(safe-area-inset-bottom))}
a{color:var(--acc2);text-decoration:none}
button{font-family:inherit}
.wrap{max-width:1160px;margin:0 auto;padding:0 16px}
header.top{position:sticky;top:0;z-index:20;backdrop-filter:blur(14px);background:rgba(11,13,23,.72);border-bottom:1px solid var(--line)}
.bar{display:flex;align-items:center;gap:12px;height:64px}
.logo{font-weight:800;font-size:19px;letter-spacing:-.3px;display:flex;align-items:center;gap:8px;cursor:pointer;white-space:nowrap}
.logo i{font-style:normal;width:34px;height:34px;border-radius:11px;display:grid;place-items:center;background:linear-gradient(135deg,var(--acc),var(--acc2))}
.search{flex:1;display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:0 12px;height:42px;min-width:0}
.search input{flex:1;min-width:0;background:transparent;border:0;outline:0;color:var(--tx);font-size:15px;font-family:inherit}
.nav{display:flex;gap:6px}.nav a{color:var(--mut);font-weight:600;font-size:14px;padding:8px 10px;border-radius:10px;cursor:pointer}.nav a.on,.nav a:hover{color:var(--tx);background:var(--card)}
.sel{background:var(--card);border:1px solid var(--line);color:var(--tx);border-radius:12px;height:42px;padding:0 10px;font-family:inherit;font-weight:600}
.btn{border:0;border-radius:14px;padding:12px 18px;font-weight:700;font-size:15px;cursor:pointer;color:#fff;background:linear-gradient(135deg,var(--acc),#5b8cff);box-shadow:0 8px 24px rgba(124,92,255,.35);transition:transform .08s,opacity .2s}
.btn:active{transform:scale(.97)}.btn[disabled]{opacity:.5;cursor:not-allowed}
.btn.ok{background:linear-gradient(135deg,#16a34a,var(--ok));box-shadow:0 8px 24px rgba(34,197,94,.3)}
.btn.ghost{background:var(--card);box-shadow:none;border:1px solid var(--line)}
.btn.sm{padding:8px 12px;font-size:13px;border-radius:11px}
.btn.block{display:block;width:100%}
.me{display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--line);border-radius:14px;height:42px;padding:0 12px;font-weight:700;font-size:14px;cursor:pointer;white-space:nowrap}
.hero{margin:22px 0 8px;padding:28px;border-radius:26px;background:linear-gradient(135deg,rgba(124,92,255,.35),rgba(34,211,238,.18));border:1px solid var(--line);display:grid;grid-template-columns:1.3fr 1fr;gap:20px;align-items:center}
.hero h1{margin:0 0 8px;font-size:34px;line-height:1.15;letter-spacing:-.6px}.hero p{margin:0 0 16px;color:#d6d9f2}
.trust{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
.trust div{background:rgba(11,13,23,.45);border:1px solid var(--line);border-radius:14px;padding:12px;font-size:13px;font-weight:600}
.chips{display:flex;gap:8px;overflow-x:auto;padding:14px 0 6px;scrollbar-width:none}.chips::-webkit-scrollbar{display:none}
.chip{flex:0 0 auto;padding:9px 14px;border-radius:999px;background:var(--card);border:1px solid var(--line);font-size:13.5px;font-weight:600;cursor:pointer;white-space:nowrap;color:var(--mut)}
.chip.on{background:linear-gradient(135deg,var(--acc),#5b8cff);color:#fff;border-color:transparent}
.sec-t{display:flex;justify-content:space-between;align-items:center;margin:18px 0 10px}.sec-t h2{margin:0;font-size:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);overflow:hidden;cursor:pointer;display:flex;flex-direction:column;position:relative;transition:transform .12s,border-color .12s}
.card:hover{transform:translateY(-3px);border-color:rgba(124,92,255,.5)}
.thumb{aspect-ratio:16/11;background:linear-gradient(135deg,rgba(124,92,255,.3),rgba(34,211,238,.2));display:grid;place-items:center;font-size:46px;overflow:hidden}
.thumb img{width:100%;height:100%;object-fit:cover}
.cb{padding:12px 14px 14px;display:flex;flex-direction:column;gap:6px;flex:1}
.cn{font-weight:700;font-size:15px;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.cp{display:flex;align-items:baseline;gap:8px;margin-top:auto}.cp b{font-size:18px}.was{color:var(--mut);text-decoration:line-through;font-size:13px}
.cm{display:flex;justify-content:space-between;font-size:12px;color:var(--mut)}
.tag{position:absolute;top:10px;left:10px;font-size:11px;font-weight:800;padding:4px 9px;border-radius:999px;background:var(--bad);color:#fff}
.tag.out{background:#4b5068}.card.out .thumb{filter:grayscale(1);opacity:.55}
.empty{text-align:center;color:var(--mut);padding:50px 10px}
.sk{background:var(--card);border-radius:var(--r);height:250px;animation:pl 1.2s infinite}@keyframes pl{50%{opacity:.5}}
.page{display:none}.page.on{display:block}
.panel{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:18px;margin:16px 0}
.panel h3{margin:0 0 12px;font-size:17px}
.row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid var(--line);font-size:14px}.row:last-child{border-bottom:0}
.sub{font-size:12px;color:var(--mut)}
.big{font-size:34px;font-weight:800;letter-spacing:-.6px}
.pill{font-size:11.5px;font-weight:700;padding:4px 10px;border-radius:999px;background:var(--card2)}
.pill.g{background:rgba(34,197,94,.15);color:#86efac}.pill.y{background:rgba(245,158,11,.15);color:#fcd34d}.pill.r{background:rgba(239,68,68,.15);color:#fca5a5}
.modal-bg{position:fixed;inset:0;background:rgba(3,4,10,.7);backdrop-filter:blur(4px);z-index:40;display:none}
.modal{position:fixed;z-index:41;left:50%;top:50%;transform:translate(-50%,-48%);opacity:0;pointer-events:none;width:min(680px,calc(100vw - 24px));max-height:calc(100vh - 40px);overflow:auto;background:var(--bg2);border:1px solid var(--line);border-radius:24px;transition:.18s}
.modal.open{opacity:1;transform:translate(-50%,-50%);pointer-events:auto}.modal-bg.open{display:block}
.mh{display:flex;justify-content:space-between;align-items:center;padding:16px 18px 0}.x{background:var(--card);border:0;color:var(--tx);width:36px;height:36px;border-radius:12px;font-size:18px;cursor:pointer}
.mb{padding:14px 18px 20px}
.gal{display:flex;gap:8px;margin:10px 0 2px;overflow-x:auto}.gal img{width:64px;height:52px;object-fit:cover;border-radius:10px;border:2px solid transparent;cursor:pointer;opacity:.7;flex:none}.gal img.on{border-color:var(--acc,#7c5cff);opacity:1}
.pimg{height:200px;border-radius:18px;background:linear-gradient(135deg,rgba(124,92,255,.35),rgba(34,211,238,.2));display:grid;place-items:center;font-size:72px;overflow:hidden}.pimg img{width:100%;height:100%;object-fit:cover}
.pname{font-size:23px;font-weight:800;margin:14px 0 6px;letter-spacing:-.3px}
.price{font-size:26px;font-weight:800}.price .was{font-size:16px;margin-left:8px}
.facts{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
.qcard{background:var(--card);border-left:3px solid var(--acc);border-radius:14px;padding:12px 14px;margin:10px 0;font-size:14px;line-height:1.55;white-space:pre-wrap}
.qcard h4{margin:0 0 6px;font-size:14px;color:#c8bcff}
.qcard.how{border-left-color:var(--acc2)}.qcard.how h4{color:#a5f3fc}.qcard.terms{border-left-color:var(--warn)}.qcard.terms h4{color:#fcd34d}
.bulk{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}.bulk span{background:rgba(34,197,94,.12);color:#86efac;border-radius:10px;padding:6px 10px;font-size:12.5px;font-weight:700}
.vars{display:flex;flex-direction:column;gap:8px;margin:12px 0}
.var{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-radius:14px;background:var(--card);border:2px solid transparent;cursor:pointer;font-size:14px}
.var.sel{border-color:var(--acc)}.var.out{opacity:.45;cursor:not-allowed}
.qty{display:flex;align-items:center;gap:10px;background:var(--card);border-radius:14px;padding:8px 12px;margin:12px 0}
.qty button{width:38px;height:38px;border-radius:12px;border:0;background:var(--card2);color:var(--tx);font-size:20px;font-weight:800;cursor:pointer}
.qty input{width:90px;text-align:center;background:transparent;border:0;color:var(--tx);font-size:18px;font-weight:800;outline:0;font-family:inherit}
.total{display:flex;justify-content:space-between;align-items:center;margin:8px 0 12px;font-size:15px}.total b{font-size:22px}
.kv{background:var(--card);border-radius:14px;padding:10px 12px;margin:8px 0}
.kv .l{font-size:11.5px;color:var(--mut);margin-bottom:4px}
.kv .v{display:flex;gap:8px;align-items:center;justify-content:space-between}.kv code{font-family:ui-monospace,Menlo,monospace;font-size:13.5px;word-break:break-all;color:#e8e6ff}
.copy{flex:0 0 auto;background:var(--card2);border:0;color:var(--tx);border-radius:10px;padding:7px 10px;font-size:12px;font-weight:700;cursor:pointer}
.field{display:block;width:100%;background:var(--card);border:1px solid var(--line);border-radius:14px;color:var(--tx);padding:12px 14px;font-size:16px;font-family:inherit;outline:0;margin:6px 0 12px}
.nets{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin:6px 0 12px}
.net{background:var(--card);border:2px solid transparent;border-radius:14px;padding:10px;cursor:pointer;font-size:13px;font-weight:700}.net.sel{border-color:var(--acc2)}
.toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);background:#22263f;border:1px solid var(--line);color:var(--tx);padding:12px 16px;border-radius:14px;font-size:14px;z-index:60;display:none;max-width:90vw;box-shadow:0 10px 30px rgba(0,0,0,.4)}
.tabs{position:fixed;left:0;right:0;bottom:0;z-index:30;display:none;background:rgba(18,21,42,.96);backdrop-filter:blur(12px);border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom)}
.tab{flex:1;text-align:center;padding:9px 0 7px;font-size:11px;color:var(--mut);cursor:pointer;font-weight:600}.tab span{display:block;font-size:21px;line-height:1.25}.tab.on{color:#fff}
footer{color:var(--mut);font-size:13px;text-align:center;padding:30px 0 10px}
.loginbox{text-align:center;padding:10px 0}
@media (max-width:820px){.nav{display:none}.hero{grid-template-columns:1fr;padding:22px}.hero h1{font-size:26px}.tabs{display:flex}.grid{grid-template-columns:repeat(2,1fr);gap:10px}.cn{font-size:13.5px}.cp b{font-size:16px}.bar{gap:8px}.logo span{display:none}}
</style>
</head>
<body>
<header class="top"><div class="wrap bar">
  <div class="logo" id="logo"><i>🛍</i><span>${esc(store)}</span></div>
  <div class="search">🔎<input id="q" placeholder="Search products…" autocomplete="off"></div>
  <nav class="nav"><a data-go="shop" class="on">Shop</a><a data-go="orders">Orders</a><a data-go="wallet">Wallet</a><a data-go="account">Account</a></nav>
  <select class="sel" id="cur" title="Currency"><option>USD</option><option>INR</option></select>
  <div class="me" id="me">🔐 Log in</div>
</div></header>

<main class="wrap">
  <section class="page on" id="p-shop">
    <div class="hero" id="hero">
      <div><h1>Premium digital products, delivered instantly ⚡</h1><p>Accounts, keys and subscriptions — paid from your wallet, delivered in seconds, with replacement warranty.</p>
        <button class="btn" id="heroShop">🛍 Shop now</button> <a class="btn ghost" id="heroTg" target="_blank" rel="noopener">✈️ Open in Telegram</a></div>
      <div class="trust"><div>⚡ Instant delivery</div><div>🛡 Replacement warranty</div><div>🔒 Secure payments</div><div>💬 24/7 support</div></div>
    </div>
    <div class="chips" id="chips"></div>
    <div class="sec-t"><h2 id="listTitle">All products</h2><span class="sub" id="count"></span></div>
    <div class="grid" id="grid"></div>
  </section>
  <section class="page" id="p-orders"></section>
  <section class="page" id="p-wallet"></section>
  <section class="page" id="p-account"></section>
  <footer>© ${esc(store)} · <a id="ftTg" target="_blank" rel="noopener">Telegram bot</a> · Digital goods are delivered instantly after payment.</footer>
</main>

<nav class="tabs" id="tabs">
  <div class="tab on" data-go="shop"><span>🛍</span>Shop</div>
  <div class="tab" data-go="wallet"><span>💰</span>Wallet</div>
  <div class="tab" data-go="orders"><span>📦</span>Orders</div>
  <div class="tab" data-go="account"><span>👤</span>Account</div>
  <div class="tab" data-go="support"><span>💬</span>Support</div>
  <div class="tab" data-go="home"><span>🏠</span>Home</div>
</nav>

<div class="modal-bg" id="mbg"></div>
<div class="modal" id="modal"><div class="mh"><b id="mt"></b><button class="x" id="mx">✕</button></div><div class="mb" id="mbody"></div></div>
<div class="toast" id="toast"></div>

<script>
(function(){
  "use strict";
  var STORE = ${jsString(store)};
  var API = "/api/v1/shop/";
  var $ = function(id){ return document.getElementById(id); };
  var esc = function(s){ return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); };
  var cfg = { bot: null, networks: [] }, me = null, cat = null, catFilter = "all", query = "";
  var currency = "USD";
  try { currency = localStorage.getItem("cur") || "USD"; } catch (e) {}
  try { var rp = new URLSearchParams(location.search).get("ref"); if (rp) localStorage.setItem("ref", rp); } catch (e) {}

  function money(minor, c){ if (minor == null) return "—"; var v = (minor/100); var s = v.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}); return (c === "INR" ? "₹" : "$") + s; }
  function toast(t){ var el = $("toast"); el.textContent = t; el.style.display = "block"; clearTimeout(toast._t); toast._t = setTimeout(function(){ el.style.display = "none"; }, 3200); }
  function api(path, body, method){
    var opt = { method: method || (body ? "POST" : "GET"), credentials: "same-origin", headers: { "Accept": "application/json" } };
    if (body || opt.method === "POST") { opt.headers["Content-Type"] = "application/json"; opt.headers["X-Shop"] = "1"; opt.body = JSON.stringify(body || {}); }
    return fetch(API + path, opt).then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){
      if (!r.ok || j.success === false) { var er = new Error((j.error && j.error.message) || ("Error " + r.status)); er.code = j.error && j.error.code; er.status = r.status; throw er; }
      return j.data !== undefined ? j.data : j;
    }); });
  }
  function copyBtn(v){ return '<button class="copy" data-copy="' + esc(v) + '">Copy</button>'; }
  document.addEventListener("click", function(e){
    var b = e.target.closest && e.target.closest("[data-copy]");
    if (b) { var v = b.getAttribute("data-copy"); (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(function(){ toast("Copied ✓"); }).catch(function(){ toast(v); }); }
    var g = e.target.closest && e.target.closest("[data-go]");
    if (g) go(g.getAttribute("data-go"));
  });

  // ── modal ──
  function openModal(title, html){ $("mt").textContent = title; $("mbody").innerHTML = html; $("modal").classList.add("open"); $("mbg").classList.add("open"); }
  function closeModal(){ $("modal").classList.remove("open"); $("mbg").classList.remove("open"); clearInterval(closeModal._poll); }
  $("mx").onclick = closeModal; $("mbg").onclick = closeModal;
  document.addEventListener("keydown", function(e){ if (e.key === "Escape") closeModal(); });

  // ── navigation ──
  function go(name){
    if (name === "home") { name = "shop"; window.scrollTo({ top: 0, behavior: "smooth" }); }
    if (name === "support") { if (cfg.bot) window.open("https://t.me/" + cfg.bot + "?start=support", "_blank"); else toast("Support is in our Telegram bot"); return; }
    Array.prototype.forEach.call(document.querySelectorAll(".page"), function(p){ p.classList.toggle("on", p.id === "p-" + name); });
    Array.prototype.forEach.call(document.querySelectorAll("[data-go]"), function(t){ t.classList.toggle("on", t.getAttribute("data-go") === name); });
    if (name === "orders") loadOrders(1); if (name === "wallet") loadWallet(); if (name === "account") loadAccount();
    if (name !== "shop") window.scrollTo(0, 0);
  }
  $("logo").onclick = function(){ go("shop"); };
  $("heroShop").onclick = function(){ $("chips").scrollIntoView({ behavior: "smooth" }); };

  // ── login ──
  function needLogin(after){
    loginAfter = after || null;
    if (!cfg.bot) { openModal("Log in", '<div class="loginbox">Login is not configured yet.</div>'); return; }
    openModal("Log in with Telegram", '<div class="loginbox"><p>Use the same Telegram account as in our bot — your wallet and orders are shared.</p><div id="tgw"></div><p class="sub" style="margin-top:14px">New here? Logging in creates your account.</p></div>');
    var s = document.createElement("script");
    s.async = true; s.src = "https://telegram.org/js/telegram-widget.js?22";
    s.setAttribute("data-telegram-login", cfg.bot); s.setAttribute("data-size", "large"); s.setAttribute("data-radius", "12");
    s.setAttribute("data-request-access", "write"); s.setAttribute("data-onauth", "__tgAuth(user)");
    $("tgw").appendChild(s);
  }
  var loginAfter = null;
  window.__tgAuth = function(user){
    var ref = null; try { ref = localStorage.getItem("ref"); } catch (e) {}
    var body = {}; for (var k in user) body[k] = user[k]; if (ref) body.ref = ref;
    api("auth/telegram", body).then(function(){ closeModal(); toast("Welcome! 👋"); return loadMe(); }).then(function(){ if (loginAfter) { var f = loginAfter; loginAfter = null; f(); } }).catch(function(e){ toast(e.message); });
  };

  function loadMe(){
    return api("me").then(function(d){ me = d; currency = d.currency || currency; $("cur").value = currency; header(); }).catch(function(){ me = null; header(); });
  }
  function header(){
    $("me").innerHTML = me ? ("💰 " + money(me.balanceMinor, me.walletCurrency) + " · " + esc(me.firstName || "Me")) : "🔐 Log in";
  }
  $("me").onclick = function(){ if (me) go("account"); else needLogin(); };
  $("cur").onchange = function(){
    currency = $("cur").value; try { localStorage.setItem("cur", currency); } catch (e) {}
    var done = function(){ loadCatalog(); if (me) loadMe(); };
    if (me) api("currency", { currency: currency }).then(done).catch(function(e){ toast(e.message); }); else done();
  };

  // ── catalogue ──
  function loadCatalog(){
    $("grid").innerHTML = '<div class="sk"></div><div class="sk"></div><div class="sk"></div><div class="sk"></div>';
    api("catalog?currency=" + currency).then(function(c){ cat = c; renderChips(); renderGrid(); openFromUrl(); }).catch(function(e){ $("grid").innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  function renderChips(){
    var h = '<div class="chip' + (catFilter === "all" ? " on" : "") + '" data-c="all">✨ All</div>';
    cat.categories.forEach(function(c){ h += '<div class="chip' + (catFilter === c.id ? " on" : "") + '" data-c="' + esc(c.id) + '">' + esc((c.emoji || "📂") + " " + c.name) + ' (' + c.count + ')</div>'; });
    $("chips").innerHTML = h;
    Array.prototype.forEach.call($("chips").children, function(el){ el.onclick = function(){ catFilter = el.getAttribute("data-c"); renderChips(); renderGrid(); }; });
  }
  function renderGrid(){
    var q = query.trim().toLowerCase();
    var list = cat.products.filter(function(p){ return (catFilter === "all" || p.categoryId === catFilter) && (!q || p.name.toLowerCase().indexOf(q) >= 0 || (p.description || "").toLowerCase().indexOf(q) >= 0); });
    var c = catFilter === "all" ? null : cat.categories.filter(function(x){ return x.id === catFilter; })[0];
    $("listTitle").textContent = q ? ("Results for “" + query + "”") : (c ? c.name : "All products");
    $("count").textContent = list.length + " product" + (list.length === 1 ? "" : "s");
    if (!list.length) { $("grid").innerHTML = '<div class="empty">Nothing found. Try another word.</div>'; return; }
    $("grid").innerHTML = list.map(function(p){
      var stock = !p.inStock ? "❌ Sold out" : (p.stock == null ? "∞ in stock" : p.stock + " left");
      return '<div class="card' + (p.inStock ? "" : " out") + '" data-p="' + esc(p.id) + '">'
        + (p.onSale ? '<span class="tag">🔥 SALE</span>' : (!p.inStock ? '<span class="tag out">Sold out</span>' : ""))
        + '<div class="thumb">' + (p.imageUrl ? '<img loading="lazy" src="' + esc(p.imageUrl) + '" alt="">' : esc(p.iconEmoji || "🛍")) + '</div>'
        + '<div class="cb"><div class="cn">' + esc(p.name) + '</div>'
        + '<div class="cp"><b>' + money(p.fromPriceMinor, cat.currency) + '</b>' + (p.wasPriceMinor ? '<span class="was">' + money(p.wasPriceMinor, cat.currency) + '</span>' : "") + '</div>'
        + '<div class="cm"><span>' + stock + '</span><span>' + (p.rating ? "⭐ " + p.rating : "") + '</span></div></div></div>';
    }).join("");
    Array.prototype.forEach.call(document.querySelectorAll("[data-p]"), function(el){ el.onclick = function(){ openProduct(el.getAttribute("data-p")); }; });
  }
  var qT; $("q").oninput = function(){ clearTimeout(qT); qT = setTimeout(function(){ query = $("q").value; go("shop"); if (cat) renderGrid(); }, 160); };
  function openFromUrl(){ var p = new URLSearchParams(location.search).get("p"); if (p) { openProduct(p); history.replaceState(null, "", location.pathname); } }

  // ── product ──
  var cur = null;
  function openProduct(id){
    openModal("", '<div class="sk" style="height:320px"></div>');
    api("product/" + encodeURIComponent(id) + "?currency=" + currency).then(function(p){ cur = { p: p, v: null, qty: 1 }; var first = p.variants.filter(function(v){ return v.inStock && v.priceMinor != null; })[0]; cur.v = first || p.variants[0] || null; renderProduct(); }).catch(function(e){ $("mbody").innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  function unitPrice(){
    var p = cur.p, v = cur.v; if (!v || v.priceMinor == null) return null;
    var price = v.priceMinor;
    if (p.variants[0] && v.id === p.variants[0].id && p.bulk && p.bulk.length) p.bulk.forEach(function(t){ if (cur.qty >= t.minQty && t.unitPriceMinor < price) price = t.unitPriceMinor; });
    return price;
  }
  function renderProduct(){
    var p = cur.p, v = cur.v;
    var maxQ = v && v.stock != null ? v.stock : 100000;
    var price = unitPrice(), total = price == null ? null : price * cur.qty;
    var warranty = p.warranty ? (p.warranty.hours ? (p.warranty.hours % 24 === 0 ? (p.warranty.hours / 24) + "-day" : p.warranty.hours + "-hour") + " replacement warranty" : "Replacement warranty") : "No replacement warranty";
    var imgs = p.images && p.images.length ? p.images : (p.imageUrl ? [p.imageUrl] : []);
    var gi = Math.min(cur.img || 0, Math.max(0, imgs.length - 1));
    var h = '<div class="pimg">' + (imgs.length ? '<img id="pmain" src="' + esc(imgs[gi]) + '" alt="">' : esc(p.iconEmoji || "🛍")) + '</div>'
      + (imgs.length > 1 ? '<div class="gal">' + imgs.map(function(u, i){ return '<img data-gi="' + i + '" class="' + (i === gi ? "on" : "") + '" loading="lazy" src="' + esc(u) + '" alt="">'; }).join("") + '</div>' : "")
      + '<div class="pname">' + esc((p.iconEmoji ? p.iconEmoji + " " : "") + p.name) + '</div>'
      + '<div class="price">' + money(v && v.priceMinor, p.currency) + (p.unit ? '<span class="sub"> / ' + p.unit + '</span>' : "") + (v && v.wasMinor ? '<span class="was">' + money(v.wasMinor, p.currency) + '</span>' : "") + '</div>'
      + (p.bulk && p.bulk.length ? '<div class="bulk">' + p.bulk.map(function(t){ return "<span>📦 " + t.minQty + "+ → " + money(t.unitPriceMinor, p.currency) + "</span>"; }).join("") + '</div>' : "")
      + '<div class="facts"><span class="pill ' + (p.automatic ? "g" : "y") + '">' + (p.automatic ? "⚡ Instant delivery" : "🕐 Delivered by our team (~12 h)") + '</span><span class="pill">🛡 ' + warranty + '</span>'
      + (p.rating ? '<span class="pill">⭐ ' + p.rating.avg + ' · ' + p.rating.count + ' reviews</span>' : "") + (p.personalPrice ? '<span class="pill g">💎 Your special price</span>' : "") + (p.onSale ? '<span class="pill r">🔥 Flash sale</span>' : "") + '</div>'
      + (p.description ? '<div class="qcard"><h4>✅ Description</h4>' + p.description + '</div>' : "")
      + (p.howToUse ? '<div class="qcard how"><h4>📋 How to use</h4>' + p.howToUse + '</div>' : "")
      + (p.terms ? '<div class="qcard terms"><h4>📜 Terms &amp; Conditions</h4>' + p.terms + '</div>' : "");
    if (p.variants.length > 1) h += '<div class="vars">' + p.variants.map(function(x){ return '<div class="var' + (v && x.id === v.id ? " sel" : "") + (x.inStock ? "" : " out") + '" data-v="' + esc(x.id) + '"><span>' + esc(x.name || "Standard") + ' <span class="sub">' + (x.inStock ? (x.stock == null ? "∞" : x.stock + " left") : "sold out") + '</span></span><b>' + money(x.priceMinor, p.currency) + '</b></div>'; }).join("") + '</div>';
    if (v && v.inStock && v.priceMinor != null) {
      h += '<div class="qty"><button id="qm">−</button><input id="qi" inputmode="numeric" value="' + cur.qty + '"><button id="qp">+</button><span class="sub">' + (v.stock == null ? "Any quantity" : v.stock + " available") + '</span></div>'
        + '<div class="total"><span>Total</span><b>' + money(total, p.currency) + '</b></div>'
        + '<button class="btn ok block" id="buy">⚡ Buy now — ' + money(total, p.currency) + '</button>'
        + '<div class="sub" style="margin-top:10px;text-align:center">Paid from your wallet · not enough? Top up with crypto in one step.' + (cfg.bot && p.slug ? ' Prefer UPI / Binance? <a target="_blank" rel="noopener" href="https://t.me/' + esc(cfg.bot) + '?start=p_' + esc(p.slug) + '">Buy in Telegram</a>' : "") + '</div>';
    } else {
      h += '<button class="btn ghost block" disabled>❌ Sold out</button>' + (cfg.bot && p.slug ? '<div class="sub" style="margin-top:10px;text-align:center"><a target="_blank" rel="noopener" href="https://t.me/' + esc(cfg.bot) + '?start=p_' + esc(p.slug) + '">🔔 Get notified in Telegram</a></div>' : "");
    }
    $("mt").textContent = ""; $("mbody").innerHTML = h;
    Array.prototype.forEach.call(document.querySelectorAll("[data-gi]"), function(el){ el.onclick = function(){ cur.img = Number(el.getAttribute("data-gi")) || 0; $("pmain").src = imgs[cur.img]; Array.prototype.forEach.call(document.querySelectorAll("[data-gi]"), function(x){ x.className = x === el ? "on" : ""; }); }; });
    Array.prototype.forEach.call(document.querySelectorAll("[data-v]"), function(el){ el.onclick = function(){ var x = p.variants.filter(function(y){ return y.id === el.getAttribute("data-v"); })[0]; if (x && x.inStock) { cur.v = x; cur.qty = 1; renderProduct(); } }; });
    var setQ = function(n){ n = Math.max(1, Math.min(maxQ, Math.floor(Number(n) || 1))); cur.qty = n; renderProduct(); };
    if ($("qm")) { $("qm").onclick = function(){ setQ(cur.qty - 1); }; $("qp").onclick = function(){ setQ(cur.qty + 1); }; $("qi").onchange = function(){ setQ($("qi").value); }; }
    if ($("buy")) $("buy").onclick = function(){ if (!me) { needLogin(function(){ openProduct(p.id); }); return; } buy(total); };
  }
  function buy(total){
    var b = $("buy"); b.disabled = true; b.textContent = "⏳ Processing…";
    // One key per click: a retry of THIS request returns the same order, never a second one.
    var key = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
    api("buy", { variantId: cur.v.id, qty: cur.qty, quoteMinor: total, quoteCurrency: cur.p.currency, idem: key }).then(function(r){
      if (!r.ok) {
        if (r.reason === "insufficient") { b.disabled = false; renderProduct(); topupModal(me && cur.p.currency === me.walletCurrency && me.walletCurrency === me.currency ? Math.max(100, total - (me.balanceMinor || 0)) : null, "Your wallet balance is too low for this order. Top up and come back — it takes a minute."); return; }
        toast(r.message); b.disabled = false; renderProduct(); if (r.reason === "price_changed") openProduct(cur.p.id); return;
      }
      loadMe(); success(r);
    }).catch(function(e){
      // No answer is not "not bought": the order may still be going through.
      if (!e.status || e.status >= 500 || e.code === "IN_PROGRESS") { b.textContent = "⏳ Still processing — check 📦 Orders"; toast("Check 📦 Orders in a moment before trying again."); return; }
      toast(e.message); b.disabled = false; renderProduct();
    });
  }
  function valuesHtml(list){
    return list.map(function(d){ return '<div class="panel" style="margin:10px 0;padding:14px"><b>' + esc(d.productName) + (d.variantName && !/^standard$/i.test(d.variantName) ? " · " + esc(d.variantName) : "") + '</b>' + (d.replaced ? ' <span class="pill r">replaced</span>' : "")
      + d.values.map(function(x){ return '<div class="kv"><div class="l">' + esc(x.label) + '</div><div class="v"><code>' + esc(x.value) + '</code>' + copyBtn(x.value) + '</div></div>'; }).join("") + '</div>'; }).join("");
  }
  function txtOf(list){ return list.map(function(d, i){ return (i + 1) + ". " + d.productName + "\\n" + d.values.map(function(x){ return "   " + x.label + ": " + x.value; }).join("\\n"); }).join("\\n\\n"); }
  function success(r){
    var h = '<div style="text-align:center;font-size:56px">🎉</div><h2 style="text-align:center;margin:6px 0">Order successful</h2><p class="sub" style="text-align:center">Order <b>' + esc(r.orderNumber) + '</b> · ' + money(r.totalMinor, r.currency) + ' · also sent to your Telegram</p>';
    if (r.delivered && r.delivered.length) {
      if (r.delivered.length > 15) h += '<button class="btn ghost block" id="dl">⬇️ Download all (' + r.delivered.length + ') as .txt</button>';
      h += valuesHtml(r.delivered);
    }
    if (r.pendingManual) h += '<div class="qcard how"><h4>⏳ Being prepared</h4>' + r.pendingManual + ' item(s) are being prepared — they will appear in 📦 Orders and in Telegram.</div>';
    h += '<button class="btn block" data-go="orders" style="margin-top:10px">📦 My orders</button>';
    openModal("✅ Delivered", h);
    if ($("dl")) $("dl").onclick = function(){ var a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([txtOf(r.delivered)], { type: "text/plain" })); a.download = "order-" + r.orderNumber + ".txt"; a.click(); };
    var mo = $("mbody").querySelector("[data-go]"); if (mo) mo.addEventListener("click", closeModal);
  }

  // ── top up (crypto) ──
  function topupModal(needMinor, note){
    if (!me) { needLogin(function(){ topupModal(needMinor, note); }); return; }
    var wc = me.currency || currency; // top-ups are quoted in the customer's currency
    if (!cfg.networks.length) { openModal("➕ Add balance", '<p>' + (note ? esc(note) + "<br><br>" : "") + 'Crypto top-up is not available on the website right now.</p>' + (cfg.bot ? '<a class="btn block" target="_blank" rel="noopener" href="https://t.me/' + esc(cfg.bot) + '?start=topup">Top up in Telegram (UPI · Binance · crypto)</a>' : "")); return; }
    var amt = needMinor ? Math.ceil(needMinor) / 100 : "";
    var h = (note ? '<p>' + esc(note) + '</p>' : "") + '<label class="sub">Amount (' + wc + ')</label><input class="field" id="ta" inputmode="decimal" placeholder="e.g. 10" value="' + amt + '">'
      + '<label class="sub">Pay with</label><div class="nets">' + cfg.networks.map(function(n, i){ return '<div class="net' + (i === 0 ? " sel" : "") + '" data-n="' + esc(n.code) + '">' + esc((n.emoji || "🪙") + " " + n.label) + '</div>'; }).join("") + '</div>'
      + '<button class="btn block" id="tgo">Continue</button>'
      + (cfg.bot ? '<p class="sub" style="text-align:center;margin-top:12px">UPI or Binance? <a target="_blank" rel="noopener" href="https://t.me/' + esc(cfg.bot) + '?start=topup">Top up in Telegram</a> — the balance is the same.</p>' : "");
    openModal("➕ Add balance", h);
    var net = cfg.networks[0].code;
    Array.prototype.forEach.call(document.querySelectorAll("[data-n]"), function(el){ el.onclick = function(){ net = el.getAttribute("data-n"); Array.prototype.forEach.call(document.querySelectorAll("[data-n]"), function(x){ x.classList.toggle("sel", x === el); }); }; });
    $("tgo").onclick = function(){
      var a = Number(String($("ta").value).replace(",", ".")); if (!(a > 0)) { toast("Enter an amount"); return; }
      $("tgo").disabled = true; $("tgo").textContent = "⏳ Creating address…";
      api("topup/crypto", { amount: a, network: net }).then(payCard).catch(function(e){ toast(e.message); $("tgo").disabled = false; $("tgo").textContent = "Continue"; });
    };
  }
  function payCard(t){
    var h = '<p>Send <b>exactly</b> this amount on <b>' + esc(t.chain) + '</b>. It is credited automatically after ' + (t.confirmations || 1) + ' confirmation(s).</p>'
      + '<div class="kv"><div class="l">Amount</div><div class="v"><code>' + esc(t.amount) + ' ' + esc(t.asset) + '</code>' + copyBtn(t.amount) + '</div></div>'
      + '<div class="kv"><div class="l">Address (yours only)</div><div class="v"><code>' + esc(t.address) + '</code>' + copyBtn(t.address) + '</div></div>'
      + (t.memo ? '<div class="kv"><div class="l">Memo / Tag — REQUIRED</div><div class="v"><code>' + esc(t.memo) + '</code>' + copyBtn(t.memo) + '</div></div>' : "")
      + '<div class="qcard terms"><h4>⚠️ Important</h4>Send only ' + esc(t.asset) + ' on ' + esc(t.chain) + '. From an exchange, add the withdrawal fee so the full amount arrives.</div>'
      + '<div class="total"><span id="tst">⏳ Waiting for your payment…</span><span class="sub" id="tex"></span></div>'
      + '<button class="btn ghost block" id="tchk">🔄 Check payment</button>';
    openModal("🪙 Pay " + t.asset, h);
    var exp = new Date(t.expiresAt).getTime();
    var check = function(){ api("topup/" + encodeURIComponent(t.id)).then(function(s){
      var m = { waiting: "⏳ Waiting for your payment…", confirming: "🔄 Seen on-chain — confirming…", partially_paid: "⚠️ Received " + s.received + " of " + s.expected + " — send the rest to the same address", finished: "✅ Paid!", expired: "⌛ Window expired" };
      $("tst").textContent = s.credited ? "✅ Credited to your wallet!" : (m[s.status] || s.status);
      if (s.credited) { clearInterval(closeModal._poll); loadMe(); toast("✅ Balance added"); setTimeout(function(){ closeModal(); if (cur) openProduct(cur.p.id); else go("wallet"); }, 1600); }
    }).catch(function(){}); };
    $("tchk").onclick = check;
    clearInterval(closeModal._poll);
    closeModal._poll = setInterval(function(){ var left = Math.max(0, exp - Date.now()); var mm = Math.floor(left / 60000), ss = Math.floor(left % 60000 / 1000); if ($("tex")) $("tex").textContent = left ? mm + ":" + (ss < 10 ? "0" : "") + ss + " left" : ""; if (Math.floor(Date.now() / 1000) % 10 === 0) check(); }, 1000);
  }

  // ── orders ──
  var ST = { COMPLETED: ["✅ Delivered", "g"], PAID: ["💳 Paid", "y"], PENDING_FULFILLMENT: ["🕐 Being prepared", "y"], AWAITING_STOCK: ["📦 Waiting for stock", "y"], PENDING_PAYMENT: ["⌛ Awaiting payment", "y"], CANCELLED: ["🚫 Cancelled", "r"], EXPIRED: ["⌛ Expired", "r"], REFUNDED: ["↩️ Refunded", "r"], PARTIALLY_REFUNDED: ["↩️ Part refunded", "y"], MANUAL_REVIEW: ["🔍 In review", "y"] };
  function gate(el, title){ el.innerHTML = '<div class="panel" style="text-align:center"><div style="font-size:44px">🔐</div><h3>' + title + '</h3><p class="sub">Log in with the Telegram account you use in our bot.</p><button class="btn" id="gl">Log in with Telegram</button></div>'; $("gl").onclick = function(){ needLogin(); }; }
  function loadOrders(page){
    var el = $("p-orders"); if (!me) { gate(el, "Your orders"); return; }
    el.innerHTML = '<div class="sec-t"><h2>📦 My orders</h2></div><div class="sk" style="height:200px"></div>';
    api("orders?page=" + page).then(function(r){
      var h = '<div class="sec-t"><h2>📦 My orders</h2><span class="sub">Page ' + r.page + ' / ' + r.pages + '</span></div><div class="panel">';
      if (!r.items.length) h += '<div class="empty">No orders yet. <a data-go="shop">Start shopping →</a></div>';
      h += r.items.map(function(o){ var s = ST[o.status] || [o.status, ""]; return '<div class="row" style="cursor:pointer" data-o="' + esc(o.id) + '"><div><b>' + esc(o.orderNumber) + '</b><div class="sub">' + new Date(o.createdAt).toLocaleString() + '</div></div><div style="text-align:right"><b>' + money(o.totalMinor, o.currency) + '</b><div><span class="pill ' + s[1] + '">' + s[0] + '</span></div></div></div>'; }).join("") + '</div>';
      if (r.pages > 1) h += '<div style="display:flex;gap:8px;justify-content:center">' + (r.page > 1 ? '<button class="btn ghost sm" id="op">◀️ Prev</button>' : "") + (r.page < r.pages ? '<button class="btn ghost sm" id="on">Next ▶️</button>' : "") + '</div>';
      el.innerHTML = h;
      if ($("op")) $("op").onclick = function(){ loadOrders(r.page - 1); }; if ($("on")) $("on").onclick = function(){ loadOrders(r.page + 1); };
      Array.prototype.forEach.call(el.querySelectorAll("[data-o]"), function(x){ x.onclick = function(){ openOrder(x.getAttribute("data-o")); }; });
    }).catch(function(e){ el.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  function openOrder(id){
    openModal("Order", '<div class="sk" style="height:220px"></div>');
    api("orders/" + encodeURIComponent(id)).then(function(o){
      var s = ST[o.status] || [o.status, ""];
      var h = '<div class="row"><b>' + esc(o.orderNumber) + '</b><span class="pill ' + s[1] + '">' + s[0] + '</span></div><div class="row"><span>Total</span><b>' + money(o.totalMinor, o.currency) + '</b></div><div class="row"><span>Placed</span><span>' + new Date(o.createdAt).toLocaleString() + '</span></div>';
      h += '<h3 style="margin:14px 0 4px">Items</h3>' + o.items.map(function(i){ return '<div class="row"><span>' + esc(i.productName) + ' ×' + i.quantity + '</span><span class="sub">' + (i.fulfilledAt ? "✅ delivered" : "⏳ pending") + (i.expiresAt ? " · until " + i.expiresAt.slice(0, 10) : "") + '</span></div>'; }).join("");
      if (o.delivered && o.delivered.length) { h += '<h3 style="margin:16px 0 4px">🔑 Your delivery</h3>'; if (o.delivered.length > 15) h += '<button class="btn ghost block" id="dl2">⬇️ Download all as .txt</button>'; h += valuesHtml(o.delivered); }
      if (cfg.bot) h += '<a class="btn ghost block" style="margin-top:12px;text-align:center" target="_blank" rel="noopener" href="https://t.me/' + esc(cfg.bot) + '?start=replace">🔄 Need a replacement? Open in Telegram</a>';
      openModal("Order details", h);
      if ($("dl2")) $("dl2").onclick = function(){ var a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([txtOf(o.delivered)], { type: "text/plain" })); a.download = "order-" + o.orderNumber + ".txt"; a.click(); };
    }).catch(function(e){ $("mbody").innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }

  // ── wallet ──
  function loadWallet(){
    var el = $("p-wallet"); if (!me) { gate(el, "Your wallet"); return; }
    api("wallet").then(function(w){
      var h = '<div class="panel" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px"><div><div class="sub">Wallet balance</div><div class="big">' + money(w.balanceMinor, w.currency) + '</div><div class="sub">Shared with the Telegram bot</div></div><button class="btn" id="wt">➕ Add balance</button></div>';
      h += '<div class="panel"><h3>History</h3>' + (w.entries.length ? w.entries.map(function(e){ var pos = e.amountMinor >= 0; return '<div class="row"><div><b>' + esc(e.note || e.type) + '</b><div class="sub">' + new Date(e.createdAt).toLocaleString() + '</div></div><b style="color:' + (pos ? "#86efac" : "#fca5a5") + '">' + (pos ? "+" : "−") + money(Math.abs(e.amountMinor), e.currency) + '</b></div>'; }).join("") : '<div class="empty">No transactions yet.</div>') + '</div>';
      el.innerHTML = h; $("wt").onclick = function(){ topupModal(null); };
    }).catch(function(e){ el.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }

  // ── account ──
  function loadAccount(){
    var el = $("p-account"); if (!me) { gate(el, "Your account"); return; }
    Promise.all([api("me"), api("referral").catch(function(){ return null; })]).then(function(a){
      var u = a[0], r = a[1];
      var h = '<div class="panel"><h3>👤 ' + esc(u.firstName || "My account") + (u.handle ? ' <span class="sub">@' + esc(u.handle) + '</span>' : "") + '</h3>'
        + '<div class="row"><span>💰 Wallet</span><b>' + money(u.balanceMinor, u.walletCurrency) + '</b></div><div class="row"><span>📦 Orders</span><b>' + u.orders + '</b></div>'
        + (u.tier ? '<div class="row"><span>🏆 Tier</span><b>' + esc(u.tier.name) + '</b></div>' + (u.tier.next ? '<div class="sub">' + money(u.tier.next.toNextMinor, u.tier.next.currency) + ' more to reach ' + esc(u.tier.next.name) + '</div><div style="height:8px;background:var(--card2);border-radius:99px;margin:8px 0"><div style="height:8px;border-radius:99px;width:' + (u.tier.progressPct || 0) + '%;background:linear-gradient(90deg,var(--acc),var(--acc2))"></div></div>' : "") : "")
        + (u.isVip ? '<div class="row"><span>💎 VIP</span><b>Active</b></div>' : "") + '</div>';
      if (r && r.link) {
        h += '<div class="panel"><h3>🎁 Refer &amp; earn</h3><p class="sub">Earn ' + r.firstPct + '% on your friends\\u2019 first purchase' + (r.repeatPct ? ' and ' + r.repeatPct + '% on later ones' : "") + '.</p>'
          + '<div class="kv"><div class="l">Your link (Telegram)</div><div class="v"><code>' + esc(r.link) + '</code>' + copyBtn(r.link) + '</div></div>'
          + '<div class="kv"><div class="l">Your link (website)</div><div class="v"><code>' + esc(location.origin + location.pathname + "?ref=" + (r.link.split("ref_")[1] || "")) + '</code>' + copyBtn(location.origin + location.pathname + "?ref=" + (r.link.split("ref_")[1] || "")) + '</div></div>'
          + '<div class="row"><span>👥 Invited</span><b>' + r.invited + '</b></div><div class="row"><span>🛒 Bought</span><b>' + r.purchased + '</b></div><div class="row"><span>💵 Earned</span><b>' + money(r.earnedMinor, r.currency) + '</b></div>'
          + (r.held && r.held.readyMinor > 0 ? '<button class="btn ok block" id="rc">Claim ' + money(r.held.readyMinor, r.held.currency) + '</button>' : "") + '</div>';
      }
      h += '<div class="panel"><h3>⚙️ Settings</h3><div class="row"><span>Currency</span><b>' + esc(u.currency) + '</b></div><div class="row"><span>Telegram ID</span><code>' + esc(u.telegramId) + '</code></div>'
        + (cfg.bot ? '<a class="btn ghost block" style="text-align:center;margin:10px 0" target="_blank" rel="noopener" href="https://t.me/' + esc(cfg.bot) + '">✈️ Open the bot</a>' : "") + '<button class="btn ghost block" id="lo">🚪 Log out</button></div>';
      el.innerHTML = h;
      if ($("rc")) $("rc").onclick = function(){ api("referral/claim", {}).then(function(c){ toast(c.credited ? "✅ Added to your wallet" : "Nothing to claim yet"); loadMe(); loadAccount(); }).catch(function(e){ toast(e.message); }); };
      $("lo").onclick = function(){ api("auth/logout", {}).then(function(){ me = null; header(); go("shop"); toast("Logged out"); }); };
    }).catch(function(e){ el.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }

  // ── boot ──
  $("cur").value = currency;
  api("config").then(function(c){
    cfg = c;
    if (c.bot) { $("heroTg").href = "https://t.me/" + c.bot; $("ftTg").href = "https://t.me/" + c.bot; } else { $("heroTg").style.display = "none"; }
  }).catch(function(){}).then(loadMe).then(loadCatalog);
  if (location.hash && /^#(orders|wallet|account)$/.test(location.hash)) setTimeout(function(){ go(location.hash.slice(1)); }, 300);
  document.title = STORE + " — Digital store";
})();
</script>
</body>
</html>`;
}
