#!/usr/bin/env bash
#
# The stub's contract in one run: every service answers /health, and a browser's login path
# through the front works end to end.
#
# The health half polls rather than assumes. `make stub` returns as soon as compose has
# created the containers, migrate has finished and ts-node has started — or well before, if
# the images were built earlier and everything comes up fast. A fixed sleep is either wasted
# time or not enough; polling until a deadline is both.
#
# The login half is deliberately the browser's route: http://127.0.0.1:3000, through the
# front's rewrites, into the gateway, out to five services. It exercises the exact wiring the
# stub claims to mirror — a stack that is green here and red in ECS means the two layouts
# differ, which is the only thing this file exists to catch.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$ROOT"

COMPOSE="${COMPOSE:-docker compose}"
FILES=(-f docker-compose.yml -f docker-compose.stub.yml)
compose() { $COMPOSE "${FILES[@]}" "$@"; }

FRONT="http://127.0.0.1:3000"
DEADLINE=$(( $(date +%s) + 240 ))

pass=0
fail=0

report() { # PASS|FAIL label detail
  local colour=32
  [ "$1" = FAIL ] && colour=31
  printf '  \033[%sm%s\033[0m %s%s\n' "$colour" "$1" "$2" "${3:+ ($3)}"
  [ "$1" = PASS ] && pass=$((pass + 1)) || fail=$((fail + 1))
}

# --- every service answers /health -----------------------------------------------------
# Services poll their own container over localhost — the address the process binds — while
# the front is polled on the host port, which is the only side of it a client ever sees.
declare -A PORT=(
  [identity]=3001 [access-control]=3002 [credential-vault]=3003 [session]=3004
  [auth-flow]=3005 [mfa]=3006 [api-key]=3007 [account-security]=3008
  [notification]=3009 [audit-log]=3010 [api-gateway]=3000
)
ORDER=(identity access-control credential-vault session auth-flow mfa api-key \
  account-security notification audit-log api-gateway front)

healthy() { # service
  local svc="$1"
  if [ "$svc" = front ]; then
    [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$FRONT/" || echo 000)" = 200 ]
    return
  fi
  compose exec -T "$svc" node -e \
    "fetch('http://localhost:${PORT[$svc]}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1
}

declare -A up
pending=${#ORDER[@]}
echo "stub-smoke: waiting for $pending containers (up to $((DEADLINE - $(date +%s)))s)"
while [ "$pending" -gt 0 ] && [ "$(date +%s)" -lt "$DEADLINE" ]; do
  for svc in "${ORDER[@]}"; do
    [ -n "${up[$svc]:-}" ] && continue
    if healthy "$svc"; then
      up[$svc]=1
      pending=$((pending - 1))
      report PASS "$svc /health"
    fi
  done
  [ "$pending" -gt 0 ] && sleep 6
done

for svc in "${ORDER[@]}"; do
  if [ -z "${up[$svc]:-}" ]; then
    report FAIL "$svc /health" "not up by the deadline"
    compose logs --tail 8 "$svc" 2>&1 | sed 's/^/      /' || true
  fi
done

# --- the login path, through the front ------------------------------------------------
# Register carries the password (the gateway's POST /auth/register creates the account, its
# first password and the session in one round trip), then a second call proves the password
# alone signs in, then /me proves the token it returns is accepted by the whole chain.
if [ -n "${up[front]:-}" ] && [ -n "${up[api-gateway]:-}" ]; then
  EMAIL="stub-smoke-$$-$RANDOM@example.com"
  BODY='{"email":"'"$EMAIL"'","password":"Stub-smoke-pass-1!"}'

  want() { # label code curl-args...
    local label="$1" wanted="$2" code="" resp="" attempt
    shift 2
    for attempt in 1 2 3; do
      resp=$(curl -s -m 10 -w '\n%{http_code}' "$@" || echo $'\n000')
      code=${resp##*$'\n'}
      [ "$code" = "$wanted" ] && break
      [ "$attempt" -lt 3 ] && sleep 3
    done
    if [ "$code" = "$wanted" ]; then
      report PASS "$label" "HTTP $code"
    else
      report FAIL "$label" "wanted $wanted, got $code"
    fi
    # The body travels out through a global on purpose: `want` runs the report itself, and a
    # $(...) around it would move both the report and the counters into a subshell.
    WANT_BODY=${resp%$'\n'*}
    return 0
  }

  want "POST /api/auth/register creates a session" 200 \
    -X POST "$FRONT/api/auth/register" -H 'Content-Type: application/json' -d "$BODY"
  ACCESS=$(printf '%s' "$WANT_BODY" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4 || true)
  if [ -n "$ACCESS" ]; then
    report PASS "register returned an access token"
  else
    report FAIL "register returned an access token" "no accessToken in the response"
  fi

  want "POST /api/auth/login signs in with that password" 200 \
    -X POST "$FRONT/api/auth/login" -H 'Content-Type: application/json' -d "$BODY"

  want "GET /api/auth/me accepts the token" 200 \
    "$FRONT/api/auth/me" -H "Authorization: Bearer $ACCESS"

  want "a wrong password is refused" 401 \
    -X POST "$FRONT/api/auth/login" -H 'Content-Type: application/json' \
    -d '{"email":"'"$EMAIL"'","password":"not-the-password"}'
else
  report FAIL "login path" "front or gateway never came up, nothing to drive"
fi

echo "stub-smoke: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
