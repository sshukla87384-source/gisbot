#!/usr/bin/env bash
# Deploy / update the Get It Sasta stack on the VPS. Run from the repo root.
#   ./infrastructure/scripts/deploy.sh          # bot + data stores (current scope)
#   ./infrastructure/scripts/deploy.sh full     # + api/worker/admin when shipped
set -euo pipefail

PROFILE="${1:-}"
COMPOSE="docker compose --env-file .env -f infrastructure/docker/compose.prod.yml"
[ "$PROFILE" = "full" ] && COMPOSE="$COMPOSE --profile full"

[ -f .env ] || { echo "ERROR: .env missing (copy .env.example and fill it in)"; exit 1; }

# Render nginx domain from .env (NGINX_DOMAIN=getitsasta.com)
NGINX_DOMAIN="$(grep -E '^NGINX_DOMAIN=' .env | cut -d= -f2- || true)"
[ -n "$NGINX_DOMAIN" ] || { echo "ERROR: set NGINX_DOMAIN in .env"; exit 1; }
sed "s/__DOMAIN__/${NGINX_DOMAIN}/g" infrastructure/nginx/gis.conf \
  > infrastructure/nginx/gis.rendered.conf

echo "==> Pulling latest code"
git pull --ff-only

echo "==> Building images"
$COMPOSE build --pull

echo "==> Applying stack (migrations run as the one-shot 'migrate' service)"
if ! $COMPOSE up -d --remove-orphans; then
  echo ""
  echo "===================================================================="
  echo "  DEPLOY FAILED — the real error from the migrate container is:"
  echo "===================================================================="
  $COMPOSE logs --tail=80 migrate || true
  exit 1
fi

echo "==> Waiting for bot health"
for i in $(seq 1 30); do
  if $COMPOSE ps bot --format '{{.Health}}' 2>/dev/null | grep -q healthy; then
    echo "==> Healthy."
    $COMPOSE ps
    exit 0
  fi
  sleep 2
done
echo "WARNING: bot not healthy after 60s — inspect: $COMPOSE logs bot"
$COMPOSE ps
exit 1
