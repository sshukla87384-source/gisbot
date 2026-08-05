# Next features — agreed spec

Written at the end of the build session so the next session implements exactly
what was asked, not an approximation. Repo: `/opt/gisbot`.


---

## 0. Quantity (bulk) discounts  *(requested last — build FIRST, it is small and high value)*

Buy more, pay less per unit.

- Per product, admin sets tiers, e.g.
  - `5+  → 5% off`
  - `10+ → 10% off`
  - `25+ → 15% off`
- Admin UI: on the product view, "🔢 Quantity discounts" — add/edit/remove tiers,
  shown as a simple list. Tiers are per product; a store-wide default is optional.
- Customer sees it BEFORE buying: the product card lists the tiers, and the
  quantity picker updates the total live ("10 × $1.59 = $14.31 — you save $1.59").

### Money rules (must hold, these are the parts that break)
1. The tier discount applies to the **already-effective** unit price, i.e. AFTER
   a flash sale and AFTER any per-user custom price (`UserPrice`). Decide and
   document one order of precedence and use it in BOTH paths.
2. **Display and charge must agree.** `getCartView` (display) and `priceCart`
   (charge) are separate code paths — apply the tier in a single shared helper
   used by both, or they will drift.
3. Rounding: compute the discounted UNIT price in integer minor units, then
   multiply by quantity. Never discount the line total and re-derive the unit
   price, or the two paths disagree by a cent.
4. The API must report the tiered price too (`/products` variants and the order
   response), in USDT like everything else.
5. Verify with a script before shipping: for each tier boundary (4/5/9/10/24/25)
   assert display total === charged total === expected, including with a sale and
   a custom price active.

### Suggested storage
`ProductQuantityTier { productId, minQty, percentBp }` with a unique on
`(productId, minQty)`; highest matching `minQty` wins.

---

## 1. Back-in-stock waitlist  *(recommended first)*

**Why:** products go out of stock regularly and that demand is currently lost.

- "🔔 Notify me" button on any sold-out product.
- On restock (manual add, supplier sync, or reusable-quantity top-up) everyone
  on that product's list gets one message with a Buy button.
- Anti-spam: one notification per person per product per restock, and a cooldown
  so repeated small restocks don't blast the same person repeatedly.
- Admin: see waitlist counts per product — this is also the signal for **what to
  buy more of** from suppliers.

---

## 2. Loyalty tiers (Bronze → Silver → Gold)

Automatic tiers based on lifetime spend. Thresholds editable in admin.

**Automatic part**
- Tier is recalculated after each completed order.
- Tier grants an automatic discount, reusing the existing per-user custom
  pricing mechanism (`UserPrice`) rather than a parallel system.
- Customer is told when they level up, and how far they are from the next tier.

**Manual gift part — as specified**
- Admin can send a **custom gift** to any customer or to a whole tier.
- The bot ONLY sends the **notification** ("🎁 You've received a gift: …").
- **Delivery is manual, done by the admin from inside this program** — the gift
  is tracked as a pending item in the admin panel with a "✅ Mark as delivered"
  action, so nothing is auto-issued.
- Admin writes the gift text/description themselves per gift.

---

## 3. Spin the wheel — challenge based *(as specified)*

Not a random prize wheel. The spin **assigns a task automatically**.

- Example task: *"Buy products worth $100 and get a discount credited as wallet
  balance."*
- **Reward cap: never more than 2% of the challenge target.** For a $100 target
  the maximum reward is **$2.00**. This cap is a hard rule in code, not a
  setting that can be exceeded.
- Reward is paid as **wallet balance**, credited only once the target spend is
  actually reached (verified from completed orders, not self-reported).
- One active challenge per customer at a time; challenge has an expiry.
- Admin controls: which targets can be drawn, reward %, expiry window, on/off.
- Progress is visible to the customer ("$62 of $100 — $2.00 waiting").

**Money-safety requirements** (this touches the wallet, so):
- Credit exactly once per completed challenge (idempotency key on the ledger).
- Only count orders that are COMPLETED and not later refunded/cancelled.
- Reward credited in the wallet's own currency, using the pinned FX rate.

---

## 4. Price-drop alerts

- Customers "watch" a product; they are messaged when its price drops.
- Reuses the existing price-change announcement, but targeted at watchers only.

---

## 5. Referral leaderboard

- Visible top-10 by referred buyers, monthly reset, admin-set prize.
- Referral system already exists — this is presentation plus a monthly cycle.

---

## Build order

0. **Quantity (bulk) discounts** — small, high value, but touches pricing: verify with a script
1. Back-in-stock waitlist (captures lost demand, no money logic)
2. Loyalty tiers + manual gifts
3. Spin the wheel (money — build carefully, verify the 2% cap with tests)
4. Price-drop alerts
5. Referral leaderboard
6. Customer utilities — A (2FA generator) first, it is small and removes a third-party dependency
7. Reseller: R1 sandbox keys (unblocks reseller integrations), then R2 webhooks, then R3 dashboard
8. C1 gift a product

## Notes for whoever picks this up

- Money paths in this repo are covered by hard-won fixes: FX is pinned in
  `packages/core/src/fx.ts`, wallet debits convert between order and wallet
  currency, and cancelled/expired orders refund wallet money. Do not bypass
  these when crediting rewards.
- Verify money maths with a script before shipping — that practice caught a
  50% overcharge and a 100x pricing bug during this build.
- Admin routes live behind `guard(ctx)` in `apps/telegram-bot/src/admin.ts`.
- Errors and wallet anomalies surface in the bot at
  **/Shriji → 🔐 Security → 🩺 Logs & Errors**.

---

## Customer-facing utilities (agreed as useful)

### A. Built-in 2FA / OTP generator  *(highest value — removes an external dependency)*
- Products delivered as `id|password|2fa_secret` currently tell the customer to
  paste the secret into **2fa.live**, a third-party site we do not control.
- Instead: a **"🔢 Get my OTP"** button on the delivered item generates the
  6-digit TOTP **inside the bot**, with the seconds remaining until it rotates.
- Standard TOTP (RFC 6238, HMAC-SHA1, 30s window, 6 digits) computed locally —
  no network call, and the secret never leaves the server.
- Handle base32 secrets with/without spaces and padding; show a clear error if
  the stored secret is not valid base32 rather than a wrong code.
- Keep the 2fa.live instructions as a fallback for anyone who prefers it.

### B. Expiry reminders + one-tap re-buy
- Delivered items already carry `expiresAt`. Message the buyer a few days before
  (admin-set lead time) with a **🔄 Renew now** button that re-buys the same
  variant.
- Recurring revenue from customers who would otherwise drift to another seller.
- One reminder per item; never remind on refunded/replaced items.

### C. Receipt / keys export
- "📄 Download all my keys" for an order (or all orders) as a `.txt` — the
  `buildDeliveryTxt` helper already exists.
- Optional simple invoice for business buyers (store name, order number, date,
  items, total).

### D. "Is my key still working?"
- One tap on any delivered item: either reassure the customer, or open a
  replacement claim **pre-filled with that order** so they skip the picker.
- Cuts support volume and routes genuine faults into the existing warranty flow.

---

## Reseller-facing features (agreed as useful)

### R1. Sandbox / test API keys  *(build first — solves an observed problem)*
A reseller's importer reported: *"order: from the docs, not tested — a test would
place a real paid order."* So resellers cannot verify their purchase code without
spending real money, and discover bugs on live orders instead.

- A key flagged `testMode` behaves identically but:
  - returns realistic **fake** delivered keys (clearly marked `TEST-…`)
  - never consumes stock, never debits a wallet, never calls a supplier
  - orders are recorded with a `test` flag and excluded from stats/profit
- Same endpoints, same response shapes, so integration code needs no changes.
- Toggle in the bot: 🧑‍💻 Developer API → "🧪 Create test key".

### R2. Webhooks
- Resellers register a URL and receive events instead of polling `/products`:
  `stock.changed`, `price.changed`, `product.added`, `order.delivered`.
- Signed with an HMAC secret per endpoint; retries with backoff; deliveries
  visible in the bot so they can debug their own receiver.
- Also reduces load on our API as reseller count grows.

### R3. Reseller dashboard (in the bot)
- Their own numbers: spend, orders, top products, wallet burn rate, and API
  usage against their rate limit.
- Reduces "how much have I spent?" support messages.

---

## Customer feature

### C1. Gift a product to another user
- Buy and send directly to a friend's @username; the recipient gets the keys with
  "🎁 A gift from {buyer}".
- No payment complexity — a normal purchase with a different delivery target.
- Acquires new customers through existing buyers.
- Guards: recipient must have started the bot; if not, hold the gift and deliver
  on their first /start. Never expose the buyer's keys to the wrong person.
