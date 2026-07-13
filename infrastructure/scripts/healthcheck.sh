#!/usr/bin/env bash
# 5-minute cron: verify containers + endpoints; alert the admin Telegram chat on failure.
#   */5 * * * *  cd /opt/gisbot && ./infrastructure/scripts/healthcheck.sh >/dev/null 2>&1
set -euo pipefail
cd "$(dirname "$0")/../.."

# shellcheck disable=SC1091
set -a; . ./.env; set +a

FAIL=""

unhealthy="$(docker ps --filter health=unhealthy --format '{{.Names}}' || true)"
[ -z "$unhealthy" ] || FAIL="unhealthy containers: ${unhealthy}"

if ! curl -fsS -m 5 "http://127.0.0.1:80/.well-known/acme-challenge/ping" -o /dev/null 2>/dev/null; then
  # 404 is fine (nginx up); connection refused is not.
  curl -s -m 5 -o /dev/null "http://127.0.0.1:80" || FAIL="${FAIL}; nginx not answering on :80"
fi

DISK_USED="$(df -P / | awk 'NR==2 {gsub("%","",$5); print $5}')"
[ "$DISK_USED" -lt 85 ] || FAIL="${FAIL}; disk ${DISK_USED}% used"

if [ -n "$FAIL" ]; then
  echo "HEALTHCHECK FAIL: $FAIL"
  if [ -n "${BOT_TOKEN:-}" ] && [ -n "${ADMIN_ALERT_CHAT_ID:-}" ]; then
    curl -fsS -m 10 "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${ADMIN_ALERT_CHAT_ID}" \
      --data-urlencode "text=🚨 Get It Sasta healthcheck: ${FAIL}" >/dev/null || true
  fi
  exit 1
fi
echo "OK"
