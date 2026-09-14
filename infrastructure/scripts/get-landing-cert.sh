#!/usr/bin/env bash
# One-time: obtain the TLS certificate for the landing page (root + www).
# Requires DNS A records for  @  and  www  pointing to this server, and the
# stack already running (nginx serves the ACME challenge over :80).
set -euo pipefail
cd "$(dirname "$0")/../.."
# `grep ... | cut ...` reports CUT's status, so a missing key silently yielded an
# EMPTY value and the `|| echo <fallback>` could never fire.
env_value() {
  local v
  v="$(grep -E "^$1=" .env | head -n1 | cut -d= -f2- || true)"
  v="${v%%#*}"                      # drop any inline comment
  v="${v//[[:space:]]/}"
  v="${v//\"/}"; v="${v//\'/}"
  printf '%s' "$v"
}

NGINX_DOMAIN="$(env_value NGINX_DOMAIN)"
[ -n "$NGINX_DOMAIN" ] || { echo "ERROR: set NGINX_DOMAIN in .env"; exit 1; }
EMAIL="$(env_value SEED_ADMIN_EMAIL)"
[ -n "$EMAIL" ] || EMAIL="admin@${NGINX_DOMAIN}"
COMPOSE="docker compose --env-file .env -f infrastructure/docker/compose.prod.yml"

echo "==> Requesting certificate for ${NGINX_DOMAIN} and www.${NGINX_DOMAIN}"
$COMPOSE run --rm --entrypoint certbot certbot certonly --webroot -w /var/www/certbot \
  -d "${NGINX_DOMAIN}" -d "www.${NGINX_DOMAIN}" \
  --email "${EMAIL}" --agree-tos --no-eff-email

echo "==> Cert obtained. Re-running deploy to enable HTTPS on the landing page."
./infrastructure/scripts/deploy.sh "${1:-}"
