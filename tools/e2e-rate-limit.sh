#!/usr/bin/env bash
# Rate limiting at the edge, exercised against a real Redis.
#
# Separate from e2e-gateway.sh for two reasons. It needs a limit low enough to trip in a handful
# of requests, and a low limit cannot coexist with a suite that makes dozens of calls from one
# address. And it needs only the gateway and Redis: the guard runs before any peer is contacted,
# so the peers this run never reaches are exactly the peers this run is not testing.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# The stack has to be up before a service can boot. A stopped Postgres otherwise
# surfaces as "service never started", which reads as a code failure.
shell_source="$(dirname "$0")/preflight-stack.sh"
[ -f "$shell_source" ] && . "$shell_source"

export PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=true
export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
# The edge presents this token on every peer call and refuses to boot without one; the value is
# throwaway because nothing here reaches a real peer.
export GRPC_SERVICE_TOKEN="$(head -c 32 /dev/urandom | base64)"
# The key the edge verifies access tokens with. Also throwaway — this run never mints a token
# — but required: a guard with no key could not say yes to anything, and the boot error is
# where that is caught rather than as a wall of 401s.
export SESSION_ACCESS_TOKEN_SIGNING_KEY="$(head -c 32 /dev/urandom | base64)"

# Low enough to trip quickly, high enough that the health checks and the two warm-up calls land
# under it. A limit that only the test understands is a limit nothing else can reason about.
export RATE_LIMIT_DEFAULT_LIMIT="${RATE_LIMIT_DEFAULT_LIMIT:-5}"
export RATE_LIMIT_DEFAULT_WINDOW_SEC=60

LOG=/tmp/opencode
BASE=$(( 5100 + (RANDOM % 300) * 10 ))
PORT=$BASE

pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then printf "  \033[32mPASS\033[0m %s\n" "$1"; pass=$((pass+1));
  else printf "  \033[31mFAIL\033[0m %s (expected=%s got=%s)\n" "$1" "$3" "$2"; fail=$((fail+1)); fi
}

cleanup() {
  pkill -P "$GW_PID" 2>/dev/null
  kill "$GW_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

GW_PID=""
echo "==> booting the edge against $REDIS_URL with a limit of $RATE_LIMIT_DEFAULT_LIMIT/min"
DATABASE_URL="" SERVICE_NAME=api-gateway PORT="$PORT" REDIS_URL="$REDIS_URL" \
  RATE_LIMIT_DEFAULT_LIMIT="$RATE_LIMIT_DEFAULT_LIMIT" \
  GATEWAY_JWT_SECRET="$(head -c 32 /dev/urandom | base64)" \
  GATEWAY_IDENTITY_URL=localhost:1 \
  GATEWAY_ACCESS_CONTROL_URL=localhost:1 \
  GATEWAY_CREDENTIAL_VAULT_URL=localhost:1 \
  GATEWAY_SESSION_URL=localhost:1 \
  GATEWAY_AUTH_FLOW_URL=localhost:1 \
  TS_NODE_PROJECT=apps/api-gateway/tsconfig.app.json \
    npx ts-node --transpile-only -r tsconfig-paths/register apps/api-gateway/src/main.ts \
    > "$LOG/rate-limit.log" 2>&1 &
GW_PID=$!

GW="http://127.0.0.1:$PORT"
for _ in $(seq 1 70); do
  curl -s -m 2 -o /dev/null "$GW/health" && break
  sleep 1
done
check "edge is up" "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$GW/health")" "200"

echo
echo "==> requests within the budget are answered"
FIRST_HEADERS=$(curl -s -m 5 -D - -o /dev/null -X POST "$GW/auth/login" \
  -H 'Content-Type: application/json' -d '{"email":"rl@example.test","password":"x"}')
FIRST_CODE=$(printf '%s' "$FIRST_HEADERS" | head -1 | tr -dc '0-9')
check "the first request is not refused for rate" \
  "$([ "$FIRST_CODE" != "429" ] && echo yes || echo no)" "yes"

LIMIT_HDR=$(printf '%s' "$FIRST_HEADERS" | grep -i '^X-RateLimit-Limit:' | tr -dc '0-9')
check "the budget is advertised in a header" "$LIMIT_HDR" "$RATE_LIMIT_DEFAULT_LIMIT"

REMAINING_HDR=$(printf '%s' "$FIRST_HEADERS" | grep -i '^X-RateLimit-Remaining:' | tr -dc '0-9')
check "the remaining budget decreases" \
  "$([ "$REMAINING_HDR" -lt "$LIMIT_HDR" ] 2>/dev/null && echo yes || echo no)" "yes"

echo
echo "==> the next request past the budget is refused"
EXHAUSTED=""
for _ in $(seq 1 "$((RATE_LIMIT_DEFAULT_LIMIT + 4))"); do
  CODE=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST "$GW/auth/login" \
    -H 'Content-Type: application/json' -d '{"email":"rl@example.test","password":"x"}')
  [ "$CODE" = "429" ] && { EXHAUSTED="$CODE"; break; }
done
check "the limit is enforced" "$EXHAUSTED" "429"

RETRY=$(curl -s -m 5 -D - -o /dev/null -X POST "$GW/auth/login" \
  -H 'Content-Type: application/json' -d '{"email":"rl@example.test","password":"x"}' \
  | grep -i '^Retry-After:' | tr -dc '0-9')
check "the refusal says when to retry" "$([ -n "$RETRY" ] && echo yes || echo no)" "yes"

BODY=$(curl -s -m 5 -X POST "$GW/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"rl@example.test","password":"x"}')
check "the refusal carries the delay in the body too" \
  "$(printf '%s' "$BODY" | grep -c retryAfterSec)" "1"

echo
echo "==> a different address has its own budget"
# The bucket is keyed by address; a second client is a second bucket. Spoofing the header the
# socket address replaces would defeat the limiter, so this is checked rather than trusted.
OTHER=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST "$GW/auth/login" \
  -H 'Content-Type: application/json' -H 'X-Forwarded-For: 10.9.9.9' \
  -d '{"email":"rl@example.test","password":"x"}')
check "a spoofed address does not reset the budget" \
  "$([ "$OTHER" = "429" ] && echo yes || echo no)" "yes"

echo
echo "================================================"
echo "  passed: $pass   failed: $fail"
echo "================================================"
[ "$fail" -eq 0 ] || { echo "--- gateway log tail ---"; sed 's/\x1b\[[0-9;]*m//g' "$LOG/rate-limit.log" | tail -20; }
exit "$fail"
