#!/bin/bash
# Retries content_variants stuck in PUBLISH_FAILED by calling the internal
# publish route by hand for each one.
#
# Background: approving a variant (POST /content/variants/:id/approve)
# publishes it synchronously, in-process, right there in the request - see
# publishContentVariant() in api/src/server.js. There is no longer a queue
# or worker container in between (the old hermes-orchestrator container
# and its Redis publisher:queue list were removed), so a variant can no
# longer get silently lost in flight. What it CAN still do is fail: a
# channel's API was down, DNS hiccuped, a token expired, etc. When that
# happens the variant's status is set to PUBLISH_FAILED and the error is
# recorded in content_variants.publish_error - it is never retried
# automatically.
#
# This finds every variant still 'PUBLISH_FAILED' and calls
# POST /internal/content-variants/:id/publish for each one (the same
# internal, secret-protected route the approve endpoint itself calls
# in-process), which re-attempts the publish and updates the variant's
# status based on the outcome. Safe to run repeatedly: a variant that
# publishes successfully is no longer PUBLISH_FAILED by the time this
# runs again, so it won't be retried twice.
#
# Run it by hand after a channel outage is resolved, or whenever someone
# reports an approved post that never went live:
#   INTERNAL_API_SECRET=... ./scripts/recover-stuck-publishes.sh
#   INTERNAL_API_SECRET=... ./scripts/recover-stuck-publishes.sh https://api.yourdomain.com
set -euo pipefail

BASE_URL="${1:-http://localhost:8300}"
POSTGRES_USER=${POSTGRES_USER:-orgcomms}
POSTGRES_DB=${POSTGRES_DB:-orgcomms_prod}

if [ -z "${INTERNAL_API_SECRET:-}" ]; then
  echo "INTERNAL_API_SECRET is not set in this shell's environment - export it (same value as in your .env) before running this." >&2
  exit 1
fi

PG_CONTAINER=$(docker ps --filter "label=com.docker.compose.service=postgres" --format '{{.Names}}' | head -n1)
if [ -z "$PG_CONTAINER" ]; then
  echo "Could not find a running postgres container (looked for compose service label 'postgres')." >&2
  echo "Is the stack up? (docker ps)" >&2
  exit 1
fi

IDS=$(docker exec -i "$PG_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -c "
  SELECT id FROM content_variants WHERE status = 'PUBLISH_FAILED';
")

if [ -z "$IDS" ]; then
  echo "No PUBLISH_FAILED variants found."
  exit 0
fi

OK=0
STILL_FAILED=0
while IFS= read -r ID; do
  [ -z "$ID" ] && continue
  RESPONSE=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/internal/content-variants/$ID/publish" \
    -H "X-Internal-Secret: $INTERNAL_API_SECRET" -H "Content-Type: application/json")
  STATUS=$(echo "$RESPONSE" | tail -n1)
  BODY=$(echo "$RESPONSE" | sed '$d')
  if [ "$STATUS" = "200" ]; then
    echo "Published variant $ID"
    OK=$((OK+1))
  else
    echo "Still failing: variant $ID (HTTP $STATUS) - $BODY"
    STILL_FAILED=$((STILL_FAILED+1))
  fi
done <<< "$IDS"

echo "$OK published, $STILL_FAILED still failed."
