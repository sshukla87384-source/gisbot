# Get It Sasta — Telegram Bot UX Flow

**Version:** 1.0 · **Phase 3** · Library: grammY (webhooks) + @grammyjs/conversations + @grammyjs/menu

---

## 1. Conventions

- **Everything is inline keyboards + callback queries.** Reply keyboards only for the persistent bottom menu toggle. Free-text input only inside conversations (search query, deposit amount, ticket message), always cancellable with an inline ✖️ Cancel button.
- **Edit-in-place:** navigation edits the current message (editMessageText) instead of sending new ones — keeps chat clean.
- **Every callback is answered** (`answerCallbackQuery`) within 1 s; slow operations show a toast "⏳ Working…" and follow up by editing the message.
- **Pagination:** `◀️ 1/7 ▶️` buttons, 6–8 items per page.
- **Callback data schema** (64-byte limit): `<ns>:<action>:<arg1>:<arg2>` — e.g. `shp:cat:12:2` (shop → category 12 → page 2), `crt:add:variant_87`, `ord:view:GIS-2026-000123`. Long payloads are stored in Redis and referenced by a short token: `x:<token>`. Every callback is validated with Zod; unknown/expired → toast "Menu expired, use /start".
- **State:** conversation state in Redis (`bot:sess:<userId>`), TTL 24 h. Stateless deep links for shareable entry points: `?start=ref_<code>`, `?start=p_<productSlug>`, `?start=order_<id>`.

## 2. Onboarding

```
/start [payload]
 ├─ new user → create User (telegramId, locale) → attribute referral if ref_ payload
 │   → welcome card (brand banner, 1-line pitch) → [🛍 Start Shopping] [❓ How it works]
 ├─ payload p_<slug> → jump straight to product page
 └─ returning → Main Menu
```

Language/currency defaults inferred from Telegram locale; changeable in ⚙ Settings.

## 3. Main Menu (single message, 2-column inline grid)

```
🏠 Get It Sasta — Main Menu
Wallet: ₹1,240 · Orders: 12 · 🔔 2

[🛍 Shop]        [📂 Categories]
[🔍 Search]      [🛒 Cart (2)]
[📦 Orders]      [🔑 My Licenses]
[💳 Wallet]      [🎟 Coupons]
[👥 Referral]    [🎫 Support]
[👤 Profile]     [⚙ Settings]
[❓ Help]
```

Commands mirror the menu: `/shop /search /cart /orders /wallet /support /help` (registered via setMyCommands). Resellers see an extra row: `[🏪 Reseller Hub]`.

## 4. Shop & Product Flow

```
🛍 Shop → featured + bestsellers (paginated cards)
📂 Categories → category tree (subcategories → product list)
🔍 Search → conversation: "Type product name…" → fuzzy results list

Product list item: "Windows 11 Pro Key — from ₹899 ⭐4.9 (231)"
      ↓ tap
Product page (photo/banner + caption):
  Name, description, price range, stock badge (✅ In stock / 🟡 Low / ❌ Out),
  delivery badge (⚡ Instant / 🕐 Manual, ~12h), seller badge (🏬 Get It Sasta / 🏪 Reseller ★4.7)
  [Variant: 1 Month ₹199] [3 Months ₹499] [12 Months ₹1,499]   ← variant selector
  [➕ Add to Cart] [⚡ Buy Now]
  [📄 Details] [⭐ Reviews] [◀️ Back]
```

`⚡ Buy Now` = add single item + jump to checkout.

## 5. Cart & Checkout

```
🛒 Cart
  1. Netflix Premium — 3 Months  ₹499   [➖ 1 ➕] [🗑]
  2. Windows 11 Pro Key          ₹899   [➖ 1 ➕] [🗑]
  Subtotal ₹1,398
  [🎟 Apply Coupon] [🧹 Clear] [✅ Checkout]

Checkout summary (order preview):
  Items, coupon line (−₹100), wallet toggle [💳 Use wallet balance: ON],
  payable total, currency
  [Pay with UPI/Card (Razorpay)] [Pay with Card (Stripe)] [PayPal] [⭐ Stars] [💰 Wallet only]
      ↓ creates Order (PENDING_PAYMENT, 15-min timer shown)
  → payment link button [🔗 Pay ₹1,298] (or native Stars invoice)
      ↓ webhook confirms
  ✅ "Payment received! Delivering…" (edited in place)
      ↓ fulfillment (< 5 s for instant items)
  📦 Delivery message(s) — see §6
  ↓ if timer expires → "⌛ Order expired" [🔁 Retry payment] [🗑 Cancel]
```

Coupon apply = conversation (type code) → instant validation feedback with reason on failure ("Expired", "Min cart ₹999", "Already used").

## 6. Delivery Messages

- **License key:** monospace key in `<code>` block + [📋 How to activate] + [🧾 Invoice PDF] + [⚠️ Report problem]. Also stored in 🔑 My Licenses.
- **Digital account:** credentials sent with spoiler formatting, warning "Do not change the password", validity date, [⚠️ Report problem].
- **File:** signed URL button [⬇️ Download (expires in 24 h, 3 uses)].
- **Manual:** "🕐 Your order is being prepared (ETA ~12 h). We'll notify you here." → later the credential/file message.

## 7. Orders, Licenses, Subscriptions

```
📦 Orders → paginated list "GIS-2026-000123 · ₹1,298 · ✅ Completed"
  → order detail: items, status timeline, [🧾 Invoice] [🔁 Reorder] [🎫 Get help]

🔑 My Licenses (license vault):
  filter [All] [Keys] [Accounts] [Files] [Subscriptions]
  → item → re-view credentials (re-sent as new self-destructible message),
    activation guide, expiry, [🔄 Renew] for subscriptions

Subscriptions: expiry reminders at T-7/3/1 → [🔄 Renew now] [🔕 Stop reminders]
  auto-renew toggle (wallet-funded) per subscription
```

## 8. Wallet

```
💳 Wallet — Balance ₹1,240 (INR)
  [➕ Deposit] [📤 Withdraw] [📜 History]
Deposit: conversation → amount → gateway buttons → webhook → "✅ ₹500 added"
Withdraw (resellers/customers with earnings): amount + method (UPI/bank/PayPal)
  → "Pending admin approval" → notification on approve/reject
History: paginated ledger (type icon, amount ±, running balance, timestamp)
```

## 9. Referral & Coupons

```
👥 Referral
  Your link: t.me/GetItSastaBot?start=ref_AB12CD (tap to copy) [📤 Share]
  Stats: Invited 14 · Purchased 5 · Earned ₹430
  [📜 Reward history] [ℹ️ Terms]

🎟 Coupons → list of active/available coupons for this user with copy buttons
```

## 10. Support

```
🎫 Support → [🆕 New Ticket] [📂 My Tickets]
New: category picker → describe issue (text/photo) → ticket created #T-000482
Thread: replies from admin panel arrive as bot messages "💬 Support (T-000482): …"
  user replies via [↩️ Reply] conversation; [✅ Close ticket] with CSAT 1–5
```

## 11. Reseller Hub (role-gated)

```
🏪 Reseller Hub
  [📊 Dashboard]  — today/7d/30d sales, commission, wallet hold
  [🛒 Buy Wholesale] — catalog at wholesale prices
  [📦 My Listings] — list/create products (guided conversation → admin approval)
  [🗃 My Inventory] — upload keys (paste or CSV file), stock levels, low-stock alerts
  [👥 My Customers] [📈 Reports] [💸 Payouts] [🎫 Support]
```

Heavy reseller management (bulk CSV, analytics) is nudged to the web panel: [🖥 Open Reseller Panel] (magic-link login, §Security doc).

## 12. Profile, Settings, Help

- 👤 Profile: name, email (add/verify for invoices), member since, role badges, total orders.
- ⚙ Settings: language, currency, notification toggles (order updates always on; marketing opt-in/out).
- ❓ Help: FAQ accordion (inline pages), activation guides per product category, contact.

## 13. Admin-side bot notifications

Admin Telegram channel/group receives: new manual-fulfillment orders (with [Fulfill in panel] deep link), payment failures, low-stock alerts, withdrawal requests, new reseller applications, new tickets, system alerts.

## 14. Error & Edge Handling

- Bot blocked by user → mark notifiable=false, email fallback if available.
- Callback from stale message (schema version mismatch) → toast + fresh main menu.
- Payment webhook arrives after order expiry → auto-reactivate order if stock still held, else wallet-credit and notify.
- Duplicate rapid taps → per-user Redis debounce lock (500 ms).
- Maintenance mode → all handlers reply with maintenance card except admins.
- Anti-spam: per-user token bucket (20 interactions/10 s → cooldown warning; repeated → temp mute 10 min, logged).
