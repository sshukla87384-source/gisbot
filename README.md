# Get It Sasta — Telegram Digital Products Marketplace

Enterprise-grade Telegram-based marketplace for digital products (license keys, digital accounts, subscriptions, downloads) with an admin panel and a full reseller marketplace program.

## Status

**Design (Phases 1–6):** complete — see [`docs/`](./docs).
**Implemented:** Telegram bot with catalog/cart/wallet + transactional wallet checkout and instant license delivery (Phase 7); production deployment for Hostinger VPS KVM 8 — Docker images, hardened compose stack, nginx+TLS, CI, encrypted off-site backups, runbook ([`docs/deployment/production.md`](./docs/deployment/production.md)).
**Implemented:** admin/reseller REST API (NestJS) — JWT auth with refresh-token rotation, RBAC, catalog/inventory/orders/users/wallets/coupons/tickets/settings/audit/analytics, Swagger.
**In progress (parked in [`wip/`](./wip)):** admin panel UI. **Next:** payment gateways (Razorpay/Stripe), fulfillment worker, reseller flows.

## Stack

TypeScript · NestJS · grammY · PostgreSQL + Prisma · Redis + BullMQ · Next.js + Tailwind + shadcn/ui · Docker Compose (Hostinger VPS KVM 8)

## Documentation

| Doc | Path |
|---|---|
| PRD | `docs/01-prd.md` |
| System architecture | `docs/architecture/02-architecture.md` |
| Telegram bot UX | `docs/03-telegram-bot-ux.md` |
| Database design | `docs/architecture/04-database-schema.md` |
| Prisma schema | `packages/database/prisma/schema.prisma` |
| API specification | `docs/api/05-api-spec.md` |
| Security architecture | `docs/architecture/06-security.md` |

## Monorepo layout

```
apps/          api · telegram-bot · worker · admin-panel
packages/      database · core · payments · shared · auth · config · ui
infrastructure/ docker · nginx · scripts
docs/          architecture · api · deployment
```
