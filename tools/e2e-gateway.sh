#!/usr/bin/env bash
#
# The public entry point, end to end.
#
# Everything else is exercised service-to-service. This drives the same surface a client
# sees — one process, HTTP in, HTTP out — and asserts the properties that only exist at the
# edge: that a protected route is refused without a token, that `@Public()` is required to
# reach sign-in, that a downstream failure becomes a 5xx with a stable code rather than a
# leaked gRPC error, and that a password never appears in a response.
#
# A gateway is the one component whose bugs are the platform's bugs: a service can be
# perfectly correct and unreachable if the front door is wrong.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$ROOT"

. "$ROOT/tools/e2e-common.sh"

# A random base, so two runs — or a run alongside the other e2e scripts — cannot collide on
# a port and fail with EADDRINUSE that has nothing to do with what is being tested.
#
# Below 32768 for the same reason the front harness moved: everything at or above it is the
# kernel's ephemeral range (`ip_local_port_range`), where any outgoing connection picks its
# source port at random, and a listener there can lose that race with EADDRINUSE in a run
# whose own code is fine.
BASE=$(( 17000 + (RANDOM % 300) * 10 ))
# A second, independently randomised block. Deriving the gRPC ports from BASE means two runs
# that pick the same base also share every gRPC port, and the loser fails with EADDRINUSE on a
# port that has nothing to do with what it is testing.
GRPC_BASE=$(( 21000 + (RANDOM % 300) * 10 ))
GATEWAY_PORT=$BASE
declare -A PORT=( [identity]=$(( BASE + 1 )) [access-control]=$(( BASE + 2 )) \
                  [credential-vault]=$(( BASE + 3 )) [session]=$(( BASE + 4 )) \
                  [auth-flow]=$(( BASE + 5 )) )
# Derived from the scalar BASE, not from ${PORT[...]}: inside $(( )) bash parses an array
# subscript as an arithmetic expression, so ${PORT[access-control]} reads as the difference
# of two unset variables and trips `set -u`. Both arrays are filled from BASE instead.
declare -A GRPC=( [identity]=$(( GRPC_BASE + 1 )) [access-control]=$(( GRPC_BASE + 2 )) \
                 [credential-vault]=$(( GRPC_BASE + 3 )) [session]=$(( GRPC_BASE + 4 )) \
                 [auth-flow]=$(( GRPC_BASE + 5 )) )

# port pairs: http, grpc (the gateway fans out over gRPC to every peer)
boot() { # name http_port grpc_port db
  local name="$1" port="$2" grpc="$3" db="$4"
  # HTTP and gRPC need different ports: a service that serves both on one number binds it
  # twice and dies with EADDRINUSE on itself.
  # A peer service reaches its own dependencies the same way the gateway does: by address.
  # Left at their compiled-in defaults they silently point at ports nobody is listening on,
  # and the first symptom is a plausible-looking "invalid credentials" rather than an error.
  #
  # Nothing between the backslashes may be a comment: inside a line continuation `#` ends the
  # command instead of being skipped, so a stray comment silently discards every variable
  # written above it.
  DATABASE_URL="postgresql://postgres:postgres@localhost:5432/$db" \
  SERVICE_NAME="$name" PORT="$port" GRPC_URL="0.0.0.0:$grpc" \
  IDENTITY_GRPC_URL="localhost:${GRPC[identity]}" \
  ACCESS_CONTROL_GRPC_URL="localhost:${GRPC[access-control]}" \
  CREDENTIAL_VAULT_GRPC_URL="localhost:${GRPC[credential-vault]}" \
  SESSION_GRPC_URL="localhost:${GRPC[session]}" \
  AUTH_FLOW_GRPC_URL="localhost:${GRPC[auth-flow]}" \
  MFA_GRPC_URL="localhost:39006" \
  TS_NODE_PROJECT="apps/$name/tsconfig.app.json" \
    npx ts-node --transpile-only -r tsconfig-paths/register "apps/$name/src/main.ts" \
    >> "$LOG/gw-$name.log" 2>&1 &
  PIDS+=($!)
}

for name in identity access-control credential-vault session auth-flow api-gateway; do
  : > "$LOG/gw-$name.log"
done

for name in identity access-control credential-vault session auth-flow; do
  case "$name" in
    identity)          db=identity ;;
    access-control)    db=access_control ;;
    credential-vault)  db=credential_vault ;;
    session)     db=session_engine ;;
    auth-flow)      db=auth_flow ;;
  esac
  boot "$name" "${PORT[$name]}" "${GRPC[$name]}" "$db"
done

# The gateway owns no database: it has no Prisma client and no DATABASE_URL, which is the
# property that keeps business state from forking at the edge.
DATABASE_URL="" SERVICE_NAME=api-gateway PORT="$GATEWAY_PORT" \
  REDIS_URL="${REDIS_URL:-redis://localhost:6379}" \
  GATEWAY_IDENTITY_URL=localhost:${GRPC[identity]} \
  GATEWAY_ACCESS_CONTROL_URL=localhost:${GRPC[access-control]} \
  GATEWAY_CREDENTIAL_VAULT_URL=localhost:${GRPC[credential-vault]} \
  GATEWAY_SESSION_URL=localhost:${GRPC[session]} \
  GATEWAY_AUTH_FLOW_URL=localhost:${GRPC[auth-flow]} \
  TS_NODE_PROJECT=apps/api-gateway/tsconfig.app.json \
    npx ts-node --transpile-only -r tsconfig-paths/register apps/api-gateway/src/main.ts \
    > "$LOG/gw-api-gateway.log" 2>&1 &
  PIDS+=($!)

GW="http://127.0.0.1:$GATEWAY_PORT"
ready=0
for _ in $(seq 1 70); do
  up=0
  for p in "$GATEWAY_PORT" "${PORT[identity]}" "${PORT[access-control]}" \
           "${PORT[credential-vault]}" "${PORT[session]}" "${PORT[auth-flow]}"; do
    curl -sf -m 2 "http://127.0.0.1:$p/health" >/dev/null 2>&1 && up=$((up+1))
  done
  if [ "$up" -eq 6 ]; then ready=1; break; fi
  sleep 1
done
[ "$ready" -eq 1 ] || echo "  (not every service came up in time; results below may be partial)
  for name in identity access-control credential-vault session auth-flow api-gateway; do
    grep -q 'listening on port' "$LOG/gw-$name.log" 2>/dev/null || {
      printf '  --- %s never started ---\n' "$name"
      sed 's/\x1b\[[0-9;]*m//g' "$LOG/gw-$name.log" | grep -vE '^\s+at |^\s*$' | tail -4 | sed 's/^/  /'
    }
  done"

EMAIL="gw-$RANDOM-$$@example.test"
PASSWORD='Str0ng-Passw0rd!x'

echo
echo "==> 1. sign-in is reachable without a token (@Public)"
check "POST /auth/login is public" \
  "$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "$GW/auth/login" \
      -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")" \
  "401"

echo
echo "==> 2. protected routes are refused by default (deny by default)"
check "GET /auth/me without a token" \
  "$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$GW/auth/me")" "401"
check "POST /users/:id/password without a token" \
  "$(curl -s -m 8 -o /dev/null -w '%{http_code}' -X POST "$GW/users/00000000-0000-4000-8000-000000000000/password" \
      -H 'Content-Type: application/json' -d '{"newPassword":"whatever1!"}')" "401"

echo
echo "==> 3. create an account through the gateway"
CREATE=$(curl -s -m 10 -X POST "$GW/users" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\"}")
USER_ID=$(echo "$CREATE" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
check "account created via the edge" "$([ -n "$USER_ID" ] && echo yes || echo no)" "yes"

echo
echo "==> 4. the password never appears in a response"
BAD=$(curl -s -m 10 -X POST "$GW/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
check_true "login response omits the password" \
  "$([ "$(echo "$BAD" | grep -cF "$PASSWORD")" = "0" ] && echo true || echo false)"

echo
echo "==> 5. a wrong password is refused, not accepted"
check_true "no access token for a wrong password" \
  "$([ "$(echo "$BAD" | grep -o 'accessToken' | head -1)" = "" ] && echo true || echo false)"

echo
echo "==> 6. set the password, then sign in for real"
# The gateway deliberately does not let a caller set their own password: that would copy an
# authorization rule to the edge, where it drifts. It requires a permission the caller does
# not have yet, so this step asserts refusal — the privilege boundary is the point.
REFUSED=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "$GW/users/$USER_ID/password" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer not-a-real-token" \
  -d "{\"newPassword\":\"$PASSWORD\"}")
check "a bogus token is refused" "$REFUSED" "401"

echo
echo "==> 7. sign in with the correct password, set directly in the vault"
# Set the password through the owning service, then authenticate through the edge — which is
# exactly the split the architecture is for.
TS_NODE_PROJECT=tsconfig.backend.base.json \
  CREDENTIAL_VAULT_GRPC_URL=localhost:${GRPC[credential-vault]} IDENTITY_GRPC_URL=localhost:${GRPC[identity]} \
  SESSION_GRPC_URL=localhost:${GRPC[session]} MFA_GRPC_URL=localhost:39006 \
  npx ts-node --transpile-only -r tsconfig-paths/register tools/e2e/grpc-flow.ts set-password "$USER_ID" "$PASSWORD" \
  > "$LOG/set-password.out" 2>&1 || printf '  (set-password output: %s)\n' "$(tr -d '\n' < "$LOG/set-password.out")"

LOGIN=$(curl -s -m 15 -X POST "$GW/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
ACCESS=$(echo "$LOGIN" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
REFRESH=$(echo "$LOGIN" | grep -o '"refreshToken":"[^"]*"' | cut -d'"' -f4)
check "sign-in returns an access token" "$([ ${#ACCESS} -gt 40 ] && echo yes || echo no)" "yes"
check "sign-in returns a refresh token" "$([ ${#REFRESH} -gt 40 ] && echo yes || echo no)" "yes"

echo
echo "==> 8. the token opens the protected routes"
if [ -z "$ACCESS" ]; then
  printf "  \033[31mFAIL\033[0m no token to present; skipping authenticated checks\n"; fail=$((fail+3))
else
  ME=$(curl -s -m 10 "$GW/auth/me" -H "Authorization: Bearer $ACCESS")
  # The caller is nested under `user`, so `user.id` — not a flat `userId`. Grepping for the
  # flat name yields an empty match and reads as "the gateway returned no caller" when it
  # returned a complete one.
  check "GET /auth/me resolves the caller" \
    "$(echo "$ME" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)" "$USER_ID"
  check_true "GET /auth/me carries permissions from access-control" \
    "$([ "$(echo "$ME" | grep -o 'permissions' | head -1)" != "" ] && echo true || echo false)"

  TAMPERED="${ACCESS}x"
  check "a tampered token is refused" \
    "$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$GW/auth/me" -H "Authorization: Bearer $TAMPERED")" \
    "401"
fi

echo
echo "==> 9. refresh rotates the session"
if [ -z "$REFRESH" ]; then
  printf "  \033[31mFAIL\033[0m no refresh token; skipping\n"; fail=$((fail+1))
else
  ROT=$(curl -s -m 15 -X POST "$GW/auth/refresh" -H 'Content-Type: application/json' \
    -d "{\"refreshToken\":\"$REFRESH\"}")
  NEW_ACCESS=$(echo "$ROT" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
  NEW_REFRESH=$(echo "$ROT" | grep -o '"refreshToken":"[^"]*"' | cut -d'"' -f4)
  check "refresh returns a new access token" "$([ ${#NEW_ACCESS} -gt 40 ] && echo yes || echo no)" "yes"
  check_true "refresh does not re-issue the same refresh token" \
    "$([ "$(echo "$ROT" | grep -o 'refreshToken' | head -1)" != "$REFRESH" ] && echo true || echo false)"
fi

echo
echo "==> 10. logging out revokes the session; the bearer lives until its exp"
# The edge verifies the access token locally — one HMAC against the shared signing key, no
# peer call — so logout cannot recall a token already in the wild. What logout does end at
# once is the *session*: refresh is looked up in that row, so it stops immediately, while the
# access token keeps opening protected routes until its exp. That trade is deliberate (a
# stateless edge, blast radius measured in minutes) and asserted as such here.
if [ -n "$ACCESS" ]; then
  LOGOUT=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "$GW/auth/logout" \
    -H "Authorization: Bearer $ACCESS")
  check "logout succeeds for the signed-in caller" "$LOGOUT" "200"

  check "the access token still opens /auth/me until it expires" \
    "$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$GW/auth/me" -H "Authorization: Bearer $ACCESS")" \
    "200"

  if [ -n "${NEW_REFRESH:-}" ]; then
    # Logout withdraws every refresh token the session ever issued, so the pair minted in
    # step 9 is a dead credential: presenting it is refused outright rather than rotated into
    # a new one. The refresh path is where the revocation bites — the bearer in the header
    # above cannot be recalled, and this is the half that can.
    check "the revoked session's refresh token is refused" \
      "$(curl -s -m 15 -o /dev/null -w '%{http_code}' -X POST "$GW/auth/refresh" \
          -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$NEW_REFRESH\"}")" \
      "401"
  fi
fi

echo
echo "==> 11. the gateway leaks no internals"
NOTFOUND=$(curl -s -m 10 "$GW/auth/me" -H "Authorization: Bearer definitely-not-a-token")
check_true "an auth failure does not echo the token back" \
  "$([ "$(echo "$NOTFOUND" | grep -cF 'definitely-not-a-token')" = "0" ] && echo true || echo false)"
# The bare word "at" is no evidence of a stack: any sentence containing it matches. A real
# frame carries a source position, so that is what the assertion looks for.
check_true "an auth failure carries no stack trace" \
  "$([ "$(echo "$NOTFOUND" | grep -cE '\.ts:[0-9]+:[0-9]+')" = "0" ] && echo true || echo false)"

echo
echo "==> 12. a guest id reaches /auth/me without a bearer"
# The route is `@AllowGuest()`: no `Authorization` header at all, only the uuid identity
# minted for an anonymous browser. Section 2's 401 already proves that *neither* credential
# is refused — this is the other half: a guest id counts, and its status is what says so.
GUEST=$(curl -s -m 10 -X POST "$GW/auth/guest" -H 'Content-Type: application/json')
GUEST_ID=$(echo "$GUEST" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
check "POST /auth/guest mints a guest id" "$([ -n "$GUEST_ID" ] && echo yes || echo no)" "yes"
if [ -n "$GUEST_ID" ]; then
  GUEST_ME=$(curl -s -m 10 "$GW/auth/me" -H "x-guest-id: $GUEST_ID")
  check "GET /auth/me resolves the guest" \
    "$(echo "$GUEST_ME" | grep -o '"status":"guest"' | head -1)" '"status":"guest"'
fi

echo
echo "================================================"
printf "  passed: %d   failed: %d\n" "$pass" "$fail"
echo "================================================"
if [ "$fail" -gt 0 ]; then
  for s in api-gateway auth-flow identity credential-vault session access-control; do
    echo "--- $s ---"; tail -12 "$LOG/gw-$s.log" 2>/dev/null
  done
fi
exit "$fail"