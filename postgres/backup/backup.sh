#!/bin/sh
# Runs inside the postgres-backup sidecar container (see its Dockerfile),
# on a daily cron schedule. Connects to the `postgres` service over the
# internal `db` Docker network (TCP, not docker exec) so it works the same
# way regardless of what the postgres container happens to be named.
set -eu

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=${BACKUP_DIR:-/backups}
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-7}

: "${POSTGRES_HOST:?POSTGRES_HOST not set}"
: "${POSTGRES_USER:?POSTGRES_USER not set}"
: "${POSTGRES_DB:?POSTGRES_DB not set}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD not set}"

mkdir -p "$BACKUP_DIR"
export PGPASSWORD="$POSTGRES_PASSWORD"

OUT="$BACKUP_DIR/postgres_${DATE}.sql.gz"
if pg_dump -h "$POSTGRES_HOST" -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "$OUT.tmp"; then
  mv "$OUT.tmp" "$OUT"
  echo "[backup] OK: $OUT ($(du -h "$OUT" | cut -f1))"
else
  rm -f "$OUT.tmp"
  echo "[backup] FAILED - pg_dump did not complete, no partial file kept" >&2
  exit 1
fi

find "$BACKUP_DIR" -name "postgres_*.sql.gz" -mtime "+${RETENTION_DAYS}" -delete
echo "[backup] retention: keeping last ${RETENTION_DAYS} days, $(find "$BACKUP_DIR" -name 'postgres_*.sql.gz' | wc -l) backups on disk"
