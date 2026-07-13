# Get It Sasta — Database Schema Design

**Version:** 1.0 · **Phase 4** · Full schema: [`schema.prisma`](./schema.prisma) (validated against Prisma 5.22 schema engine)

---

## 1. Design principles

- **Money = integer minor units** (`amountMinor` paise/cents) + `Currency` enum. `BigInt` for accumulating balances, `Int` for per-line amounts. No floats anywhere near money.
- **Ledger over mutable state.** `WalletTransaction` is append-only with `balanceAfterMinor`; `Wallet.balanceMinor` is a cache reconciled by a cron job. Commission accounting (`CommissionEntry`) and referral rewards are separate auditable tables with hold/release timestamps.
- **Snapshots on order lines.** `OrderItem` stores `productNameSnap`, `variantNameSnap`, `unitPriceMinor`, `resellerIdSnap` — an order remains historically accurate after catalog edits or reseller removal.
- **Encrypted-at-rest columns** carry the `Encrypted` suffix (`keyEncrypted`, `passwordEncrypted`, `deliveryPayloadEncrypted`, `totpSecretEncrypted`). Encryption is app-layer AES-256-GCM (see Security doc §4); DB never sees plaintext.
- **Soft deletes** (`deletedAt`) on catalog, users, inventory, coupons, media. Financial records (orders, payments, transactions, audit logs) are never deleted.
- **Idempotency keys** as unique columns: `Payment.idempotencyKey`, `WalletTransaction.idempotencyKey`, `WebhookEvent @@unique([provider, eventId])` — duplicate webhooks/retries become no-ops at the constraint level, not just in code.

## 2. Entity map (domains)

| Domain | Models |
|---|---|
| Identity & Access | User, Role, Permission, RolePermission, UserRole, RefreshToken, Session, ApiKey |
| Reseller | ResellerProfile, PriceTier, CommissionEntry |
| Catalog | Category, Product, ProductVariant, VariantPrice, Media |
| Inventory | LicenseKey, DigitalAccount, AccountAssignment, DownloadAsset, DownloadGrant |
| Commerce | Cart, CartItem, Order, OrderItem, Invoice |
| Payments | Payment, WebhookEvent, Refund |
| Wallet | Wallet, WalletTransaction, WithdrawalRequest |
| Promotions | Coupon, CouponUsage, ReferralReward |
| Subscriptions | Subscription |
| Support | SupportTicket, TicketMessage, CannedReply |
| Messaging | Notification, Broadcast, MessageTemplate |
| Platform | AuditLog, ActivityLog, Setting, FxRate, ReportJob |

## 3. Key modeling decisions

### 3.1 Pricing: tiers × currencies
`VariantPrice` is unique on `(variantId, tierId, currency)`. Tiers (`RETAIL`, `RESELLER_L1`, …) implement wholesale pricing without conditional logic — checkout resolves the buyer's tier and currency to exactly one price row. No runtime FX for charging (PRD §6.2); `FxRate` exists only for display approximation.

### 3.2 Inventory & zero-duplicate-delivery
- `LicenseKey` and `DigitalAccount` each have `status + reservedUntil`. Reservation = status `RESERVED` + TTL; a cron sweep returns expired reservations to `AVAILABLE`.
- Assignment happens inside a transaction using `SELECT … FOR UPDATE SKIP LOCKED` on `(variantId, status='AVAILABLE')` — concurrent checkouts each grab distinct rows without lock contention.
- **Hard guarantee:** `LicenseKey.orderItemId` and `AccountAssignment.orderItemId` are `@unique` — the database itself makes double-delivery of the same order item impossible, even if application logic regresses.
- Duplicate import detection: `@@unique([variantId, keyHash])` where `keyHash = sha256(normalized key)` — works without decrypting existing rows.
- Shared accounts: `DigitalAccount.maxSlots/usedSlots` + `AccountAssignment` rows per sold slot.

### 3.3 Marketplace attribution
`Product.resellerId` (null = platform-owned) with approval fields; `OrderItem.resellerIdSnap` snapshots the seller; `CommissionEntry` (1:1 with OrderItem) records gross/commission/net with `holdUntil` → release job credits reseller wallet (`COMMISSION` tx) after the hold; `clawedBackAt` supports dispute reversals.

### 3.4 Orders & payments
`Order 1—N Payment` (retries, split wallet+gateway), `Order 1—N Refund` (partial refunds), `Order 1—1 Invoice`. `Payment @@unique([provider, providerRef])` prevents double-recording a gateway payment. `Order.walletUsedMinor` + `totalMinor` model mixed wallet/gateway checkout.

### 3.5 Referral integrity
Attribution lives on `User.referredById` (immutable first-touch). `ReferralReward` is per-order, unique on `orderId`, with `PENDING_HOLD → CREDITED/WITHHELD` lifecycle matching the 48 h anti-fraud hold.

### 3.6 RBAC
Role → Permission is many-to-many with string permission keys (`orders.refund`, `inventory.import`). Guards check permission keys, not role names, so custom admin roles need no code changes. `isSystem` roles are undeletable.

## 4. Indexing strategy (beyond FKs and uniques)

| Index | Serves |
|---|---|
| `LicenseKey/DigitalAccount (variantId, status)` | stock counts, assignment scans |
| `(status, reservedUntil)` on inventory | reservation-expiry sweeps |
| `Order (userId, createdAt)` / `(status, createdAt)` / `(status, expiresAt)` | user history, admin queues, payment-window expiry |
| `WalletTransaction (walletId, createdAt)` | ledger pagination |
| `Subscription (status, expiresAt)` | reminder/expiry crons |
| `CommissionEntry (holdUntil, releasedAt)` | commission release cron |
| `AuditLog (entityType, entityId)` | per-record audit trail |
| `SupportTicket (assigneeId, status)` / `(status, priority)` | agent queues |

Post-launch: pg_trgm GIN index on `Product.name` for bot fuzzy search; `AuditLog`/`ActivityLog`/`WebhookEvent` become monthly-partitioned tables once they exceed ~10 M rows.

## 5. Integrity rules enforced in service layer (documented invariants)

Some invariants are cross-row and enforced transactionally in `packages/core` (with tests) rather than by constraints: wallet balance ≥ 0 (except admin ADJUSTMENT), `usedSlots ≤ maxSlots`, coupon `usedCount ≤ usageLimit` (checked with row lock at redemption), one AVAILABLE→RESERVED→SOLD monotonic status flow, reseller may only upload inventory to variants of own products.

## 6. Migrations & seeds

Prisma Migrate with linear migration history; every deploy runs `prisma migrate deploy` as a pre-start job. Seed script creates: system roles + permission catalog, super admin (from env), price tiers, default settings, message templates, demo catalog (dev only).
