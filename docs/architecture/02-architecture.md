# Get It Sasta — System Architecture

**Version:** 1.0 · **Phase 2** · Depends on: 01-prd.md

---

## 1. Topology (Hostinger VPS KVM 8, single node)

```
                        Internet
                           │
                    ┌──────▼──────┐
                    │   Nginx      │  TLS (Let's Encrypt), HTTP/2,
                    │ reverse proxy│  rate limiting, gzip/brotli
                    └──┬───┬───┬──┘
        /api/v1/*      │   │   │      /admin (static+SSR)
     /webhooks/*  ┌────▼┐ ┌▼───────┐ ┌▼───────────┐
                  │ API  │ │ Bot    │ │ Admin Panel│
                  │NestJS│ │ worker │ │ Next.js    │
                  │ x2   │ │(grammY)│ │ (node)     │
                  └─┬──┬─┘ └─┬──┬───┘ └─────┬──────┘
                    │  │     │  │           │
              ┌─────▼──▼─────▼──▼───────────▼────┐
              │  PostgreSQL 16      Redis 7      │
              │  (Prisma)           cache+BullMQ │
              └───────────────┬─────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │ Queue workers x2  │  fulfillment, notifications,
                    │ (NestJS BullMQ)   │  broadcasts, imports, reports
                    └───────────────────┘
     External: S3-compatible storage (Cloudflare R2 or Hostinger Object
     Storage), Resend, Razorpay/Stripe/PayPal, Telegram Bot API
```

All services run as Docker Compose services on one VPS. Resource budget (32 GB): Postgres 8 GB, Redis 2 GB, API ×2 ≈ 2 GB, bot 1 GB, workers ×2 ≈ 2 GB, admin 1 GB, Nginx + OS headroom for the rest.

## 2. Monorepo

```
get-it-sasta/
├─ apps/
│  ├─ api/            # NestJS REST API (admin + reseller + internal)
│  ├─ telegram-bot/   # grammY on webhooks; thin — calls services from packages
│  ├─ worker/         # BullMQ processors (fulfillment, outbox, broadcasts, cron)
│  └─ admin-panel/    # Next.js 14 + Tailwind + shadcn/ui
├─ packages/
│  ├─ database/       # Prisma schema, client, migrations, seeds
│  ├─ core/           # domain services (orders, wallet, inventory, coupons…)
│  ├─ payments/       # PaymentProvider interface + gateway adapters
│  ├─ shared/         # DTOs, Zod schemas, constants, error types
│  ├─ auth/           # JWT, RBAC guards, crypto helpers
│  ├─ config/         # typed env loading (zod-validated)
│  └─ ui/             # shared shadcn components for admin panel
├─ infrastructure/
│  ├─ docker/         # Dockerfiles, compose.prod.yml, compose.dev.yml
│  ├─ nginx/          # site configs, rate-limit zones
│  └─ scripts/        # backup.sh, restore.sh, deploy.sh, healthcheck.sh
└─ docs/
```

Tooling: pnpm workspaces + Turborepo, strict TS, ESLint, Prettier, Husky, Conventional Commits, changesets optional.

**Key principle:** business logic lives in `packages/core` (framework-agnostic services using the repository pattern over Prisma). `api`, `telegram-bot`, and `worker` are delivery mechanisms that inject the same services — one checkout implementation, three entry points. This is Clean Architecture applied pragmatically: domain services + repositories, without ceremony that slows a small team.

## 3. Request/Event Flows

### 3.1 Telegram updates
Telegram → Nginx `/webhooks/telegram/<secret-path>` → bot app (verifies `X-Telegram-Bot-Api-Secret-Token`) → grammY router → handler calls core services → replies. Long-running work (checkout, imports) is enqueued; the handler answers callback queries immediately (< 1 s) to avoid Telegram retries.

### 3.2 Payment webhooks (critical path)
Gateway → Nginx `/webhooks/payments/:provider` → API: verify signature → persist raw event (WebhookEvent table, unique on provider+eventId → idempotency) → enqueue `fulfillment` job → 200 OK fast (< 500 ms). Worker executes the fulfillment transaction (PRD §6.1) and enqueues delivery messages to the Telegram outbox queue.

### 3.3 Telegram outbox
All outbound bot messages (deliveries, notifications, broadcasts) flow through one BullMQ queue with a token-bucket limiter (default 25 msg/s global, 1 msg/s per chat) and retry with exponential backoff on 429s. Guarantees ordering per chat and respects Telegram limits under broadcast load.

### 3.4 Queues (BullMQ)
| Queue | Jobs | Concurrency |
|---|---|---|
| `fulfillment` | assign inventory, invoices | 10, per-order idempotent |
| `outbox` | Telegram sends | rate-limited |
| `email` | Resend sends | 5 |
| `broadcast` | fan-out segmentation → outbox | 1 fan-out, chunked |
| `inventory` | CSV import/export, duplicate scan | 2 |
| `cron` | reservation expiry, subscription reminders, low-stock alerts, wallet reconciliation, FX refresh, backup trigger, commission release | scheduled |
| `reports` | heavy analytics materialization | 1 |

### 3.5 Caching (Redis)
- Catalog: category tree, product cards, price lists — cache-aside, TTL 60 s + explicit invalidation on admin edits.
- Session/conversation state for bot (key `bot:sess:<chatId>`, TTL 24 h).
- Rate-limit counters, idempotency locks, reservation TTL keys.
- Never cache: wallet balances, inventory counts used for checkout decisions (always DB, transactional).

## 4. Payment Provider Abstraction

```ts
interface PaymentProvider {
  readonly id: 'razorpay' | 'stripe' | 'paypal' | 'telegram_stars' | 'wallet';
  readonly currencies: Currency[];
  createCheckout(order: OrderContext): Promise<CheckoutSession>; // url or Stars invoice
  verifyWebhook(raw: Buffer, headers: Headers): VerifiedEvent | null;
  parseEvent(e: VerifiedEvent): PaymentEvent; // normalized: succeeded|failed|refunded
  refund(paymentId: string, amount: Money): Promise<RefundResult>;
  healthCheck(): Promise<boolean>;
}
```

Providers register in a `PaymentRegistry`; enable/disable and priority per currency are DB settings (admin panel toggles), no deploy needed. Business logic consumes only normalized `PaymentEvent`s.

## 5. Trade-offs (explicit)

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Bot library | grammY | Telegraf | Better TS types, actively maintained, built-in webhook + rate-limit plugins |
| Bot mode | Webhooks | Long polling | Required at scale; polling kept as dev-mode fallback |
| Queue | BullMQ/Redis | RabbitMQ/Kafka | Already need Redis; ops burden of a broker not justified at this volume |
| Money | Integer minor units (paise/cents) + currency code | Decimal/float | Eliminates rounding bugs; Prisma `Int`/`BigInt` |
| Wallet | Append-only ledger | Mutable balance | Auditability, reconciliation, dispute resolution |
| Inventory locking | `FOR UPDATE SKIP LOCKED` | Redis locks | DB is source of truth; survives Redis restart; SKIP LOCKED gives throughput |
| Multi-currency | Explicit price rows per currency | Runtime FX | Predictable pricing, gateway settlement matches displayed price |
| Deployment | Docker Compose on one VPS | k8s | Team size and node count don't justify k8s; compose file is portable |
| API style | REST + OpenAPI | GraphQL | Simpler caching, tooling, and webhook ecosystem |
| Admin auth | Separate JWT audience + short TTL + CSRF | Shared session | Isolates the highest-privilege surface |

## 6. Observability & Ops

- **Logging:** pino JSON logs → Docker json-file with rotation → optional Loki later. Request IDs propagate API→queue→bot. Credentials/keys are redacted by a serializer allowlist.
- **Metrics:** Prometheus endpoints (`/metrics`) on api/worker/bot; node exporter + postgres exporter; Grafana dashboard (compose profile `monitoring`). Alerts via a Telegram admin channel (delivery latency, queue depth, failed webhooks, low stock, disk > 80%).
- **Health checks:** `/health` (liveness) and `/health/ready` (DB+Redis+S3 ping) per service; Docker healthchecks gate restarts; external uptime monitor (e.g., UptimeRobot) on the public endpoints.
- **Backups:** `pgbackrest` or `wal-g` → S3 bucket (separate credentials, versioned, different provider than the VPS): continuous WAL + nightly full. Redis RDB nightly (cache is rebuildable; queues drain on restart via BullMQ persistence in Redis AOF). Weekly restore drill script.
- **Deploys:** GitHub Actions → build images → push GHCR → SSH deploy script pulls + `docker compose up -d` with health-gated rollout; Prisma migrations run as a one-shot job before app switch. Rollback = previous image tag.

## 7. Scale-out path (when KVM 8 saturates)

1. Move Postgres to managed (or second VPS) — biggest single win.
2. Add a second app VPS behind Hostinger/Cloudflare load balancing; Nginx config already stateless (JWT, Redis sessions).
3. Split worker onto its own node; add read replica for analytics.
4. Only then consider k8s/ECS. Nothing in the codebase assumes single-node (no local file state; S3 for media; Redis for shared state).

## 8. Capacity sanity check

Thousands of orders/day ≈ < 1 order/s peak-avg; even 20× spikes (20 checkouts/s) are far below Postgres/Redis limits on this hardware. The real constraints are Telegram send throughput (handled by outbox throttling) and broadcast fan-out to 100k users (~70 min at 25 msg/s — acceptable; chunked and resumable).
