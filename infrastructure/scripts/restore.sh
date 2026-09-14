#!/usr/bin/env bash
# Restore a backup produced by backup.sh. DESTRUCTIVE — asks for confirmation.
#   ./infrastructure/scripts/restore.sh gis-20260714T021001Z.dump.age [full]
# Requires in .env: BACKUP_* and AWS_* vars (see backup.sh) and the age
# IDENTITY file path in BACKUP_AGE_IDENTITY (kept OFFLINE normally).
set -euo pipefail
# Decrypted dumps land in /tmp: keep them unreadable to other local users.
umask 077
cd "$(dirname "$0")/../.."

FILE="${1:?usage: restore.sh <backup-file-name> [full]}"
PROFILE="${2:-}"
# Cleanup must also run when pg_restore fails, otherwise the DECRYPTED dump is
# left behind in /tmp.
trap 'rm -f "/tmp/${FILE}" "/tmp/${FILE%.age}"' EXIT

# shellcheck disable=SC1091
set -a; . ./.env; set +a

read -r -p "This OVERWRITES database '${POSTGRES_DB:-gis}'. Type RESTORE to continue: " ok
[ "$ok" = "RESTORE" ] || { echo "aborted"; exit 1; }

echo "==> Downloading $FILE"
aws s3 cp "s3://${BACKUP_S3_BUCKET}/pg/${FILE}" /tmp/ ${AWS_ENDPOINT_URL:+--endpoint-url "$AWS_ENDPOINT_URL"}

echo "==> Decrypting"
age -d -i "${BACKUP_AGE_IDENTITY:?set BACKUP_AGE_IDENTITY in .env}" \
  -o "/tmp/${FILE%.age}" "/tmp/${FILE}"

echo "==> Stopping apps (keeping postgres)"
COMPOSE="docker compose --env-file .env -f infrastructure/docker/compose.prod.yml"
# api/admin live behind the "full" profile: without it `up -d` below would never
# start them again after the restore.
[ "$PROFILE" = "full" ] && COMPOSE="$COMPOSE --profile full"
$COMPOSE stop bot api worker admin 2>/dev/null || true

echo "==> Restoring"
$COMPOSE \
  exec -T postgres pg_restore -U "${POSTGRES_USER:-gis}" -d "${POSTGRES_DB:-gis}" \
  --clean --if-exists < "/tmp/${FILE%.age}"

echo "==> Restarting stack"
$COMPOSE up -d
echo "==> Restore complete."
