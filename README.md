# Get It Sasta — Telegram Digital Products Marketplace

Enterprise-grade Telegram-based marketplace for digital products (license keys, digital accounts, subscriptions, downloads) with an admin panel and a full reseller marketplace program.

## Status

**Phases 1–6 complete (design):** PRD, system architecture, bot UX, database schema, API spec, security architecture — see [`docs/`](./docs). Implementation (Phases 7–18) pending approval.

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
