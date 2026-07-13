# Development Setup

## Prerequisites

Node.js ≥ 22, pnpm ≥ 9 (`corepack enable`), Docker.

## Steps

```bash
git clone https://github.com/sshukla87384-source/gisbot.git && cd gisbot
pnpm install

# infra
docker compose -f infrastructure/docker/compose.dev.yml up -d

# env
cp .env.example .env
# set BOT_TOKEN (from @BotFather) and ENCRYPTION_MASTER_KEY (openssl rand -hex 32)

# database
pnpm db:generate        # prisma client
pnpm db:migrate         # creates schema (first run: name the migration "init")
pnpm db:seed            # RBAC, tiers, settings + demo catalog with 5 demo keys

# run the bot (long polling in dev)
pnpm dev:bot
```

## Try the full flow

1. Open your bot in Telegram → `/start`.
2. `/devtopup 100000` (dev-only command) → adds ₹1,000.00 to your wallet.
3. Shop → Windows 11 Pro Key → add to cart → Checkout → Pay from Wallet.
4. A demo license key is delivered instantly and appears in 🔑 My Licenses.

## Notes

- `BOT_MODE=webhook` + `WEBHOOK_DOMAIN`/`WEBHOOK_SECRET_PATH`/`TELEGRAM_SECRET_TOKEN` for production; polling is dev-only.
- Demo keys are fake (`DEMO…`) — replace with real inventory via the admin panel phase.
- Every checkout is a single DB transaction; test concurrency by running two chats against 1 remaining key — exactly one succeeds, the other gets "out of stock" and is not charged.
