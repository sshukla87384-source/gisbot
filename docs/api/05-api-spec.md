# Get It Sasta — API Specification

**Version:** 1.0 · **Phase 5** · Base URL: `https://api.getitsasta.com/api/v1` · OpenAPI generated via NestJS Swagger at `/api/docs` (basic-auth protected in prod)

---

## 1. Conventions

### 1.1 Consumers
| Consumer | Auth | Notes |
|---|---|---|
| Admin panel (Next.js) | JWT access (15 min) in `Authorization: Bearer` + refresh cookie; CSRF token on mutations | audience `admin` |
| Reseller panel (same Next.js app, role-gated) | Same as admin, audience `portal` | permissions scoped by RBAC |
| Telegram bot & workers | In-process service calls (packages/core), **not** HTTP | no network hop |
| External integrations | `X-Api-Key` (hashed lookup, scoped) | rate-limited per key |
| Payment gateways | Signature-verified webhooks (no auth token) | raw-body routes |

### 1.2 Envelope
Success:
```json
{ "success": true, "data": { }, "meta": { "page": 2, "perPage": 20, "total": 143, "totalPages": 8 } }
```
Error (RFC-7807-inspired, stable machine codes):
```json
{ "success": false, "error": { "code": "COUPON_EXPIRED", "message": "This coupon expired on 2026-06-30.",
  "details": [{ "field": "couponCode", "issue": "expired" }], "requestId": "req_8fk2…" } }
```
HTTP codes: 200/201, 400 validation, 401 unauthenticated, 403 forbidden, 404, 409 conflict (idempotency/state), 422 business rule, 429 rate limit, 500.

### 1.3 List query grammar
`?page=1&perPage=20&sort=-createdAt,name&search=windows&filter[status]=ACTIVE&filter[createdAt][gte]=2026-01-01`
- All list endpoints support pagination (max perPage 100), whitelisted sort fields, whitelisted filters, and `search` where noted.
- All request bodies validated with Zod schemas shared from `packages/shared` (same schemas reused by bot and panel forms).
- All money fields: `{ "amountMinor": 149900, "currency": "INR" }`.
- Mutating endpoints accept optional `Idempotency-Key` header (stored 24 h in Redis; replay returns original response).

## 2. Endpoint catalog

### 2.1 Auth (`/auth`)
| Method | Path | Description |
|---|---|---|
| POST | `/auth/login` | email+password (argon2id verify) → access JWT + refresh cookie; 423 + challenge if 2FA enabled |
| POST | `/auth/2fa/verify` | TOTP code → completes login |
| POST | `/auth/refresh` | rotate refresh token (family reuse detection → revoke family) |
| POST | `/auth/logout` | revoke current refresh token + session |
| POST | `/auth/magic-link` | reseller bot→web handoff: bot issues one-time token, this exchanges it for a session |
| GET | `/auth/me` | current user + roles + permission keys |
| POST | `/auth/password/change` · `/auth/password/reset-request` · `/auth/password/reset` | standard flows (Resend email) |

### 2.2 Catalog (admin/reseller scope; bot reads via core services + Redis cache)
| Method | Path | Permission |
|---|---|---|
| GET/POST | `/categories` · GET/PATCH/DELETE `/categories/:id` | `catalog.read` / `catalog.write` |
| GET/POST | `/products` · GET/PATCH/DELETE `/products/:id` | `catalog.*`; resellers see/write only own (`resellerId` forced from token) |
| POST | `/products/:id/submit` | reseller submits for approval |
| POST | `/products/:id/approve` · `/reject` | `catalog.approve` (admin) |
| GET/POST | `/products/:id/variants` · PATCH/DELETE `/variants/:id` | `catalog.write` |
| PUT | `/variants/:id/prices` | bulk upsert price rows (tier × currency) `pricing.write` |
| POST | `/media` (multipart → S3) · DELETE `/media/:id` | `media.write` |

### 2.3 Inventory (`/inventory`)
| Method | Path | Description |
|---|---|---|
| GET | `/inventory/keys?filter[variantId]=…&filter[status]=…` | list (values masked: `XXXX…-A9F2`); `inventory.read` |
| POST | `/inventory/keys` | single/bulk paste (array ≤ 5k) — dedup report returned |
| POST | `/inventory/keys/import` | CSV multipart → async job; returns `jobId` |
| GET | `/inventory/imports/:jobId` | progress: parsed/inserted/duplicates/errors + error CSV link |
| GET | `/inventory/keys/export` | CSV export (async, signed URL; `inventory.export`, audit-logged, values decrypted only with `inventory.reveal`) |
| PATCH | `/inventory/keys/bulk` | bulk status change (disable batch, extend expiry) |
| POST | `/inventory/keys/:id/reveal` | decrypt single key — requires `inventory.reveal`, always audit-logged |
| — | `/inventory/accounts…` | same surface for DigitalAccounts (+ `maxSlots`) |
| GET/POST | `/inventory/assets` | download assets (S3 multipart upload URLs) |
| GET | `/inventory/alerts` | low-stock & expiring inventory report |

Resellers use identical routes; row-level scoping restricts them to variants of their own products.

### 2.4 Orders & fulfillment (`/orders`)
| Method | Path | Description |
|---|---|---|
| GET | `/orders` | list; filters: status, userId, resellerId, date range, gateway; `orders.read` |
| GET | `/orders/:id` | full detail: items, payments, refunds, timeline (from AuditLog) |
| GET | `/orders/queue/manual` | pending-fulfillment queue with SLA timers |
| POST | `/orders/:id/items/:itemId/fulfill` | manual fulfillment: body = credentials payload or mediaId; encrypts, delivers via outbox, completes item; `orders.fulfill` |
| POST | `/orders/:id/cancel` | cancel unpaid order |
| POST | `/orders/:id/resend-delivery` | re-send delivery message (audit-logged) |
| GET | `/orders/:id/invoice` | signed PDF URL |

### 2.5 Payments & refunds
| Method | Path | Description |
|---|---|---|
| GET | `/payments` · GET `/payments/:id` | payment log, `payments.read` |
| GET | `/payments/providers` · PATCH `/payments/providers/:id` | enable/disable, currency routing, priority (`settings.write`) |
| POST | `/refunds` | create refund request `{orderId, amountMinor, destination, reason}` |
| POST | `/refunds/:id/approve` · `/reject` | `payments.refund` — approve triggers gateway refund or wallet credit |
| POST | `/webhooks/payments/:provider` | **public, raw body**; signature verified per provider; 200 fast, processing queued |
| POST | `/webhooks/telegram/:secret` | bot updates (secret path + Telegram secret-token header) |

### 2.6 Wallets (`/wallets`)
| Method | Path | Description |
|---|---|---|
| GET | `/wallets/:userId` · GET `/wallets/:userId/transactions` | `wallets.read` |
| POST | `/wallets/:userId/adjust` | manual credit/debit `{amountMinor, note}` — `wallets.adjust`, 2-person note required, audit-logged |
| GET | `/withdrawals?filter[status]=PENDING` | approval queue |
| POST | `/withdrawals/:id/approve` · `/reject` · `/mark-processed` | `wallets.withdraw.review` |

### 2.7 Customers & resellers
| Method | Path | Description |
|---|---|---|
| GET | `/users` · GET `/users/:id` | search by telegramId/email/name; profile includes LTV, orders, refund rate, referral stats |
| PATCH | `/users/:id/status` | suspend/ban (`users.moderate`) |
| POST | `/users/:id/roles` · DELETE `/users/:id/roles/:roleId` | `roles.assign` |
| GET/POST | `/resellers` · GET `/resellers/:id` | applications + profiles |
| POST | `/resellers/:id/verify` · `/suspend` | `resellers.manage` |
| GET | `/resellers/:id/commissions` · `/sales-report` | settlement views; resellers access own via `/me/…` aliases |

### 2.8 Promotions
| Method | Path | Description |
|---|---|---|
| GET/POST | `/coupons` · GET/PATCH/DELETE `/coupons/:id` | `coupons.*` |
| GET | `/coupons/:id/usages` | redemption log |
| POST | `/coupons/validate` | dry-run validation for a cart (used by bot preview too) |
| GET | `/referrals/stats` · GET `/referrals/rewards` | program dashboards; PATCH `/referrals/rewards/:id/withhold` |

### 2.9 Subscriptions
GET `/subscriptions` (filters: status, expiring ≤ N days) · GET `/subscriptions/:id` · POST `/subscriptions/:id/extend` `{days, reason}` · POST `/subscriptions/:id/cancel`.

### 2.10 Support
GET `/tickets` (queues by status/priority/assignee) · GET `/tickets/:id` · POST `/tickets/:id/messages` (relays to bot outbox) · PATCH `/tickets/:id` (assign, priority, status) · GET/POST `/canned-replies`.

### 2.11 Messaging
GET/POST `/broadcasts` · POST `/broadcasts/:id/schedule` · `/pause` · `/cancel` · GET `/broadcasts/:id/progress` (SSE) · GET `/broadcasts/segments/preview` (count for a segment query) · GET/PATCH `/templates/:key` (Telegram & email templates with placeholder linting).

### 2.12 Analytics & reports
GET `/analytics/overview?range=30d` (revenue, orders, AOV, delivery p95, refund rate — Redis-cached 5 min) · GET `/analytics/products` · `/analytics/resellers` · `/analytics/referrals` · POST `/reports` (async CSV/XLSX generation → signed URL) · GET `/reports/:id`.

### 2.13 Platform admin
GET/PATCH `/settings` (namespaced keys, `settings.write`) · GET `/audit-logs` (filter by actor/entity/action/date, `audit.read`) · GET/POST/DELETE `/api-keys` (`apikeys.manage`, secret shown once) · GET/POST `/roles` + PUT `/roles/:id/permissions` (`roles.manage`) · POST `/maintenance` `{enabled, message}` · GET `/health` (public liveness) · GET `/health/ready` · POST `/backups/trigger` + GET `/backups` (`platform.backup`).

## 3. Cross-cutting behavior

- **Rate limits** (Redis sliding window): auth 5/min/IP; webhooks unlimited (signature-gated); admin reads 300/min/user; mutations 60/min/user; API keys per-key configurable. 429 returns `Retry-After`.
- **RBAC enforcement:** `@RequirePermission('orders.refund')` guard on every route; resellers additionally pass row-level ownership checks in services (never rely on controller filtering alone).
- **Audit:** every mutating admin/reseller endpoint writes AuditLog (actor, action, before/after diff) via interceptor.
- **Versioning:** URI version (`/api/v1`); breaking changes → `/api/v2` with 6-month dual-running policy.
- **OpenAPI:** DTOs decorated; spec exported to `docs/api/openapi.json` in CI; drift check fails the build.
