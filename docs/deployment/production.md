# Production Deployment — Hostinger VPS KVM 8

Target: single Hostinger **KVM 8** VPS (8 vCPU / 32 GB RAM / 400 GB NVMe), Ubuntu 24.04, Docker Compose. Resource budget: Postgres 8 GB, Redis 3 GB, apps ~1 GB each, generous OS headroom (Architecture doc §1).

Current deployable scope: **bot + postgres + redis + nginx/certbot + migrate** (default compose profile). `api`, `worker`, `admin` services are defined behind `--profile full` and activate as those apps ship — no compose changes needed later.

## 1. Buy & provision the VPS

1. hpanel → VPS → choose **KVM 8**, Ubuntu 24.04 LTS, datacenter nearest your customers (India → Mumbai if offered).
2. Add your SSH public key during provisioning (hpanel → VPS → Settings → SSH keys).
3. Note the public IPv4.

## 2. DNS

At your DNS provider create A records → VPS IP:

| Record | Purpose |
|---|---|
| `api.yourdomain.com` | Telegram + payment webhooks, REST API |
| `admin.yourdomain.com` | Admin panel (activates with `full` profile) |

## 3. Server hardening (once)

```bash
ssh root@<VPS_IP>
apt update && apt -y upgrade
adduser deploy && usermod -aG sudo deploy
rsync -a ~/.ssh /home/deploy/ && chown -R deploy:deploy /home/deploy/.ssh

# SSH: keys only
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/;s/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart ssh

# Firewall + fail2ban + auto security updates
apt -y install ufw fail2ban unattended-upgrades age awscli
ufw default deny incoming && ufw default allow outgoing
ufw allow 22,80,443/tcp && ufw enable
dpkg-reconfigure -plow unattended-upgrades
```

## 4. Docker

```bash
su - deploy
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker deploy && exit   # re-login to pick up the group
```

## 5. Clone + configure

```bash
sudo mkdir -p /opt/gisbot && sudo chown deploy:deploy /opt/gisbot
git clone https://github.com/sshukla87384-source/gisbot.git /opt/gisbot
cd /opt/gisbot && cp .env.example .env && chmod 600 .env
```

Edit `.env` — production values checklist:

| Var | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `postgresql://gis:<POSTGRES_PASSWORD>@postgres:5432/gis` (service name `postgres`, not localhost) |
| `REDIS_URL` | `redis://redis:6379` |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` (also add `POSTGRES_USER=gis`, `POSTGRES_DB=gis`) |
| `BOT_TOKEN` | from @BotFather |
| `BOT_MODE` | `webhook` |
| `WEBHOOK_DOMAIN` | `https://api.yourdomain.com` |
| `WEBHOOK_SECRET_PATH` | `openssl rand -hex 24` |
| `TELEGRAM_SECRET_TOKEN` | `openssl rand -hex 24` |
| `ENCRYPTION_MASTER_KEY` | `openssl rand -hex 32` — **back this up offline; losing it = losing all encrypted inventory** |
| `JWT_SECRET` | `openssl rand -hex 32` |
| `SEED_ADMIN_EMAIL/PASSWORD` | your panel login (used when the API ships) |
| `NGINX_DOMAIN` | `yourdomain.com` (deploy.sh renders nginx config from it) |
| `ADMIN_ALERT_CHAT_ID` | Telegram chat id of your admin group (optional) |
| Backups | `BACKUP_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL` (any S3-compatible bucket on a **different provider**), `BACKUP_AGE_RECIPIENT` (`age-keygen` — keep the identity offline) |
| Gateways | leave `RAZORPAY_*` / `STRIPE_*` empty until the payments phase |

## 6. TLS bootstrap (once, before first full start)

```bash
cd /opt/gisbot
docker compose --env-file .env -f infrastructure/docker/compose.prod.yml up -d nginx || true
docker compose --env-file .env -f infrastructure/docker/compose.prod.yml run --rm \
  --entrypoint certbot certbot certonly --webroot -w /var/www/certbot \
  -d api.yourdomain.com -d admin.yourdomain.com \
  --email you@example.com --agree-tos --no-eff-email
```

(If nginx refuses to start before certs exist, run certbot in standalone mode first: stop nginx, `--standalone -p 80:80`.) Renewal afterwards is automatic (certbot container loop + nginx reload loop).

## 7. First deploy

```bash
cd /opt/gisbot
./infrastructure/scripts/deploy.sh
```

This renders nginx config, builds images, runs `prisma migrate deploy` + seed as a one-shot `migrate` service, starts the stack, and waits for bot health. The bot registers its own webhook at boot (`WEBHOOK_DOMAIN` + secret path + secret token).

Verify:

```bash
curl -s https://api.yourdomain.com/health          # {"status":"ok"}
docker compose --env-file .env -f infrastructure/docker/compose.prod.yml ps
# In Telegram: /start your bot
```

## 8. Cron jobs

```bash
crontab -e
10 2 * * *  cd /opt/gisbot && ./infrastructure/scripts/backup.sh >> /var/log/gis-backup.log 2>&1
*/5 * * * * cd /opt/gisbot && ./infrastructure/scripts/healthcheck.sh >/dev/null 2>&1
```

Run a **restore drill monthly**: `./infrastructure/scripts/restore.sh <latest-file>` against a scratch database or a temporary VPS (Security doc §8: RPO ≤ 15 min target ultimately needs WAL archiving — pg_dump nightly is the v1 baseline, upgrade to wal-g when order volume justifies it).

## 9. Updates & rollback

```bash
# update
cd /opt/gisbot && ./infrastructure/scripts/deploy.sh          # or `deploy.sh full` once api/worker/admin ship

# rollback
git log --oneline -5
git checkout <last-good-sha> && ./infrastructure/scripts/deploy.sh
```

Migrations are forward-only; rolling back code past a migration requires restoring the DB backup taken before the deploy (take one manually before risky releases: `./infrastructure/scripts/backup.sh`).

## 10. Enabling the full stack later

When `apps/api`, `apps/worker`, `apps/admin-panel` land: set `PUBLIC_API_URL=https://api.yourdomain.com`, `ADMIN_PANEL_ORIGIN=https://admin.yourdomain.com`, `NEXT_PUBLIC_API_URL=https://api.yourdomain.com`, gateway secrets, then `./infrastructure/scripts/deploy.sh full`. Nginx already routes api/admin hosts (runtime DNS — no config change).

## 11. When KVM 8 is not enough

See Architecture doc §7: move Postgres out first, then add an app node. Nothing in the stack assumes single-node except this compose file.
