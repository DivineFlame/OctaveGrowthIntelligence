#!/bin/bash
# Backs up the Postgres database to a gzipped dump, retaining 7 days locally.
#
# Not run automatically by anything - schedule it yourself, e.g. via crontab
# on the VPS (crontab -e):
#   0 3 * * * BACKUP_DIR=/var/backups/orgcomms /path/to/scripts/backup-vps.sh >> /var/log/orgcomms-backup.log 2>&1
#
# Previously this hardcoded `docker exec orgcomms-postgres` with a fixed
# username/database (orgcomms/orgcomms_prod). Two problems: it silently
# backed up nothing if POSTGRES_USER/POSTGRES_DB were ever customized (no
# error, pg_dump would just fail against the wrong role/db), and it broke
# outright once docker-compose.vps.yml's hardcoded container_name entries
# were removed (needed to stop repeated deployments from colliding on
# container identity - see the commit that removed them). Postgres's actual
# container name is now assigned dynamically by Compose per deployment
# (e.g. under Dokploy, prefixed with that app's generated project name), so
# a fixed name can no longer be relied on at all.
#
# Finds the running postgres container by its compose service label
# instead - this works regardless of project name/prefix, under Dokploy or
# a plain `docker compose up`, without needing to know either in advance.
set -euo pipefail

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=${BACKUP_DIR:-./backups}
POSTGRES_USER=${POSTGRES_USER:-orgcomms}
POSTGRES_DB=${POSTGRES_DB:-orgcomms_prod}

CONTAINER=$(docker ps --filter "label=com.docker.compose.service=postgres" --format '{{.Names}}' | head -n1)
if [ -z "$CONTAINER" ]; then
  echo "No running postgres container found (looked for one labeled com.docker.compose.service=postgres)." >&2
  echo "Is the stack up? (docker ps | grep postgres)" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
docker exec "$CONTAINER" pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "$BACKUP_DIR/postgres_${DATE}.sql.gz"
find "$BACKUP_DIR" -name "*.gz" -mtime +7 -delete
echo "Backup $BACKUP_DIR/postgres_${DATE}.sql.gz"
