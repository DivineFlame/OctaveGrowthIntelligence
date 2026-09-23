#!/bin/sh
# Runs inside the postgres-backup sidecar container (see its Dockerfile),
# on a daily cron schedule. Connects to the `postgres`/`redis` services
# over the internal `db` Docker network (TCP, not docker exec) so it works
# the same way regardless of what those containers happen to be named, and
# reads the `recordings` volume directly (mounted read-only into this
# container - see docker-compose.vps.yml).
#
# Backs up all three pieces of state this app can lose that aren't
# recoverable any other way:
#   - Postgres (every table - users, products, leads, content, audit log)
#   - Redis (redisdata - mainly rate-limit windows and any in-flight
#     publisher:queue jobs; NOT the primary defense for lost queue jobs,
#     see scripts/recover-stuck-publishes.sh for that - a queue snapshot
#     from up to 24h ago is stale by the time you'd restore it)
#   - recordings (every uploaded content asset and its transformed
#     per-channel variants - losing this loses actual customer content,
#     not just metadata)
# It deliberately does NOT back up secrets (.env) - see
# scripts/backup-secrets.sh for that, kept separate and manual because
# automatically writing decrypted secrets into a daily, less-guarded
# backup volume is its own risk. See README.md "Hardening notes" for the
# full disaster-recovery picture.
set -eu

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=${BACKUP_DIR:-/backups}
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-7}
mkdir -p "$BACKUP_DIR"

# Shared off-host shipping (see the Postgres section below for the
# original explanation) - opt-in via RCLONE_REMOTE, never fails the backup
# job itself, logs a warning rather than an error code on failure, and
# never deletes the local copy it just shipped.
ship() {
  OUT="$1"
  if [ -n "${RCLONE_REMOTE:-}" ]; then
    if command -v rclone >/dev/null 2>&1; then
      if rclone copyto "$OUT" "${RCLONE_REMOTE%/}/$(basename "$OUT")"; then
        echo "[backup] shipped $(basename "$OUT") to $RCLONE_REMOTE"
      else
        echo "[backup] WARNING: local backup succeeded but off-host copy of $(basename "$OUT") to $RCLONE_REMOTE failed - see rclone output above. Local backup is NOT deleted." >&2
      fi
    else
      echo "[backup] WARNING: RCLONE_REMOTE is set but rclone is not installed in this image." >&2
    fi
  fi
}

# --- Postgres ---------------------------------------------------------
: "${POSTGRES_HOST:?POSTGRES_HOST not set}"
: "${POSTGRES_USER:?POSTGRES_USER not set}"
: "${POSTGRES_DB:?POSTGRES_DB not set}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD not set}"
export PGPASSWORD="$POSTGRES_PASSWORD"

PG_OUT="$BACKUP_DIR/postgres_${DATE}.sql.gz"
if pg_dump -h "$POSTGRES_HOST" -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "$PG_OUT.tmp"; then
  mv "$PG_OUT.tmp" "$PG_OUT"
  echo "[backup] postgres OK: $PG_OUT ($(du -h "$PG_OUT" | cut -f1))"
  ship "$PG_OUT"
else
  rm -f "$PG_OUT.tmp"
  echo "[backup] postgres FAILED - pg_dump did not complete, no partial file kept" >&2
fi
find "$BACKUP_DIR" -name "postgres_*.sql.gz" -mtime "+${RETENTION_DAYS}" -delete

# --- Redis --------------------------------------------------------------
# Best-effort, non-fatal to the overall job: this container's core purpose
# is the Postgres dump above, so a Redis or recordings problem is logged
# and skipped rather than failing everything (including the still-good
# Postgres backup that already succeeded above).
if [ -n "${REDIS_HOST:-}" ] && [ -n "${REDIS_PASSWORD:-}" ]; then
  REDIS_OUT="$BACKUP_DIR/redis_${DATE}.rdb"
  # --rdb streams a point-in-time RDB snapshot straight from the server
  # over the connection (via a real Redis SYNC) into this local file - no
  # need for shell/filesystem access inside the redis container itself.
  if redis-cli -h "$REDIS_HOST" --no-auth-warning -a "$REDIS_PASSWORD" --rdb "$REDIS_OUT.tmp" > /dev/null 2>&1; then
    gzip -f "$REDIS_OUT.tmp" && mv "$REDIS_OUT.tmp.gz" "$REDIS_OUT.gz"
    echo "[backup] redis OK: $REDIS_OUT.gz ($(du -h "$REDIS_OUT.gz" | cut -f1))"
    ship "$REDIS_OUT.gz"
  else
    rm -f "$REDIS_OUT.tmp"
    echo "[backup] redis FAILED or REDIS_HOST unreachable - skipped, does not affect the postgres backup above" >&2
  fi
  find "$BACKUP_DIR" -name "redis_*.rdb.gz" -mtime "+${RETENTION_DAYS}" -delete
else
  echo "[backup] REDIS_HOST/REDIS_PASSWORD not set - skipping redis backup"
fi

# --- recordings -----------------------------------------------------------
# Mounted read-only at /recordings (see docker-compose.vps.yml). Every
# uploaded content asset and its transformed per-channel variants live
# here by s3_key - losing this loses actual content, not just rows that
# reference it, so it needs the same off-host treatment as Postgres.
if [ -d /recordings ] && [ -n "$(ls -A /recordings 2>/dev/null)" ]; then
  REC_OUT="$BACKUP_DIR/recordings_${DATE}.tar.gz"
  if tar -czf "$REC_OUT.tmp" -C / recordings; then
    mv "$REC_OUT.tmp" "$REC_OUT"
    echo "[backup] recordings OK: $REC_OUT ($(du -h "$REC_OUT" | cut -f1))"
    ship "$REC_OUT"
  else
    rm -f "$REC_OUT.tmp"
    echo "[backup] recordings tar FAILED - skipped, does not affect the postgres/redis backups above" >&2
  fi
  find "$BACKUP_DIR" -name "recordings_*.tar.gz" -mtime "+${RETENTION_DAYS}" -delete
else
  echo "[backup] /recordings not mounted or empty - skipping recordings backup"
fi

echo "[backup] done. On disk: $(find "$BACKUP_DIR" -type f | wc -l) file(s), $(du -sh "$BACKUP_DIR" | cut -f1) total."
if [ -z "${RCLONE_REMOTE:-}" ]; then
  echo "[backup] RCLONE_REMOTE not set - all of the above is local-only, on the same disk as everything else on this VPS. See README.md for off-host shipping setup."
fi
