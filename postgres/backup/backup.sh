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

# Optional off-host shipping. A local-only backup lives in the pgbackups
# volume on this same VPS disk - it protects against a bad migration or a
# fat-fingered DELETE, but not against disk failure, the VPS provider
# having an outage, or an accidental `docker volume rm`. This step is
# opt-in (not wired up in docker-compose.vps.yml by default) because it
# needs the operator's own object-storage credentials and a specific
# remote to send to - see README.md "Hardening notes" for how to turn it
# on. It never fails the backup job itself: the local backup above already
# succeeded by the time this runs, so a shipping problem is logged as a
# warning, not an exit code, and doesn't delete/skip the local copy.
if [ -n "${RCLONE_REMOTE:-}" ]; then
  if command -v rclone >/dev/null 2>&1; then
    if rclone copyto "$OUT" "${RCLONE_REMOTE%/}/$(basename "$OUT")"; then
      echo "[backup] shipped to $RCLONE_REMOTE"
    else
      echo "[backup] WARNING: local backup succeeded but off-host copy to $RCLONE_REMOTE failed - see rclone output above. Local backup is NOT deleted." >&2
    fi
  else
    echo "[backup] WARNING: RCLONE_REMOTE is set but rclone is not installed in this image - see README.md for the Dockerfile change needed." >&2
  fi
else
  echo "[backup] RCLONE_REMOTE not set - this backup is local-only, on the same disk as everything else on this VPS. See README.md for off-host shipping setup."
fi
