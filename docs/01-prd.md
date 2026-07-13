# Get It Sasta — Product Requirements Document (PRD)

**Version:** 1.0 · **Date:** 2026-07-13 · **Status:** Draft for approval (Phase 1)

---

## 1. Product Summary

Get It Sasta is a Telegram-first digital products marketplace. Customers browse, buy, and receive digital goods (license keys, accounts, subscriptions, downloadable files) inside a Telegram bot. A web admin panel manages the platform; a reseller program lets third parties both buy at wholesale and list their own inventory (marketplace model).

**Confirmed decisions:**

| Decision | Choice |
|---|---|
| Market | India + Global from day one (multi-currency: INR base, USD + others display) |
| Reseller model | Full marketplace — resellers buy platform stock at wholesale AND list their own inventory for commission-based payouts |
| Hosting | Hostinger VPS KVM 8 (8 vCPU / 32 GB RAM / NVMe), single node, Docker Compose, with documented horizontal scale-out path |
| First delivery cycle | Phases 1–6 design docs, implementation after approval |

## 2. Goals & Non-Goals

**Goals**

- Sub-5-second automatic delivery after confirmed payment.
- Zero duplicate deliveries (transactional inventory assignment with row locking).
- Support 100k+ registered users, thousands of orders/day on a single KVM 8 node.
- Multi-gateway payments behind a provider abstraction (Razorpay, Stripe, PayPal, Telegram Stars, wallet).
- Marketplace reseller program with commission accounting and payout workflow.
- Enterprise security: encrypted credentials at rest, RBAC, audit trail, signed download URLs.

**Non-Goals (v1)**

- Native mobile apps or a public web storefront (Telegram is the storefront; admin panel is web).
- Crypto payments (pluggable later via the payment provider interface).
- Multi-language bot UI (architecture is i18n-ready; v1 ships English; Hindi/Hinglish strings can be added without code changes).
- Automated tax filing (tax fields captured on invoices; filing is manual).

## 3. Compliance & Sourcing Note

The platform is a neutral commerce system. Operationally, the business owner must ensure listed goods are legitimately sourced and resellable: OEM/volume license keys must come from authorized channels, and subscription accounts (Netflix, Spotify, ChatGPT, etc.) must be sold in a manner consistent with each provider's terms of service and local law. The platform supports this with per-product **sourcing metadata**, supplier records on inventory items, and audit logs — and gives admins a kill-switch (product disable, inventory recall) if a supplier turns out to be bad. Gateway risk: Stripe/Razorpay/PayPal restrict certain digital-goods categories; onboarding descriptors and category codes must be accurate to avoid account termination.

## 4. Roles

| Role | Summary |
|---|---|
| **Super Admin** | Full control: catalog, inventory, orders, payments, refunds, users, resellers, coupons, wallets, tickets, broadcasts, templates, settings, API keys, audit logs, backups, maintenance mode, role management |
| **Admin** (custom roles) | Permission-scoped subset via RBAC (e.g., Support Agent, Inventory Manager, Finance) |
| **Reseller** | Verified seller account: wholesale purchasing, own product listings, own inventory upload, commission dashboard, payout requests, customer management, sales reports |
| **Customer** | Browse, search, cart, checkout, wallet, coupons, license vault, downloads, subscriptions, referrals, tickets |

A single user record can hold multiple roles (a customer can be upgraded to reseller).

## 5. Product Types & Fulfillment Matrix

| Type | Inventory unit | Delivery | Notes |
|---|---|---|---|
| **License Key** | One key per row | Automatic (default) | Statuses: AVAILABLE, RESERVED, SOLD, EXPIRED, DISABLED. Duplicate detection on import (hash of normalized key) |
| **Digital Account** | Credential set (username, encrypted password, recovery email, expiry, notes) | Automatic or manual | AES-256-GCM encrypted at rest; slot-based sharing supported (e.g., 1 account, 5 profile slots) |
| **Subscription** | Backed by key or account + plan | Automatic or manual | Plans: MONTHLY, QUARTERLY, SEMIANNUAL, ANNUAL, LIFETIME. Tracks activation, expiry, renewal reminders (T-7/T-3/T-1 days), optional auto-renew from wallet |
| **Downloadable File** | S3 object (ZIP/PDF/code/templates/eBooks) | Automatic | Signed URLs, configurable expiry (default 24 h) and download limit (default 3) |
| **Manual Service** | None (fulfilled by admin) | Manual | e.g., custom activations. SLA timer + admin escalation |

Products support **variants** (e.g., Windows 11 Pro vs Home; Netflix 1-month vs 12-month) — each variant has its own price set, inventory pool, and fulfillment mode.

## 6. Core Business Rules

### 6.1 Ordering & Fulfillment

1. Cart → checkout creates an Order in `PENDING_PAYMENT`, with a 15-minute payment window; inventory is **not** reserved until payment initiation, then soft-reserved (RESERVED status + TTL) to prevent overselling during payment.
2. Payment confirmation is accepted **only** via verified gateway webhook (never client redirect alone). Webhook processing is idempotent (idempotency key = gateway event ID).
3. Fulfillment runs in a single DB transaction: lock inventory rows (`SELECT ... FOR UPDATE SKIP LOCKED`), assign, mark SOLD, write OrderItem delivery payload, create invoice, write audit log. Message dispatch to Telegram happens after commit via queue.
4. If stock ran out between reservation expiry and payment (edge case), order goes to `AWAITING_STOCK`, admin is alerted, customer is offered wallet refund or wait.
5. Manual products: payment → `PENDING_FULFILLMENT` → admin uploads credentials/files in panel → secure delivery → `COMPLETED`. SLA default 12 h with escalation alert at 75%.

### 6.2 Multi-currency

- Every price is stored per-currency (explicit price rows, no runtime FX conversion for charging). Base currency: INR. Supported at launch: INR, USD.
- Gateway routing: Razorpay for INR (UPI/cards/netbanking), Stripe for USD/international cards, PayPal optional, Telegram Stars optional. Wallets are single-currency per user (set at first deposit; default from Telegram locale).
- Display conversion (catalog browsing) may use a cached daily FX rate, clearly marked "approx."

### 6.3 Wallet

- Ledger-based: balance is the sum of immutable transaction rows (no mutable balance column as source of truth; a cached balance column exists for reads and is reconciled).
- Transaction types: DEPOSIT, PURCHASE, REFUND, CASHBACK, REFERRAL_REWARD, COMMISSION (credited on hold release), WITHDRAWAL, ADJUSTMENT, REVERSAL.
- Withdrawals require admin approval; minimum/maximum limits configurable; KYC flag gate for resellers above a threshold.
- All wallet mutations are serialized per-wallet (row lock) to prevent race-condition double spends.

### 6.4 Coupons

Fixed or percentage; scopes: global, product, category, user; constraints: expiry, total usage limit, per-user limit, minimum cart value, first-purchase-only, stackable flag (default non-stackable), new-user-only. Validation happens twice: at apply time and atomically inside checkout transaction.

### 6.5 Referrals

Every user gets a code + deep link (`https://t.me/<bot>?start=ref_<code>`). Attribution: first-touch, stored at /start, immutable. Reward model (configurable): fixed or % of first N purchases, credited to wallet as REFERRAL_REWARD after the referred order passes a 48 h anti-fraud hold (no refund/chargeback). Self-referral, same-device, and same-payment-instrument abuse are detected and rewards withheld.

### 6.6 Reseller Program

- **Wholesale tier:** reseller price group applied automatically at checkout for platform-owned products.
- **Marketplace listings:** resellers create products (admin approval required before publish), upload their own inventory (keys/accounts/files), and set prices. Platform charges a commission % (global default, overridable per reseller/category).
- **Settlement:** on order completion, reseller earnings (price − commission) accrue to reseller wallet with a configurable hold period (default 7 days) covering refund risk. Payouts via withdrawal workflow.
- **Trust controls:** reseller verification states (PENDING, VERIFIED, SUSPENDED, BANNED), delivery-failure rate tracking, automatic suspension threshold, customer disputes route to platform support with reseller wallet clawback capability.

### 6.7 Refunds

Full or partial; destinations: original gateway (where supported) or wallet (default, instant). Refunding a delivered key/account marks inventory DISABLED (not returned to pool) and flags the customer record if refund rate is anomalous.

### 6.8 Support

Ticket categories (order issue, delivery issue, payment issue, account, other), priority, assignment, threaded messages relayed bot↔panel, canned replies, SLA timers, CSAT prompt on close.

### 6.9 Notifications & Broadcasts

Transactional: order status, delivery, wallet, subscription expiry, ticket replies — via Telegram, with email (Resend) fallback/duplicate for invoices and credentials receipts. Broadcasts: segmented (all, customers, resellers, buyers-of-product-X, inactive-30d), rate-limited to respect Telegram limits (~30 msg/s global, throttled via queue), with opt-out honored.

## 7. Key Metrics (built into analytics)

Revenue (gross/net, by currency, by gateway), orders/day, AOV, delivery latency p50/p95, stock-out incidents, refund rate, coupon ROI, referral conversion, reseller GMV & commission, DAU/WAU of bot, ticket first-response and resolution time.

## 8. Non-Functional Requirements

| Requirement | Target |
|---|---|
| API latency | < 200 ms p95 for reads, < 500 ms p95 for checkout |
| Delivery latency | < 5 s from webhook receipt to Telegram message |
| Availability | 99.9% (single-node constraint acknowledged; see Architecture §7 for path to HA) |
| Data durability | Nightly encrypted off-site backups + WAL archiving, RPO ≤ 15 min, RTO ≤ 2 h |
| Concurrency | 500 concurrent checkout sessions without oversell |
| Security | OWASP Top 10 coverage, credentials encrypted at rest, full audit trail |

## 9. Open Questions (answers assumed if not overridden)

1. **KYC for resellers** — assumed: manual document review by admin, no third-party KYC API in v1.
2. **Telegram Stars** — assumed: enabled but secondary (Stars settle in XTR; pricing rounded).
3. **Invoice legal entity / GST** — invoice fields include GSTIN placeholders; assumed owner provides entity details before launch.
4. **Email verification for customers** — assumed optional (Telegram identity is primary); required for resellers.

## 10. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Payment gateway account termination (digital goods policies) | Accurate MCC/onboarding, gateway abstraction makes replacement a config change, wallet as buffer |
| Bad reseller inventory (invalid keys) | Approval gate, hold period, failure-rate suspension, clawback |
| Telegram API rate limits during broadcasts/spikes | Central queued outbox with token-bucket throttling |
| Single-node failure | Documented DR runbook, off-site backups, IaC-style compose files for fast rebuild; upgrade path to multi-node |
| Credential leakage | AES-256-GCM app-layer encryption, key in env/KMS, decrypt only at delivery time, no plaintext in logs |
