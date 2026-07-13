# Get It Sasta — Authentication & Security Architecture

**Version:** 1.0 · **Phase 6**

---

## 1. Identity & Authentication

### 1.1 Customer identity (Telegram)
Telegram `telegramId` is the primary identity — validated implicitly because updates arrive on a secret webhook path AND carry the `X-Telegram-Bot-Api-Secret-Token` header (set at `setWebhook`). No password. Optional email added for invoices (verified via Resend magic link).

### 1.2 Web panel identity (admins & resellers)
- **Passwords:** argon2id (memory 64 MB, iterations 3, parallelism 4), per-user salt, pepper from env. Breach-list check (zxcvbn + local top-100k list) at set time.
- **Access token:** JWT RS256 (asymmetric — API verifies with public key only), TTL 15 min, claims: `sub`, `aud` (`admin`|`portal`), `roles`, `permVer` (permission version — bumping it invalidates cached permissions instantly), `jti`.
- **Refresh token:** opaque 256-bit random, stored as SHA-256 hash, TTL 30 d, httpOnly+Secure+SameSite=Strict cookie scoped to `/api/v1/auth`. **Rotation with family reuse detection:** every refresh issues a new token in the same `familyId`; presenting a superseded token revokes the entire family and alerts the user (classic token-theft tripwire).
- **2FA:** TOTP (RFC 6238), secret encrypted at rest; **mandatory for all admin roles**, optional for resellers. Recovery codes (10, argon2-hashed, single-use). Architecture leaves room for WebAuthn later.
- **Bot→web handoff (resellers):** bot generates one-time 5-min token (Redis, single use) → magic link opens panel already authenticated. No password typed inside Telegram.
- **Sessions:** Session table rows per login; "active sessions" screen with per-session revoke; revocation checked via Redis denylist of `jti` (TTL = token remaining lifetime).

### 1.3 API keys (integrations)
256-bit random, shown once, stored hashed, `gis_live_`/`gis_test_` prefixes for secret scanning, scoped permissions, expiry, per-key rate limits, last-used tracking, instant revocation.

## 2. Authorization (RBAC)

- Permission keys (`orders.refund`, `inventory.reveal`, …) grouped by domain; roles are named permission sets. System roles: SUPER_ADMIN, ADMIN, SUPPORT, FINANCE, RESELLER, CUSTOMER; custom roles composable in panel.
- Enforced at three layers: route guard (`@RequirePermission`), service-level ownership checks (resellers → own rows only; customers → own orders/wallet only), and DB constraints where possible.
- Privilege escalation controls: only SUPER_ADMIN edits roles; role changes are audit-logged and terminate the target's sessions; SUPER_ADMIN actions require fresh auth (< 15 min) for destructive operations (refund approval over threshold, backup restore, role grants).

## 3. Input & Transport Security

| Vector | Control |
|---|---|
| Injection | Prisma parameterized queries only; no raw SQL without review; Zod validation on every boundary (API DTOs, bot callback data, CSV rows, webhook payloads) |
| XSS (panel) | React auto-escaping; CSP `default-src 'self'` + nonce'd scripts, no `unsafe-inline`; DOMPurify for the one rich-text field (broadcast composer) |
| CSRF | SameSite=Strict cookies + double-submit CSRF token on mutations; Origin header check |
| Headers | Helmet: HSTS (preload), X-Content-Type-Options, Referrer-Policy, frame-ancestors 'none' |
| TLS | TLS 1.2+, Let's Encrypt auto-renew, Nginx redirects, OCSP stapling |
| Uploads | Content-type + magic-byte sniffing, size caps, images re-encoded (sharp), CSVs parsed in worker sandbox, S3 objects private-only |
| Telegram callback spoofing | All callback data Zod-parsed; IDs re-authorized against the acting user server-side (never trust IDs in callback payload) |
| SSRF | No user-supplied URLs fetched server-side (v1 has none); outbound allowlist in Nginx/egress if added later |

## 4. Secrets & Data Protection

- **App-layer encryption:** AES-256-GCM with random 96-bit nonce per value; format `v1:keyId:nonce:ciphertext:tag` — `keyId` enables zero-downtime key rotation (re-encrypt job walks tables). Applied to: license keys, account credentials, TOTP secrets, delivery payloads, withdrawal destinations.
- **Key management:** master key in env (KVM 8 constraint), file permissions 600, never in git; documented migration path to KMS/Vault. Separate keys for credentials vs tokens pepper.
- **Decryption discipline:** plaintext exists only in memory at delivery/reveal time; `inventory.reveal` permission required for admin viewing, every reveal audit-logged; log serializers redact by allowlist (no `*Encrypted`, `password`, `token` fields ever logged).
- **Env management:** `.env.production` on server (600, root-owned, docker secrets mounts), `packages/config` refuses to boot with missing/malformed vars (Zod).
- **PII:** minimal by design (telegramId, optional email, first/last name). Right-to-erasure: soft-delete + PII column scrubbing job that preserves financial ledger integrity.

## 5. Payment & Delivery Integrity

- **Webhook verification per provider:** Razorpay HMAC-SHA256 of raw body; Stripe `Stripe-Signature` with timestamp tolerance 5 min (replay protection); PayPal cert verification API; Telegram Stars via bot API pre_checkout + successful_payment inside signed update. Raw-body preserved (Nest `rawBody: true` on webhook routes).
- **Idempotency:** DB unique `(provider, eventId)` → duplicate events no-op; fulfillment job keyed by orderId → BullMQ jobId dedupe; wallet transactions carry idempotency keys.
- **Amount verification:** webhook amount+currency must equal order totals — mismatch → order flagged `MANUAL_REVIEW`, not fulfilled.
- **Inventory integrity:** `FOR UPDATE SKIP LOCKED` assignment inside the fulfillment transaction; unique `orderItemId` FKs make duplicate delivery impossible at the constraint level (schema doc §3.2).
- **Signed downloads:** S3 presigned GETs, TTL ≤ 24 h, download counter checked server-side before issuing each URL; asset keys unguessable (cuid + random suffix).

## 6. Abuse Prevention

- **Rate limiting:** Nginx zone (burst absorb) + Redis sliding windows per route class (API spec §3). Bot: per-user token bucket 20 interactions/10 s → warn → 10-min mute (logged).
- **Fraud signals:** refund-rate anomaly flags, referral abuse checks (self-referral, shared payment instrument, burst-registration graph), velocity limits on wallet deposits, disposable-email blocklist for reseller signup, new-account purchase caps (configurable).
- **Reseller trust:** approval gate, delivery-failure auto-suspension, commission hold, clawback (PRD §6.6).

## 7. Auditing & Monitoring

- AuditLog on every privileged mutation (actor, action, entity, before/after, IP, UA). Append-only (no UPDATE/DELETE grants for app role on that table).
- Security telemetry → admin Telegram channel: failed-login bursts, refresh-token reuse, webhook signature failures, reveal-endpoint usage, wallet adjustments, maintenance toggles.
- Weekly `pnpm audit` + Dependabot + Trivy image scan in CI (build fails on high/critical CVEs with allowlist file for accepted risks).

## 8. Backups & Disaster Recovery

- **Postgres:** WAL archiving (wal-g) to versioned S3 bucket on a *different provider* than the VPS, credentials write-only from server; nightly full base backup; retention 30 d. **RPO ≤ 15 min, RTO ≤ 2 h.**
- **Redis:** AOF everysec (BullMQ durability) + nightly RDB to S3. Cache loss is acceptable; queue loss is not.
- **S3 media:** bucket versioning + lifecycle rules.
- **DR runbook** (docs/deployment): provision fresh VPS → restore script (compose files in git, images in GHCR, `wal-g` restore, env from secure vault/password manager) → repoint DNS. Restore drill scripted and scheduled monthly; drill result posted to admin channel.
- Backup encryption: client-side (age/GPG) before upload; keys stored offline.

## 9. OWASP Top 10 mapping (summary)

A01 Broken Access Control → 3-layer RBAC + row-level checks + tests per permission · A02 Crypto Failures → argon2id, AES-GCM, TLS, hashed tokens · A03 Injection → Prisma + Zod everywhere · A04 Insecure Design → this document, threat-modeled flows, holds/limits · A05 Misconfig → Helmet/CSP, hardened compose (no-new-privileges, read-only FS where possible, non-root users), UFW allow 80/443/SSH-key-only · A06 Vulnerable Components → CI scanning · A07 AuthN Failures → rate limits, 2FA, rotation, reuse detection · A08 Integrity Failures → signed webhooks, lockfile, pinned image digests, CI provenance · A09 Logging Failures → structured audit + alerts · A10 SSRF → no user-driven fetches, egress discipline.

## 10. Residual risks (explicit)

Single-node hosting means a VPS compromise exposes the master encryption key (mitigation: strict SSH hardening, fail2ban, minimal attack surface, fast key-rotation runbook, KMS migration path). Telegram account takeover of a customer = access to their vault (mitigation: re-deliveries masked by default, sensitive re-sends require inline confirmation, admins can freeze accounts).
