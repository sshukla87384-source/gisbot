#!/usr/bin/env bash
# One-time: put the web shop on its own domain (e.g. mystore.com).
#   1. DNS: an A record for  @  (and  www ) of that domain → this server's IP.
#   2. .env: SHOP_DOMAIN=mystore.com
#   3. Run:  ./infrastructure/scripts/get-shop-cert.sh full
# It gets the TLS certificate and re-deploys with the shop's nginx block on.
set -euo pipefail
cd "$(dirname "$0")/../.."
env_value() {
  local v
  v="$(grep -E "^$1=" .env | head -n1 | cut -d= -f2- || true)"
  v="${v%%#*}"; v="${v//[[:space:]]/}"; v="${v//\"/}"; v="${v//\'/}"
  printf '%s' "$v"
}
SHOP_DOMAIN="$(env_value SHOP_DOMAIN)"
SHOP_DOMAIN="${SHOP_DOMAIN#https://}"; SHOP_DOMAIN="${SHOP_DOMAIN#http://}"; SHOP_DOMAIN="${SHOP_DOMAIN%%/*}"
[ -n "$SHOP_DOMAIN" ] || { echo "ERROR: set SHOP_DOMAIN=yourdomain.com in .env first"; exit 1; }
NGINX_DOMAIN="$(env_value NGINX_DOMAIN)"
EMAIL="$(env_value SEED_ADMIN_EMAIL)"
[ -n "$EMAIL" ] || EMAIL="admin@${NGINX_DOMAIN:-$SHOP_DOMAIN}"
COMPOSE="docker compose --env-file .env -f infrastructure/docker/compose.prod.yml"

# The domain itself only (not www): a www name that points elsewhere would
# make the whole request fail.
DOMAINS=(-d "${SHOP_DOMAIN}")

echo "==> Requesting certificate for ${SHOP_DOMAIN}"
$COMPOSE run --rm --entrypoint certbot certbot certonly --webroot -w /var/www/certbot \
  "${DOMAINS[@]}" --email "${EMAIL}" --agree-tos --no-eff-email --cert-name "${SHOP_DOMAIN}"

echo "==> Cert obtained. Re-deploying with the shop domain on."
./infrastructure/scripts/deploy.sh "${1:-full}"
