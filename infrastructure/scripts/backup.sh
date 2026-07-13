#!/usr/bin/env bash
# Nightly encrypted Postgres backup → S3-compatible storage (Security doc §8).
# Cron (root):  10 2 * * *  cd /opt/gisbot && ./infrastructure/scripts/backup.sh >> /var/log/gis-backup.log 2>&1
# Required in .env: POSTGRES_USER/POSTGRES_DB, BACKUP_S3_BUCKET, AWS_ACCESS_KEY_ID,
# AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL (R2/Spaces/etc.), BACKUP_AGE_RECIPIENT (age public key).
set -euo pipefail
cd "$(dirname "$0")/../.."

# shellcheck disable=SC1091
set -a; . ./.env; set +a

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="/tmp/gis-${STAMP}.dump"
ENC="${OUT}.age"

echo "==> pg_dump ${POSTGRES_DB:-gis}"
docker compose --env-file .env -f infrastructure/docker/compose.prod.yml \
  exec -T postgres pg_dump -U "${POSTGRES_USER:-gis}" -d "${POSTGRES_DB:-gis}" -Fc > "$OUT"

echo "==> Encrypting (age)"
command -v age >/dev/null || { echo "ERROR: install age (apt install age)"; exit 1; }
age -r "$BACKUP_AGE_RECIPIENT" -o "$ENC" "$OUT"
rm -f "$OUT"

echo "==> Uploading to s3://${BACKUP_S3_BUCKET}/pg/"
command -v aws >/dev/null || { echo "ERROR: install awscli"; exit 1; }
aws s3 cp "$ENC" "s3://${BACKUP_S3_BUCKET}/pg/" ${AWS_ENDPOINT_URL:+--endpoint-url "$AWS_ENDPOINT_URL"}
rm -f "$ENC"

echo "==> Pruning remote backups older than 30 days"
CUTOFF="$(date -u -d '30 days ago' +%Y%m%dT%H%M%SZ)"
aws s3 ls "s3://${BACKUP_S3_BUCKET}/pg/" ${AWS_ENDPOINT_URL:+--endpoint-url "$AWS_ENDPOINT_URL"} \
  | awk '{print $4}' | while read -r f; do
      ts="${f#gis-}"; ts="${ts%.dump.age}"
      if [[ -n "$ts" && "$ts" < "$CUTOFF" ]]; then
        aws s3 rm "s3://${BACKUP_S3_BUCKET}/pg/$f" ${AWS_ENDPOINT_URL:+--endpoint-url "$AWS_ENDPOINT_URL"}
      fi
    done

echo "==> Backup complete: gis-${STAMP}.dump.age"
