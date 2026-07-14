#!/usr/bin/env bash
# One-time: obtain the TLS certificate for the landing page (root + www).
# Requires DNS A records for  @  and  www  pointing to this server, and the
# stack already running (nginx serves the ACME challenge over :80).
set -euo pipefail
cd "$(dirname "$0")/../.."
NGINX_DOMAIN="$(grep -E '^NGINX_DOMAIN=' .env | cut -d= -f2-)"
EMAIL="$(grep -E '^SEED_ADMIN_EMAIL=' .env | cut -d= -f2- || echo admin@"$NGINX_DOMAIN")"
COMPOSE="docker compose --env-file .env -f infrastructure/docker/compose.prod.yml"

echo "==> Requesting certificate for ${NGINX_DOMAIN} and www.${NGINX_DOMAIN}"
$COMPOSE run --rm --entrypoint certbot certbot certonly --webroot -w /var/www/certbot \
  -d "${NGINX_DOMAIN}" -d "www.${NGINX_DOMAIN}" \
  --email "${EMAIL}" --agree-tos --no-eff-email

echo "==> Cert obtained. Re-running deploy to enable HTTPS on the landing page."
./infrastructure/scripts/deploy.sh "${1:-}"
