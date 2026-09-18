#!/bin/bash
# Post-deploy smoke test - hits a running api container's real endpoints
# to catch a broken deploy (wrong DATABASE_URL, a migration that silently
# didn't apply, a route that 500s on every request) before someone finds
# out from a user report. Not a unit/integration test suite (there isn't
# one in this repo yet) - a fast, no-dependencies check you can run right
# after `docker compose up` or a Dokploy redeploy.
#
# Usage: ./scripts/smoke-test.sh [base_url]
#   base_url defaults to http://localhost:8300 (the api port this repo's
#   docker-compose.vps.yml binds to 127.0.0.1) - pass the real API_DOMAIN
#   URL to check a live deployment instead, e.g.:
#     ./scripts/smoke-test.sh https://api.yourdomain.com

set -uo pipefail
BASE_URL="${1:-http://localhost:8300}"
PASS=0
FAIL=0

check() {
  local desc="$1" method="$2" path="$3" expect="$4" extra_args="${5:-}"
  local status
  status=$(curl -s -o /dev/null -w '%{http_code}' -X "$method" "$BASE_URL$path" $extra_args 2>/dev/null)
  if [ "$status" = "$expect" ]; then
    echo "PASS  $desc (HTTP $status)"
    PASS=$((PASS+1))
  else
    echo "FAIL  $desc (expected HTTP $expect, got $status)"
    FAIL=$((FAIL+1))
  fi
}

echo "Smoke testing $BASE_URL"
echo "---"

# /health does a real DB SELECT 1 and a real Redis PING (see api/src/server.js)
# - a 200 here means Postgres and Redis are actually reachable, not just that
# the Node process is up.
check "GET /health" GET /health 200

# Every protected route should reject with no token, not 500 or silently
# leak data - authMiddleware returning anything other than 401 here is a
# real bug, not a missing-auth edge case.
check "GET /leads with no auth -> 401" GET /leads 401

check "GET /users with no auth -> 401" GET /users 401

# Wrong credentials should be a clean 401, not a 500 (which would suggest
# the users table or bcrypt comparison itself is broken) or a 200 (which
# would be catastrophic).
check "POST /auth/login with garbage creds -> 401" POST /auth/login 401 \
  "-H Content-Type:application/json -d {\"email\":\"nobody@nowhere.invalid\",\"password\":\"wrong\"}"

# The internal-only publish route must reject without the shared secret -
# this is the RBAC boundary between "any request from the internet" and
# "only hermes-orchestrator, with the secret, can call this".
check "POST /internal/content-variants/x/publish with no secret -> 401" POST \
  /internal/content-variants/00000000-0000-0000-0000-000000000000/publish 401 \
  "-H Content-Type:application/json -d {\"tenant_id\":\"00000000-0000-0000-0000-000000000000\"}"

echo "---"
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
