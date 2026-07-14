#!/usr/bin/env bash
# Deploy / update the Get It Sasta stack. Run from the repo root.
#   ./infrastructure/scripts/deploy.sh          # bot + worker + data stores + landing
#   ./infrastructure/scripts/deploy.sh full     # + api + admin panel
set -euo pipefail

PROFILE="${1:-}"
COMPOSE="docker compose --env-file .env -f infrastructure/docker/compose.prod.yml"
[ "$PROFILE" = "full" ] && COMPOSE="$COMPOSE --profile full"

[ -f .env ] || { echo "ERROR: .env missing (copy .env.example and fill it in)"; exit 1; }
NGINX_DOMAIN="$(grep -E '^NGINX_DOMAIN=' .env | cut -d= -f2- || true)"
[ -n "$NGINX_DOMAIN" ] || { echo "ERROR: set NGINX_DOMAIN in .env"; exit 1; }

# Does a TLS cert for the ROOT domain (landing page) already exist?
HAS_ROOT_CERT=0
if docker run --rm -v gis_certbot_certs:/c alpine test -d "/c/live/${NGINX_DOMAIN}" 2>/dev/null; then
  HAS_ROOT_CERT=1
fi

echo "==> Rendering nginx config for ${NGINX_DOMAIN} (root cert: ${HAS_ROOT_CERT})"
sed "s/__DOMAIN__/${NGINX_DOMAIN}/g" infrastructure/nginx/gis.conf \
  > infrastructure/nginx/gis.rendered.conf
if [ "$HAS_ROOT_CERT" != "1" ]; then
  # Remove the landing HTTPS block so nginx starts without the root cert.
  # (The landing page still serves over http until the cert is obtained.)
  sed -i '/# >>> LANDING_HTTPS/,/# <<< LANDING_HTTPS/d' infrastructure/nginx/gis.rendered.conf
  echo "    (landing HTTPS disabled until cert exists — run get-landing-cert.sh)"
fi

echo "==> Pulling latest code"; git pull --ff-only || true
echo "==> Building images"; $COMPOSE build --pull
echo "==> Applying stack"; $COMPOSE up -d --remove-orphans

echo "==> Waiting for bot health"
for i in $(seq 1 30); do
  if $COMPOSE ps bot --format '{{.Health}}' 2>/dev/null | grep -q healthy; then
    echo "==> Healthy."; $COMPOSE ps; exit 0
  fi
  sleep 2
done
echo "WARNING: bot not healthy after 60s — check: $COMPOSE logs bot"
$COMPOSE ps
