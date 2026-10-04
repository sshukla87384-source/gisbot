/**
 * The Mini App page: one self-contained HTML document (CSS + JS inline, no
 * build step) served by MiniAppController. It talks only to /miniapp/* on
 * the same origin and to the Telegram WebApp SDK.
 *
 * Tabs: 🛍 Shop · 📦 Orders · 💰 Wallet · 🎁 Refer · 👤 Me — the bot menu.
 * Wallet purchases complete in-page; every other rail opens the bot.
 *
 * Inside the template literal below there must be no back-ticks and no
 * "${" except the deliberate store-name interpolations.
 */
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function disabledPage(store: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(store)}</title>
<style>body{font-family:system-ui,sans-serif;background:var(--tg-theme-bg-color,#fff);color:var(--tg-theme-text-color,#111);display:grid;place-items:center;height:100vh;margin:0;text-align:center}</style></head>
<body><div><div style="font-size:48px">🛍</div><h2>${esc(store)}</h2><p>The web shop is taking a short break.<br>Please use the bot menu to browse.</p></div></body></html>`;
}

export function storefrontPage(store: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${esc(store)}</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{--bg:var(--tg-theme-bg-color,#f4f4f7);--sbg:var(--tg-theme-secondary-bg-color,#fff);--tx:var(--tg-theme-text-color,#111);--hint:var(--tg-theme-hint-color,#8a8a8e);--acc:var(--tg-theme-button-color,#2ea6ff);--acct:var(--tg-theme-button-text-color,#fff);--ok:#34c759;--bad:#ff3b30;--r:14px}
*{box-sizing:border-box}html,body{margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;background:var(--bg);color:var(--tx);padding-bottom:calc(72px + env(safe-area-inset-bottom))}
header{position:sticky;top:0;z-index:5;background:var(--bg);padding:12px 14px 8px}
.top{display:flex;align-items:center;justify-content:space-between;gap:10px}
.brand{font-weight:800;font-size:18px;letter-spacing:-.2px}
.me{font-size:12px;color:var(--hint);text-align:right;line-height:1.3}.me b{color:var(--tx)}
.search{margin-top:10px;display:flex;align-items:center;background:var(--sbg);border-radius:12px;padding:0 12px;height:40px}
.search input{flex:1;border:0;background:transparent;color:var(--tx);font-size:15px;outline:0;height:100%}
.chips{display:flex;gap:8px;overflow-x:auto;padding:10px 14px 4px;scrollbar-width:none}.chips::-webkit-scrollbar{display:none}
.chip{flex:0 0 auto;padding:7px 12px;border-radius:999px;background:var(--sbg);font-size:13px;white-space:nowrap;cursor:pointer}
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
.badge{position:absolute;top:8px;left:8px;background:var(--bad);color:#fff;font-size:11px;font-weight:700;padding:3px 7px;border-radius:999px}
.badge.out{background:#8e8e93}.card.out .img{filter:grayscale(1);opacity:.6}
.empty{text-align:center;color:var(--hint);padding:60px 20px}
.sk{background:var(--sbg);border-radius:var(--r);min-height:200px;animation:pulse 1.2s infinite}
@keyframes pulse{0%,100%{opacity:.5}50%{opacity:1}}
.sheet-bg{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10;display:none}
.sheet{position:fixed;left:0;right:0;bottom:0;background:var(--sbg);border-radius:20px 20px 0 0;z-index:11;transform:translateY(105%);transition:transform .22s ease;max-height:90vh;overflow:auto;padding:0 16px calc(16px + env(safe-area-inset-bottom))}
.sheet.open{transform:none}.sheet-bg.open{display:block}
.handle{width:40px;height:4px;border-radius:2px;background:var(--hint);margin:10px auto 12px;opacity:.5}
.hero{height:160px;border-radius:14px;overflow:hidden;background:linear-gradient(135deg,rgba(46,166,255,.18),rgba(255,120,200,.18));display:grid;place-items:center;font-size:64px}
.hero img{width:100%;height:100%;object-fit:cover}
h2{font-size:19px;margin:14px 0 4px;line-height:1.25}h3{font-size:15px;margin:16px 0 8px}
.desc{font-size:14px;color:var(--hint);white-space:pre-wrap;line-height:1.45;margin:6px 0 12px;max-height:150px;overflow:auto}
.vars{display:flex;flex-direction:column;gap:8px;margin:8px 0 14px}
.var{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-radius:12px;background:var(--bg);font-size:14px;cursor:pointer;border:2px solid transparent}
.var.sel{border-color:var(--acc)}.var.out{opacity:.5}.var b{font-size:15px}
.qty{display:flex;align-items:center;justify-content:space-between;background:var(--bg);border-radius:12px;padding:8px 12px;margin-bottom:12px;font-size:14px}
.qty button{width:34px;height:34px;border-radius:10px;border:0;background:var(--sbg);color:var(--tx);font-size:18px;font-weight:700}
.btn{display:block;width:100%;border:0;border-radius:12px;background:var(--acc);color:var(--acct);font-size:16px;font-weight:700;padding:14px;cursor:pointer;margin-top:8px}
.btn.sec{background:var(--bg);color:var(--tx)}.btn.ok{background:var(--ok);color:#fff}.btn[disabled]{opacity:.5}
.rating{font-size:12.5px;color:var(--hint);margin-top:2px}
.foot{text-align:center;font-size:11.5px;color:var(--hint);padding:18px 14px 0}
.tabs{position:fixed;left:0;right:0;bottom:0;z-index:6;display:flex;background:var(--sbg);border-top:1px solid rgba(128,128,128,.15);padding-bottom:env(safe-area-inset-bottom)}
.tab{flex:1;text-align:center;padding:8px 0 6px;font-size:11px;color:var(--hint);cursor:pointer}
.tab span{display:block;font-size:20px;line-height:1.2}.tab.on{color:var(--acc);font-weight:700}
.page{display:none;padding:12px 14px}.page.on{display:block}
.panel{background:var(--sbg);border-radius:var(--r);padding:14px;margin-bottom:12px}
.row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid rgba(128,128,128,.12);font-size:14px}
.row:last-child{border-bottom:0}.row .sub{font-size:12px;color:var(--hint)}
.big{font-size:28px;font-weight:800;letter-spacing:-.5px}
.pill{font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;background:var(--bg)}
.pill.ok{background:rgba(52,199,89,.18);color:var(--ok)}.pill.wait{background:rgba(255,159,10,.18);color:#ff9f0a}.pill.bad{background:rgba(255,59,48,.15);color:var(--bad)}
.kv{display:flex;align-items:center;justify-content:space-between;gap:8px;background:var(--bg);border-radius:10px;padding:9px 10px;margin:6px 0;font-size:13px}
.kv code{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;word-break:break-all;flex:1}
.copy{border:0;background:var(--acc);color:var(--acct);border-radius:8px;padding:6px 10px;font-size:12px;font-weight:700;flex:0 0 auto}
.bar{height:10px;border-radius:5px;background:var(--bg);overflow:hidden;margin:8px 0}.bar i{display:block;height:100%;background:var(--ok)}
.mut{color:var(--hint);font-size:12.5px;line-height:1.45}
.toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:#111;color:#fff;padding:10px 16px;border-radius:999px;font-size:13px;z-index:20;opacity:0;transition:opacity .2s;pointer-events:none;max-width:90vw;text-align:center}
.toast.on{opacity:.95}
.seg{display:flex;background:var(--bg);border-radius:10px;padding:3px}.seg div{flex:1;text-align:center;padding:7px;border-radius:8px;font-size:13px;cursor:pointer}.seg div.on{background:var(--sbg);font-weight:700}
.center{text-align:center}.gap{height:8px}
</style>
</head>
<body>
<header>
  <div class="top">
    <div class="brand">🛍 ${esc(store)}</div>
    <div class="me" id="me"></div>
  </div>
  <div class="search" id="searchbox">🔍&nbsp;<input id="q" type="search" placeholder="Search products…" autocomplete="off"></div>
</header>

<div class="page on" id="p-shop">
  <div class="chips" id="chips"></div>
  <div class="grid" id="grid"><div class="sk"></div><div class="sk"></div><div class="sk"></div><div class="sk"></div></div>
  <div class="foot" id="foot"></div>
</div>
<div class="page" id="p-orders"><div class="empty">Loading your orders…</div></div>
<div class="page" id="p-wallet"><div class="empty">Loading your wallet…</div></div>
<div class="page" id="p-refer"><div class="empty">Loading…</div></div>
<div class="page" id="p-me"><div class="empty">Loading…</div></div>

<div class="tabs" id="tabs">
  <div class="tab on" data-t="shop"><span>🛍</span>Shop</div>
  <div class="tab" data-t="orders"><span>📦</span>Orders</div>
  <div class="tab" data-t="wallet"><span>💰</span>Wallet</div>
  <div class="tab" data-t="refer"><span>🎁</span>Refer</div>
  <div class="tab" data-t="me"><span>👤</span>Me</div>
</div>
<div class="sheet-bg" id="sbg"></div>
<div class="sheet" id="sheet"></div>
<div class="toast" id="toast"></div>
<script>
(function(){
  var tg = window.Telegram && Telegram.WebApp; if (tg) { tg.ready(); tg.expand(); }
  var base = location.pathname.replace(/[/]+$/, "");
  var initData = (tg && tg.initData) || "";
  var cat = null, currency = "USD", bot = null, active = "all", q = "", meBal = null, known = false, loaded = {};
  var $ = function(id){ return document.getElementById(id); };
  function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }
  function money(minor, cur){ if (minor==null) return ""; var n = Math.abs(minor)/100; var s = cur==="INR" ? "₹" : "$"; var t = (Number.isInteger(n) ? n.toLocaleString("en-IN") : n.toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2})); return (minor<0?"−":"") + s + t; }
  function when(iso){ if(!iso) return ""; var d = new Date(iso); return d.toLocaleDateString(undefined,{day:"2-digit",month:"short"}) + " " + d.toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit"}); }
  function toast(msg){ var t = $("toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(t._h); t._h = setTimeout(function(){ t.classList.remove("on"); }, 2200); }
  function haptic(k){ try { if (tg && tg.HapticFeedback) { if (k==="ok") tg.HapticFeedback.notificationOccurred("success"); else if (k==="bad") tg.HapticFeedback.notificationOccurred("error"); else tg.HapticFeedback.impactOccurred("light"); } } catch(e){} }
  function copy(text){
    var done = function(){ haptic("ok"); toast("📋 Copied"); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function(){ fallbackCopy(text); done(); });
    else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text){ var ta = document.createElement("textarea"); ta.value = text; ta.style.position="fixed"; ta.style.opacity="0"; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch(e){} document.body.removeChild(ta); }
  function openBot(section){ if (!bot) { toast("Open the bot from Telegram for this."); return; } var link = "https://t.me/" + bot + "?start=" + section; if (tg && tg.openTelegramLink) tg.openTelegramLink(link); else location.href = link; }
  function api(path, body){
    return fetch(base + "/" + path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(Object.assign({ initData: initData }, body || {})) })
      .then(function(r){ return r.json().then(function(j){ if (!r.ok || j.success === false) { var m = (j.error && (j.error.message || j.error.code)) || j.message || ("Error " + r.status); var e = new Error(m); e.code = j.error && j.error.code; throw e; } return j.data || j; }); });
  }
  function needLogin(el){ el.innerHTML = '<div class="panel center"><div style="font-size:40px">👋</div><p>Open the bot and tap <b>Start</b> once — then everything here (orders, wallet, referrals) lights up.</p><button class="btn" id="golog">Open the bot</button></div>'; var b = $("golog"); if (b) b.onclick = function(){ openBot("shop"); }; }

  // ── Shop ──
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
    Array.prototype.forEach.call(g.querySelectorAll(".card"), function(el){ el.onclick = function(){ openProduct(list[+el.getAttribute("data-i")]); }; });
  }
  function chips(){
    var c = $("chips");
    var all = [{id:"all", name:"All", emoji:"✨", count: cat.products.length}].concat(cat.categories);
    c.innerHTML = all.map(function(x){ return '<div class="chip'+(active===x.id?" on":"")+'" data-id="'+esc(x.id)+'">'+esc((x.emoji?x.emoji+" ":"")+x.name)+' · '+x.count+'</div>'; }).join("");
    Array.prototype.forEach.call(c.children, function(el){ el.onclick = function(){ active = el.getAttribute("data-id"); haptic(); chips(); render(); }; });
  }
  function openSheet(html){ var s = $("sheet"); s.innerHTML = '<div class="handle"></div>' + html; s.classList.add("open"); $("sbg").classList.add("open"); if (tg && tg.BackButton) { tg.BackButton.show(); tg.BackButton.onClick(closeSheet); } }
  function closeSheet(){ $("sheet").classList.remove("open"); $("sbg").classList.remove("open"); if (tg && tg.BackButton) { tg.BackButton.hide(); tg.BackButton.offClick(closeSheet); } }
  $("sbg").onclick = closeSheet;
  function openProduct(p){
    var sel = p.variants.filter(function(v){ return v.inStock && v.priceMinor != null; })[0] || p.variants[0];
    var qty = 1;
    function draw(){
      var hero = p.imageUrl ? '<img src="'+esc(p.imageUrl)+'" alt="">' : esc(p.iconEmoji||"🎁");
      var total = sel && sel.priceMinor != null ? sel.priceMinor * qty : null;
      var canWallet = known && sel && sel.inStock && total != null && meBal != null && meBal >= total;
      var html = '<div class="hero">'+hero+'</div><h2>'+esc(p.name)+'</h2>'
        + (p.rating ? '<div class="rating">⭐ '+p.rating+' · '+p.ratingCount+' reviews</div>' : '')
        + (p.description ? '<div class="desc">'+esc(p.description)+'</div>' : '<div class="gap"></div>')
        + '<div class="vars">'+p.variants.map(function(v){ return '<div class="var'+(v.inStock?"":" out")+(sel&&v.id===sel.id?" sel":"")+'" data-v="'+esc(v.id)+'"><span>'+esc(v.name)+(v.inStock?"":" · sold out")+'</span><b>'+money(v.priceMinor, cat.currency)+'</b></div>'; }).join("")+'</div>'
        + (sel && sel.inStock ? '<div class="qty"><span>Quantity</span><span><button id="qm">−</button> &nbsp;<b>'+qty+'</b>&nbsp; <button id="qp">+</button></span></div>' : '')
        + (sel && sel.inStock
            ? (canWallet
                ? '<button class="btn ok" id="buyw">⚡ Pay '+money(total, cat.currency)+' from wallet — instant</button>'
                : (known && meBal != null && total != null
                    ? '<button class="btn sec" id="topup">💳 Wallet '+money(meBal, cat.currency)+' — top up '+money(total - meBal, cat.currency)+' more</button>'
                    : ''))
              + '<button class="btn'+(canWallet?" sec":"")+'" id="buyb">🛒 Pay with UPI / Binance / Crypto — in bot</button>'
            : '<button class="btn" disabled>🔔 Sold out</button>')
        + '<div class="foot">Wallet purchases are delivered right here and in the chat. Other payment methods open the bot.</div>';
      openSheet(html);
      Array.prototype.forEach.call(document.querySelectorAll(".var"), function(el){ el.onclick = function(){ var id = el.getAttribute("data-v"); var v = p.variants.filter(function(x){ return x.id===id; })[0]; if (v && v.inStock) { sel = v; qty = 1; haptic(); draw(); } }; });
      var qm = $("qm"), qp = $("qp"); if (qm) qm.onclick = function(){ if (qty>1) { qty--; draw(); } }; if (qp) qp.onclick = function(){ if (qty<50) { qty++; draw(); } };
      var bb = $("buyb"); if (bb) bb.onclick = function(){ openBot("p_" + encodeURIComponent(p.slug)); };
      var tu = $("topup"); if (tu) tu.onclick = function(){ openBot("topup"); };
      var bw = $("buyw"); if (bw) bw.onclick = function(){
        bw.disabled = true; bw.textContent = "Processing…";
        api("buy", { variantId: sel.id, qty: qty }).then(function(r){
          if (!r.ok) { haptic("bad"); bw.disabled = false; draw(); toast(r.message || "Could not buy"); if (r.reason === "insufficient") openBot("topup"); return; }
          haptic("ok"); meBal = Math.max(0, meBal - r.totalMinor); header();
          var vals = r.delivered.map(function(d){ return '<div class="panel" style="background:var(--bg)"><b>'+esc(d.productName)+'</b>' + d.values.map(function(v){ return '<div class="kv"><span class="mut">'+esc(v.label)+'</span><code>'+esc(v.value)+'</code><button class="copy" data-c="'+esc(v.value)+'">Copy</button></div>'; }).join("") + '</div>'; }).join("");
          openSheet('<div class="center" style="font-size:44px">🎉</div><h2 class="center">Order '+esc(r.orderNumber)+' delivered!</h2><p class="center mut">Paid '+money(r.totalMinor, r.currency)+' from your wallet. Also sent to your chat and saved in 📦 Orders.</p>'
            + (r.pendingManual > 0 ? '<p class="center mut">🕐 '+r.pendingManual+' item(s) are prepared by hand and will arrive in the chat.</p>' : '')
            + vals + '<button class="btn" id="done">Done</button>');
          bindCopy(); var d = $("done"); if (d) d.onclick = closeSheet; loaded.orders = false; loaded.wallet = false;
        }).catch(function(e){ haptic("bad"); bw.disabled = false; draw(); toast(e.message || "Could not buy"); });
      };
    }
    draw();
  }
  function bindCopy(){ Array.prototype.forEach.call(document.querySelectorAll(".copy"), function(b){ b.onclick = function(ev){ ev.stopPropagation(); copy(b.getAttribute("data-c")); }; }); }
  $("q").oninput = function(e){ q = e.target.value.trim().toLowerCase(); render(); };
  function loadCatalog(){
    fetch(base + "/catalog?currency=" + currency, { headers: { accept: "application/json" } })
      .then(function(r){ return r.json(); })
      .then(function(j){ cat = j.data || j; bot = bot || cat.botUsername; $("foot").textContent = cat.products.length + " products · prices in " + cat.currency; chips(); render(); })
      .catch(function(){ $("grid").innerHTML = '<div class="empty" style="grid-column:1/-1">Could not load the shop. Pull to retry.</div>'; });
  }

  // ── Tabs ──
  function show(t){
    Array.prototype.forEach.call($("tabs").children, function(el){ el.classList.toggle("on", el.getAttribute("data-t")===t); });
    ["shop","orders","wallet","refer","me"].forEach(function(k){ $("p-"+k).classList.toggle("on", k===t); });
    $("searchbox").style.display = t==="shop" ? "" : "none";
    window.scrollTo(0,0);
    if (t==="orders" && !loaded.orders) loadOrders(1);
    if (t==="wallet" && !loaded.wallet) loadWallet();
    if (t==="refer" && !loaded.refer) loadRefer();
    if (t==="me" && !loaded.me) loadMe();
  }
  Array.prototype.forEach.call($("tabs").children, function(el){ el.onclick = function(){ haptic(); show(el.getAttribute("data-t")); }; });

  // ── Orders ──
  function pill(st){ var ok = ["COMPLETED","PAID"].indexOf(st)>=0, bad = ["CANCELLED","EXPIRED","REFUNDED","REJECTED"].indexOf(st)>=0; return '<span class="pill '+(ok?"ok":bad?"bad":"wait")+'">'+esc(st.replace(/_/g," ").toLowerCase())+'</span>'; }
  function loadOrders(page){
    var el = $("p-orders"); if (!known) { needLogin(el); return; }
    api("orders", { page: page }).then(function(r){
      loaded.orders = true;
      if (!r.items.length) { el.innerHTML = '<div class="panel center"><div style="font-size:40px">📦</div><p>No orders yet. Your first one is a tap away.</p><button class="btn" id="goshop">🛍 Browse the shop</button></div>'; $("goshop").onclick = function(){ show("shop"); }; return; }
      el.innerHTML = '<div class="panel">' + r.items.map(function(o){ return '<div class="row" data-o="'+esc(o.id)+'" style="cursor:pointer"><div><b>#'+esc(o.orderNumber)+'</b>'+(o.isReplacement?' <span class="pill">replacement</span>':'')+'<div class="sub">'+when(o.createdAt)+'</div></div><div style="text-align:right"><b>'+money(o.totalMinor, o.currency)+'</b><div>'+pill(o.status)+'</div></div></div>'; }).join("") + '</div>'
        + (r.pages > 1 ? '<div class="center mut">Page '+r.page+' of '+r.pages+' &nbsp; '+(r.page>1?'<a href="#" id="op">◀ prev</a> ':'')+(r.page<r.pages?'<a href="#" id="on">next ▶</a>':'')+'</div>' : '')
        + '<div class="panel center mut">Problem with an order? Open it and tap <b>Report a problem</b> — support replies in the chat.</div>';
      Array.prototype.forEach.call(el.querySelectorAll("[data-o]"), function(x){ x.onclick = function(){ openOrder(x.getAttribute("data-o")); }; });
      var op = $("op"), on = $("on"); if (op) op.onclick = function(e){ e.preventDefault(); loadOrders(page-1); }; if (on) on.onclick = function(e){ e.preventDefault(); loadOrders(page+1); };
    }).catch(function(e){ if (e.code === "NOT_A_CUSTOMER") needLogin(el); else el.innerHTML = '<div class="empty">'+esc(e.message)+'</div>'; });
  }
  function openOrder(id){
    openSheet('<div class="empty">Loading…</div>');
    api("order", { orderId: id }).then(function(o){
      var items = o.items.map(function(i){ return '<div class="row"><div>'+esc(i.productName)+(i.variantName && i.variantName.toLowerCase()!=="standard" ? ' <span class="mut">· '+esc(i.variantName)+'</span>':'')+(i.replaced?' <span class="pill bad">replaced</span>':'')+'<div class="sub">'+(i.fulfilledAt?'Delivered '+when(i.fulfilledAt):'Pending')+(i.expiresAt?' · valid till '+i.expiresAt.slice(0,10):'')+'</div></div><b>×'+i.quantity+'</b></div>'; }).join("");
      var vals = o.delivered.length ? '<h3>🔑 Your items</h3>' + o.delivered.map(function(d){ return '<div class="panel" style="background:var(--bg)"><b>'+esc(d.productName)+'</b>'+(d.replaced?' <span class="pill bad">replaced — no longer works</span>':'')+d.values.map(function(v){ return '<div class="kv"><span class="mut">'+esc(v.label)+'</span><code>'+esc(v.value)+'</code><button class="copy" data-c="'+esc(v.value)+'">Copy</button></div>'; }).join("")+'</div>'; }).join("") : (o.status==="PENDING_PAYMENT" ? '<p class="mut">⌛ Waiting for payment — finish it in the bot.</p>' : '');
      openSheet('<h2>Order #'+esc(o.orderNumber)+' '+pill(o.status)+'</h2><div class="mut">'+when(o.createdAt)+' · '+money(o.totalMinor, o.currency)+(o.provider?' · '+esc(o.provider):'')+'</div><div class="panel" style="background:var(--bg);margin-top:10px">'+items+'</div>'+vals
        + (o.status==="PENDING_PAYMENT" ? '<button class="btn" id="payb">💳 Pay in bot</button>' : '<button class="btn sec" id="prob">🛟 Report a problem</button>'));
      bindCopy(); var pb = $("payb"); if (pb) pb.onclick = function(){ openBot("orders"); }; var pr = $("prob"); if (pr) pr.onclick = function(){ openBot("orders"); };
    }).catch(function(e){ openSheet('<div class="empty">'+esc(e.message)+'</div>'); });
  }

  // ── Wallet ──
  function loadWallet(){
    var el = $("p-wallet"); if (!known) { needLogin(el); return; }
    api("wallet").then(function(w){
      loaded.wallet = true; meBal = w.balanceMinor; header();
      var tx = w.entries.length ? w.entries.map(function(e){ var plus = e.amountMinor >= 0; return '<div class="row"><div>'+esc(e.type.replace(/_/g," ").toLowerCase())+'<div class="sub">'+when(e.createdAt)+(e.note?' · '+esc(e.note):'')+'</div></div><b style="color:'+(plus?"var(--ok)":"inherit")+'">'+(plus?"+":"")+money(e.amountMinor, w.currency)+'</b></div>'; }).join("") : '<div class="mut center">No transactions yet.</div>';
      var gifts = w.gifts.length ? '<h3>🎀 Gifts you sent</h3><div class="panel">'+w.gifts.map(function(g){ return '<div class="row"><div><code>'+esc(g.code)+'</code><div class="sub">'+when(g.createdAt)+'</div></div><div style="text-align:right"><b>'+money(g.amountMinor, g.currency)+'</b><div><span class="pill '+(g.status==="CLAIMED"?"ok":g.status==="REFUNDED"?"bad":"wait")+'">'+esc(g.status.toLowerCase())+'</span></div></div></div>'; }).join("")+'</div>' : '';
      el.innerHTML = '<div class="panel center"><div class="mut">Wallet balance</div><div class="big">'+money(w.balanceMinor, w.currency)+(w.currency==="USD"?' <span class="mut" style="font-size:14px">USDT</span>':'')+'</div><button class="btn" id="tu">➕ Top up — crypto / Binance / UPI</button><button class="btn sec" id="gift">🎀 Send a gift from balance</button></div>'
        + '<h3>🧾 Recent activity</h3><div class="panel">'+tx+'</div>' + gifts;
      $("tu").onclick = function(){ openBot("topup"); }; $("gift").onclick = function(){ openBot("topup"); };
    }).catch(function(e){ if (e.code === "NOT_A_CUSTOMER") needLogin(el); else el.innerHTML = '<div class="empty">'+esc(e.message)+'</div>'; });
  }

  // ── Refer ──
  function pct(n){ return Number.isInteger(n) ? String(n) : n.toFixed(1); }
  function loadRefer(){
    var el = $("p-refer"); if (!known) { needLogin(el); return; }
    api("referral").then(function(r){
      loaded.refer = true;
      var m = r.milestones, first = m && m.tiers.length ? m.tiers[0] : null, what = m && m.mode==="purchased" ? "friends who buy" : "friends";
      var forHow = r.commissionMonths > 0 ? "for the next <b>"+r.commissionMonths+" month"+(r.commissionMonths===1?"":"s")+"</b>" : "<b>for life</b>";
      var pitch = (first ? '<div style="font-size:16px;font-weight:800">🎯 Refer '+first.count+' '+what+' → get $'+first.rewardUsd.toFixed(2)+' bonus!</div>' : '')
        + '<div class="mut" style="margin-top:6px">💸 Earn <b>'+pct(r.firstPct)+'%</b> on every friend\\'s first order'+(r.repeatPct>0?' + <b>'+pct(r.repeatPct)+'%</b> on everything they buy '+forHow:'')+'.<br>💰 Paid straight into your wallet.</div>';
      var ladder = "";
      if (m) {
        ladder = '<h3>🏆 Bonus ladder</h3><div class="panel">' + m.tiers.map(function(t){ return '<div class="row"><span>'+(m.count>=t.count?"✅":"▫️")+' <b>'+t.count+'</b> '+what+'</span><b>$'+t.rewardUsd.toFixed(2)+'</b></div>'; }).join("")
          + (m.repeatLast && m.tiers.length ? '<div class="row mut">🔁 …and $'+m.tiers[m.tiers.length-1].rewardUsd.toFixed(2)+' again for every further '+m.tiers[m.tiers.length-1].count+'</div>' : '')
          + (m.next ? '<div class="bar"><i style="width:'+Math.min(100, Math.round(m.count/m.next.count*100))+'%"></i></div><div class="mut center"><b>'+m.count+'/'+m.next.count+'</b> — '+(m.next.count-m.count)+' more → $'+m.next.rewardUsd.toFixed(2)+'</div>' : '<div class="mut center">🎉 Every milestone unlocked ('+m.count+' so far)</div>')
          + (m.paidUsd>0 ? '<div class="mut center">💵 Bonuses received: $'+m.paidUsd.toFixed(2)+'</div>' : '') + '</div>';
      }
      var held = "";
      if (r.held && r.held.count > 0) {
        var hrs = r.held.nextReleaseAt ? Math.max(1, Math.ceil((new Date(r.held.nextReleaseAt).getTime() - Date.now())/3600000)) : 0;
        held = r.held.readyCount > 0
          ? '<button class="btn ok" id="claim">💰 Transfer '+money(r.held.minor, r.held.currency)+' to wallet</button>'
          : '<div class="mut center" style="margin-top:8px">⏳ On hold: <b>'+money(r.held.minor, r.held.currency)+'</b> — unlocks in ~'+hrs+'h ('+r.holdHours+'h anti-fraud hold), then moves to your wallet by itself.</div>';
      }
      el.innerHTML = '<div class="panel">'+pitch+'</div>'
        + '<div class="panel"><div class="row"><span>👥 Invited</span><b>'+r.invited+'</b></div><div class="row"><span>🛍 Bought</span><b>'+r.purchased+'</b></div><div class="row"><span>💰 Earned</span><b>'+money(r.earnedMinor, r.currency)+'</b></div>'+held+'</div>'
        + ladder
        + (r.link ? '<h3>🔗 Your link</h3><div class="panel"><div class="kv"><code>'+esc(r.link)+'</code><button class="copy" data-c="'+esc(r.link)+'">Copy</button></div><button class="btn" id="share">📤 Share my link</button></div>' : '')
        + '<div class="panel mut">⚡ <b>3 steps:</b> share your link → friend joins &amp; buys → money lands in your wallet.</div>';
      bindCopy();
      var sh = $("share"); if (sh) sh.onclick = function(){ var text = "🎁 Join ${esc(store)} — instant digital products at the best prices! Use my link:"; var u = "https://t.me/share/url?url=" + encodeURIComponent(r.link) + "&text=" + encodeURIComponent(text); if (tg && tg.openTelegramLink) tg.openTelegramLink(u); else location.href = u; };
      var cl = $("claim"); if (cl) cl.onclick = function(){ cl.disabled = true; api("referral/claim").then(function(x){ haptic("ok"); toast(x.credited>0 ? "✅ "+money(x.creditedMinor, x.currency||r.currency)+" moved to your wallet" : "Nothing ready yet"); loaded.wallet = false; loadRefer(); }).catch(function(e){ cl.disabled=false; toast(e.message); }); };
    }).catch(function(e){ if (e.code === "NOT_A_CUSTOMER") needLogin(el); else el.innerHTML = '<div class="empty">'+esc(e.message)+'</div>'; });
  }

  // ── Me ──
  function loadMe(){
    var el = $("p-me"); if (!known) { needLogin(el); return; }
    api("profile").then(function(u){
      loaded.me = true;
      var tier = u.tier ? '<div class="panel"><div class="row"><span>💎 Tier</span><b>'+esc(u.tier.name)+(u.isVip?' · VIP':'')+'</b></div><div class="mut">'+esc(u.tier.perk)+'</div>'+(u.tier.next?'<div class="bar"><i style="width:'+u.tier.progressPct+'%"></i></div><div class="mut center">'+money(u.tier.next.toNextMinor, u.tier.next.currency)+' more to '+esc(u.tier.next.name)+'</div>':'')+'</div>' : '';
      var tk = u.tickets.length ? '<h3>🎫 Support tickets</h3><div class="panel">'+u.tickets.map(function(t){ return '<div class="row"><div><b>'+esc(t.number)+'</b><div class="sub">'+esc(t.subject)+'</div></div><span class="pill '+(t.status==="RESOLVED"||t.status==="CLOSED"?"ok":"wait")+'">'+esc(t.status.replace(/_/g," ").toLowerCase())+'</span></div>'; }).join("")+'</div>' : '';
      el.innerHTML = '<div class="panel"><div class="row"><div><b>'+esc(u.firstName||"Customer")+'</b>'+(u.handle?' <span class="mut">@'+esc(u.handle)+'</span>':'')+'<div class="sub">ID '+esc(u.telegramId)+(u.memberSince?' · since '+new Date(u.memberSince).toLocaleDateString(undefined,{month:"short",year:"numeric"}):'')+'</div></div><b>📦 '+u.orders+'</b></div>'
        + '<div class="row"><span>💱 Currency</span><div class="seg" id="cur"><div data-c="USD"'+(u.currency==="USD"?' class="on"':'')+'>$ USD</div><div data-c="INR"'+(u.currency==="INR"?' class="on"':'')+'>₹ INR</div></div></div></div>'
        + tier + tk
        + '<div class="panel"><button class="btn" id="sup">💬 Chat with support</button><button class="btn sec" id="help">❓ Help &amp; FAQ</button><button class="btn sec" id="acct">👤 Full account in bot</button></div>';
      Array.prototype.forEach.call($("cur").children, function(d){ d.onclick = function(){ var c = d.getAttribute("data-c"); if (c===u.currency) return; api("currency", { currency: c }).then(function(){ haptic("ok"); currency = c; toast("Prices now in "+c); loaded = {}; loadCatalog(); loadMe(); }).catch(function(e){ toast(e.message); }); }; });
      $("sup").onclick = function(){ openBot("support"); }; $("help").onclick = function(){ openBot("support"); }; $("acct").onclick = function(){ openBot("account"); };
    }).catch(function(e){ if (e.code === "NOT_A_CUSTOMER") needLogin(el); else el.innerHTML = '<div class="empty">'+esc(e.message)+'</div>'; });
  }

  // ── Header / boot ──
  function header(){ if (!known) { $("me").innerHTML = "Tap /start in the bot<br>to unlock wallet &amp; orders"; return; } $("me").innerHTML = (meBal!=null ? "💰 <b>"+money(meBal, currency)+"</b>" : "") ; }
  if (initData) {
    api("me").then(function(d){
      bot = d.bot || bot;
      if (d && d.known) { known = true; currency = d.currency || "USD"; meBal = d.balanceMinor; $("me").innerHTML = "Hi, <b>" + esc(d.firstName || (d.user && d.user.firstName) || "there") + "</b><br>💰 " + money(d.balanceMinor, d.balanceCurrency || currency) + " · 📦 " + d.orders; }
      else header();
    }).catch(header).then(loadCatalog);
  } else { header(); loadCatalog(); }
})();
</script>
</body>
</html>`;
}
