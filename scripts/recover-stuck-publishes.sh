#!/bin/bash
# Re-queues content_variants that were approved (and pushed onto Redis's
# publisher:queue) but never actually got published.
#
# The gap this closes: publisher:queue is a plain Redis list, popped by
# hermes-orchestrator with BRPOP and no ack. A job is lost for good if:
# Redis restarts/crashes before AOF fsyncs it, the redisdata volume itself
# is lost, hermes-orchestrator pops a job then dies before finishing the
# HTTP call to /internal/content-variants/:id/publish, or
# hermes-orchestrator simply wasn't running when POST
# /content/variants/:variantId/approve pushed the job. In every one of
# those cases content_variants.status is left at 'APPROVED' forever -
# nothing else ever revisits it, and the content silently never publishes.
#
# This finds every variant still 'APPROVED' whose most recent approval
# (the `approvals` table row - content_variants itself has no updated_at)
# happened more than STALE_MINUTES ago (default 10 - comfortably longer
# than a single publish HTTP round trip, so it won't re-queue a job that's
# simply still in flight) and pushes it back onto publisher:queue.
# Idempotent to run repeatedly: a variant that already published or failed
# in the meantime is skipped, since it's no longer 'APPROVED' by the time
# this runs again.
#
# Not run automatically - this handles data loss from a Redis incident,
# not routine operation. Run it by hand after you've confirmed content is
# stuck (e.g. a customer reports an approved post never went live):
#   REDIS_PASSWORD=... ./scripts/recover-stuck-publishes.sh
#   REDIS_PASSWORD=... STALE_MINUTES=30 ./scripts/recover-stuck-publishes.sh
set -euo pipefail

STALE_MINUTES=${STALE_MINUTES:-10}
POSTGRES_USER=${POSTGRES_USER:-orgcomms}
POSTGRES_DB=${POSTGRES_DB:-orgcomms_prod}

if [ -z "${REDIS_PASSWORD:-}" ]; then
  echo "REDIS_PASSWORD is not set in this shell's environment - export it (same value as in your .env) before running this." >&2
  exit 1
fi

PG_CONTAINER=$(docker ps --filter "label=com.docker.compose.service=postgres" --format '{{.Names}}' | head -n1)
REDIS_CONTAINER=$(docker ps --filter "label=com.docker.compose.service=redis" --format '{{.Names}}' | head -n1)
if [ -z "$PG_CONTAINER" ] || [ -z "$REDIS_CONTAINER" ]; then
  echo "Could not find running postgres and/or redis containers (looked for compose service labels 'postgres'/'redis')." >&2
  echo "Is the stack up? (docker ps)" >&2
  exit 1
fi

IDS=$(docker exec -i "$PG_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -c "
  SELECT cv.id FROM content_variants cv
  WHERE cv.status = 'APPROVED'
  AND (
    SELECT MAX(a.created_at) FROM approvals a
    WHERE a.variant_id = cv.id AND a.status = 'APPROVED'
  ) < NOW() - INTERVAL '${STALE_MINUTES} minutes';
")

if [ -z "$IDS" ]; then
  echo "No stuck variants found (status=APPROVED, approved more than ${STALE_MINUTES}m ago)."
  exit 0
fi

COUNT=0
while IFS= read -r ID; do
  [ -z "$ID" ] && continue
  PAYLOAD="{\"variant_id\":\"${ID}\"}"
  docker exec -i "$REDIS_CONTAINER" redis-cli --no-auth-warning -a "$REDIS_PASSWORD" LPUSH publisher:queue "$PAYLOAD" > /dev/null
  echo "Re-queued variant $ID"
  COUNT=$((COUNT+1))
done <<< "$IDS"

echo "Re-queued $COUNT stuck variant(s) onto publisher:queue. hermes-orchestrator will pick them up within a second if it's running."
