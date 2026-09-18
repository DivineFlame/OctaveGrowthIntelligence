#!/bin/bash
# Restores a Postgres backup produced by the postgres-backup sidecar (or
# scripts/backup-vps.sh) into the running postgres container.
#
# A backup nobody has ever restored is not a tested backup - this script
# exists so restoring is one command instead of something improvised for
# the first time during an actual incident.
#
# Usage:
#   ./scripts/restore-vps.sh /path/to/postgres_20260101_030000.sql.gz
#
# DESTRUCTIVE: this drops and recreates every table currently in the
# database before restoring. Confirms interactively unless CONFIRM=yes is
# set in the environment (for non-interactive/CI use).
set -euo pipefail

FILE="${1:-}"
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "Usage: $0 /path/to/backup.sql.gz" >&2
  exit 1
fi

POSTGRES_USER=${POSTGRES_USER:-orgcomms}
POSTGRES_DB=${POSTGRES_DB:-orgcomms_prod}

CONTAINER=$(docker ps --filter "label=com.docker.compose.service=postgres" --format '{{.Names}}' | head -n1)
if [ -z "$CONTAINER" ]; then
  echo "No running postgres container found (looked for one labeled com.docker.compose.service=postgres)." >&2
  exit 1
fi

echo "About to restore $FILE into database '$POSTGRES_DB' on container $CONTAINER."
echo "This will DROP every existing table in that database first."
if [ "${CONFIRM:-}" != "yes" ]; then
  read -r -p "Type 'yes' to continue: " ans
  [ "$ans" = "yes" ] || { echo "Aborted."; exit 1; }
fi

gunzip -c "$FILE" | docker exec -i "$CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -v ON_ERROR_STOP=1 \
  -c "SET client_min_messages TO WARNING;"

# pg_dump's output (no --clean flag was used when producing these backups)
# is a plain INSERT/CREATE dump, not a --clean/--if-exists one, so restoring
# into a database that already has the same tables will fail on conflicts.
# Recreate the schema empty first, then load the dump.
echo "Dropping and recreating the public schema..."
docker exec -i "$CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
  -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

echo "Loading $FILE..."
gunzip -c "$FILE" | docker exec -i "$CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1

echo "Restore complete. Sanity check a few tables:"
docker exec -i "$CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\dt" | head -20
