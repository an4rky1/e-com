#!/usr/bin/env bash
#
# Login flow end to end, across five services and two transports.
#
#   identity (REST)          create the account
#   credential-vault(gRPC)   store the password
#   account-security (gRPC)  count the attempts, lock the account
#   auth-gateway   (gRPC)    open a login flow, advance it with the password
#   session-token  (gRPC)    validate the issued access token
#
# Every hop is a real socket to a real process. Unit tests inject ports and therefore cannot
# catch the failures this is written for: a channel pointed at the wrong host, a proto package
# loaded but not addressed, or a method path naming a service nobody declared.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$ROOT"

# The stack has to be up before a service can boot. A stopped Postgres otherwise
# surfaces as "service never started", which reads as a code failure.
shell_source="$(dirname "$0")/preflight-stack.sh"
[ -f "$shell_source" ] && . "$shell_source"

export PRISMA_QUERY_ENGINE_LIBRARY="$ROOT/node_modules/@prisma/engines/libquery_engine-debian-openssl-3.0.x.so.node"
export PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=true
export KAFKA_BROKERS=localhost:9092
export KAFKA_ENABLED=true
export KAFKAJS_NO_PARTITIONER_WARNING=1
export OUTBOX_POLL_INTERVAL_MS=300

# Throwaway secrets. These are throwaway on purpose — nothing durable is created here.
export VAULT_PEPPER="$(head -c 32 /dev/urandom | base64)"
export SESSION_ACCESS_TOKEN_SIGNING_KEY="$(head -c 32 /dev/urandom | base64)"
export SESSION_REFRESH_TOKEN_PEPPER="$(head -c 32 /dev/urandom | base64)"
export GATEWAY_JWT_SECRET="$(head -c 32 /dev/urandom | base64)"
export MFA_SECRET_ENCRYPTION_KEY="$(head -c 32 /dev/urandom | base64)"
# Shared by every process this script boots: the token each gRPC peer presents and each gRPC
# controller checks.
export GRPC_SERVICE_TOKEN="$(head -c 32 /dev/urandom | base64)"

# Two randomised blocks, drawn independently: a fixed HTTP block and a fixed gRPC block derived
# from it meant any other run that happened to share the base collided on every port, and the
# collision read as "credential-vault is down" in a run whose own code had not changed. A port is
# not a configuration value worth pinning.
HTTP_BASE=$(( 3800 + (RANDOM % 300) * 10 ))
GRPC_BASE=$(( 4800 + (RANDOM % 300) * 10 ))
IDENTITY_PORT=$(( HTTP_BASE + 1 ))
IDENTITY_GRPC=$(( GRPC_BASE + 1 ))
VAULT_PORT=$(( HTTP_BASE + 3 ))
VAULT_GRPC=$(( GRPC_BASE + 3 ))
SESSION_PORT=$(( HTTP_BASE + 4 ))
SESSION_GRPC=$(( GRPC_BASE + 4 ))
GATEWAY_PORT=$(( HTTP_BASE + 5 ))
GATEWAY_GRPC=$(( GRPC_BASE + 5 ))
SECURITY_PORT=$(( HTTP_BASE + 7 ))
SECURITY_GRPC=$(( GRPC_BASE + 7 ))

LOG=/tmp/opencode
FLOW="$ROOT/tools/e2e/grpc-flow.ts"

# account-security counts failures in Redis, and its per-address counter is the one the
# lockout section below depends on. A randomised address keeps a previous run's failures out
# of this one: nothing clears that counter on a successful sign-in, so a fixed address would
# start the next run already part-way to its budget.
export ACCOUNT_SECURITY_REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
export E2E_CLIENT_IP="203.0.113.$(( RANDOM % 254 + 1 ))"

pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then printf "  \033[32mPASS\033[0m %s\n" "$1"; pass=$((pass+1));
  else printf "  \033[31mFAIL\033[0m %s (expected=%s got=%s)\n" "$1" "$3" "$2"; fail=$((fail+1)); fi
}
check_true() {
  if [ "$2" = "true" ]; then printf "  \033[32mPASS\033[0m %s\n" "$1"; pass=$((pass+1));
  else printf "  \033[31mFAIL\033[0m %s\n" "$1"; fail=$((fail+1)); fi
}

PIDS=()
# `npx` runs the interpreter as its own child, so killing only the recorded pid leaves a node
# process bound to its port — and the next run, which is free to pick the same port, then fails
# with EADDRINUSE against a process from a run that already reported success.
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    pkill -P "$pid" 2>/dev/null
    kill "$pid" 2>/dev/null
  done
  wait 2>/dev/null
}
trap cleanup EXIT

boot() { # name port db grpc_port
  local name="$1" port="$2" db="$3" grpc="$4"
  DATABASE_URL="postgresql://postgres:postgres@localhost:5432/$db" \
  SERVICE_NAME="$name" PORT="$port" GRPC_URL="0.0.0.0:$grpc" \
  IDENTITY_GRPC_URL="localhost:$IDENTITY_GRPC" \
  CREDENTIAL_VAULT_GRPC_URL="localhost:$VAULT_GRPC" \
  SESSION_TOKEN_GRPC_URL="localhost:$SESSION_GRPC" \
  MFA_GRPC_URL="localhost:39006" \
  ACCOUNT_SECURITY_GRPC_URL="localhost:$SECURITY_GRPC" \
  TS_NODE_PROJECT="apps/$name/tsconfig.app.json" \
    npx ts-node --transpile-only -r tsconfig-paths/register "apps/$name/src/main.ts" \
    > "$LOG/login-$name.log" 2>&1 &
  PIDS+=($!)
}

# The client must address the same ports the services were booted on; leaving these unset
# silently falls back to the production defaults and every call gets ECONNREFUSED.
export IDENTITY_GRPC_URL="localhost:$IDENTITY_GRPC"
export CREDENTIAL_VAULT_GRPC_URL="localhost:$VAULT_GRPC"
export SESSION_TOKEN_GRPC_URL="localhost:$SESSION_GRPC"
export MFA_GRPC_URL="localhost:39006"
export AUTH_GATEWAY_GRPC_URL="localhost:$GATEWAY_GRPC"

flow() { # step arg1 arg2
  local out err
  out=$(TS_NODE_PROJECT="$ROOT/tsconfig.backend.base.json" \
        npx ts-node --transpile-only -r tsconfig-paths/register "$FLOW" "$@" 2>/tmp/opencode/flow-err.log)
  if [ -z "$out" ]; then
    # Surface the reason once: a silently empty response is the hardest failure to debug,
    # because every assertion downstream just reports "missing".
    echo "{"error":"$(tr '\n' ' ' < /tmp/opencode/flow-err.log | tail -c 400)"}"
    return
  fi
  echo "$out"
}

echo "==> booting identity, credential-vault, session-token, account-security, auth-gateway"
boot identity       "$IDENTITY_PORT" identity       "$IDENTITY_GRPC"
boot credential-vault "$VAULT_PORT"  credential_vault "$VAULT_GRPC"
boot session-token  "$SESSION_PORT"  session_engine  "$SESSION_GRPC"
boot account-security "$SECURITY_PORT" account_security "$SECURITY_GRPC"
boot auth-gateway   "$GATEWAY_PORT"  auth_gateway    "$GATEWAY_GRPC"

# Wait for every service, not just the first: booting five processes takes longer than one,
# and probing early reports services that are merely still starting as unhealthy.
ready=0
for _ in $(seq 1 60); do
  up=0
  for port in "$IDENTITY_PORT" "$VAULT_PORT" "$SESSION_PORT" "$SECURITY_PORT" "$GATEWAY_PORT"; do
    curl -sf -m 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1 && up=$((up+1))
  done
  if [ "$up" -eq 5 ]; then ready=1; break; fi
  sleep 1
done
[ "$ready" -eq 1 ] || echo "  (not every service came up in time; continuing to report)"

echo
echo "==> 1. all five services are up"
for entry in "identity:$IDENTITY_PORT" "credential-vault:$VAULT_PORT" \
             "session-token:$SESSION_PORT" "account-security:$SECURITY_PORT" \
             "auth-gateway:$GATEWAY_PORT"; do
  check "${entry%%:*} healthy" \
    "$(curl -s -m 5 "http://127.0.0.1:${entry##*:}/health" | grep -o '"status":"[a-z]*"' | cut -d'"' -f4)" \
    "up"
done

EMAIL="login-$RANDOM-$$@example.test"
PASSWORD='Str0ng-Passw0rd!x'

echo
echo "==> 2. register over REST"
REG=$(curl -s -m 8 -X POST "http://127.0.0.1:$IDENTITY_PORT/users" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"displayName\":\"Login E2E\"}")
USER_ID=$(echo "$REG" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
check "account created" "$([ -n "$USER_ID" ] && echo yes || echo no)" "yes"

echo
echo "==> 3. credential-vault stores the password (gRPC)"
SET=$(flow set-password "$USER_ID" "$PASSWORD")
check "password stored" "$(echo "$SET" | grep -o '"ok":true' || echo false)" '"ok":true'

echo
echo "==> 4. auth-gateway opens a login flow (gRPC)"
START=$(flow start-flow "$EMAIL")
FLOW_ID=$(echo "$START" | grep -o '"flowId":"[^"]*"' | cut -d'"' -f4)
STATE=$(echo "$START" | grep -o '"state":"[^"]*"' | cut -d'"' -f4)
check "flow opened" "$([ -n "$FLOW_ID" ] && echo yes || echo no)" "yes"
check "flow awaits a credential" "$STATE" "awaiting_credential"

echo
echo "==> 5. a wrong password is refused, on its own flow"
BAD_FLOW=$(flow start-flow "$EMAIL" | grep -o '"flowId":"[^"]*"' | cut -d'"' -f4)
BAD=$(flow advance-flow "$BAD_FLOW" 'wrong-password')
BAD_STATE=$(echo "$BAD" | grep -o '"state":"[^"]*"' | cut -d'"' -f4)
BAD_TOKEN=$(echo "$BAD" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
check "no access token issued" "$([ -z "$BAD_TOKEN" ] && echo none || echo "$BAD_TOKEN")" "none"
check_true "flow did not complete" "$([ "$BAD_STATE" != "completed" ] && echo true || echo false)"

echo
echo "==> 6. the correct password completes a fresh flow (gRPC)"
# A new flow on purpose: the previous one is spent, and reusing it would test recovery
# semantics rather than the happy path a real sign-in follows.
FLOW_ID=$(flow start-flow "$EMAIL" | grep -o '"flowId":"[^"]*"' | cut -d'"' -f4)
ADV=$(flow advance-flow "$FLOW_ID" "$PASSWORD")
STATE=$(echo "$ADV" | grep -o '"state":"[^"]*"' | cut -d'"' -f4)
ACCESS=$(echo "$ADV" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
REFRESH=$(echo "$ADV" | grep -o '"refreshToken":"[^"]*"' | cut -d'"' -f4)
check "flow completed" "$STATE" "completed"
check "access token issued" "$([ ${#ACCESS} -gt 40 ] && echo yes || echo no)" "yes"
check "refresh token issued" "$([ ${#REFRESH} -gt 40 ] && echo yes || echo no)" "yes"
check "refresh token is not the access token" "$([ "$ACCESS" != "$REFRESH" ] && echo yes || echo no)" "yes"

echo
echo "==> 7. session-token validates the token (gRPC)"
VAL=$(flow validate "$ACCESS")
check "token is valid" "$(echo "$VAL" | grep -o '"valid":true' || echo false)" '"valid":true'
check "resolves to the right user" "$(echo "$VAL" | grep -o '"userId":"[^"]*"' | cut -d'"' -f4)" "$USER_ID"
check "carries the email" "$(echo "$VAL" | grep -o '"email":"[^"]*"' | cut -d'"' -f4)" "$EMAIL"

echo
echo "==> 8. a garbage token does not validate"
JUNK=$(flow validate "not-a-real-token")
check_true "garbage token rejected" \
  "$([ "$(echo "$JUNK" | grep -o '"valid":true')" = "" ] && echo true || echo false)"

echo
echo "==> 9. the session is persisted in session_engine"
SESSIONS=$(podman exec auth-postgres psql -U postgres -d session_engine -tAc \
  "SELECT count(*) FROM sessions WHERE user_id='$USER_ID'" 2>/dev/null | tr -d ' ')
check "session row written" "$SESSIONS" "1"
# `refresh_tokens.session_id` is the session, not the user — joining through `sessions` is
# the only way to ask this question about a specific account.
check "refresh token stored as a digest, never plaintext" \
  "$(podman exec auth-postgres psql -U postgres -d session_engine -tAc \
     "SELECT count(*) FROM refresh_tokens rt JOIN sessions s ON s.id = rt.session_id
      WHERE s.user_id='$USER_ID' AND rt.token_digest IS NOT NULL AND rt.token_digest <> '$REFRESH'" 2>/dev/null | tr -d ' ')" \
  "1"

echo
echo "==> 10. the login published session events to Kafka"
for _ in $(seq 1 20); do
  [ "$(podman exec auth-postgres psql -U postgres -d auth_gateway -tAc \
      "SELECT count(*) FROM outbox_events WHERE aggregate_id='$FLOW_ID'" 2>/dev/null | tr -d ' ')" != "0" ] && break
  sleep 1
done
check "auth-gateway recorded flow events" \
  "$(podman exec auth-postgres psql -U postgres -d auth_gateway -tAc \
     "SELECT count(*) FROM outbox_events WHERE aggregate_id='$FLOW_ID' AND status='published'" 2>/dev/null | tr -d ' ')" \
  "3"

echo
echo "==> 11. five wrong passwords lock the account"
# Every attempt needs a fresh flow: a refusal ends the walk it happened on, and the budget
# that matters is account-security's, which spans flows rather than living inside one.
for i in 1 2 3 4; do
  LOCK_FLOW=$(flow start-flow "$EMAIL" | grep -o '"flowId":"[^"]*"' | cut -d'"' -f4)
  RES=$(flow advance-flow "$LOCK_FLOW" "wrong-password-$i")
  check "wrong password #$i is refused" \
    "$(echo "$RES" | grep -o '"state":"[^"]*"' | cut -d'"' -f4)" "failed"
  check "wrong password #$i does not lock yet" \
    "$(echo "$RES" | grep -o '"locked":true' || echo none)" "none"
done

LOCK_FLOW=$(flow start-flow "$EMAIL" | grep -o '"flowId":"[^"]*"' | cut -d'"' -f4)
RES=$(flow advance-flow "$LOCK_FLOW" "wrong-password-5")
check "the fifth wrong password locks the account" \
  "$(echo "$RES" | grep -o '"locked":true' || echo none)" '"locked":true'
check "the locked attempt is still a refused flow, not an error" \
  "$(echo "$RES" | grep -o '"state":"[^"]*"' | cut -d'"' -f4)" "failed"
RETRY=$(echo "$RES" | grep -o '"retryAfterSeconds":[0-9]*' | cut -d: -f2)
check "the wait comes back with the lock" \
  "$([ -n "$RETRY" ] && [ "$RETRY" -gt 0 ] && echo yes || echo no)" "yes"

echo
echo "==> 12. the correct password is refused while the account is locked"
# The point of a lockout, as opposed to a nicer message: the credential itself stops being
# verifiable, so knowing the password is no longer enough to get past the window.
START_RES=$(flow start-flow "$EMAIL")
LOCK_FLOW=$(printf '%s' "$START_RES" | grep -o '"flowId":"[^"]*"' | cut -d'"' -f4)
RES=$(flow advance-flow "$LOCK_FLOW" "$PASSWORD")
# The loader runs with `defaults: true`, so an unset field arrives as `''` and grepping the
# key would read that empty string as a token. The value is what is being asserted.
LOCK_TOKEN=$(echo "$RES" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
check "no token is issued to a locked account" \
  "$([ -n "$LOCK_TOKEN" ] && echo issued || echo none)" "none"
check "the correct password does not open the lock" \
  "$(echo "$RES" | grep -o '"state":"[^"]*"' | cut -d'"' -f4)" "failed"
check "the refusal still names the lock" \
  "$(echo "$RES" | grep -o '"locked":true' || echo none)" '"locked":true'

echo
echo "================================================"
printf "  passed: %d   failed: %d\n" "$pass" "$fail"
echo "================================================"
if [ "$fail" -gt 0 ]; then
  for s in identity credential-vault session-token account-security auth-gateway; do
    echo "--- $s ---"; tail -12 "$LOG/login-$s.log"
  done
fi
exit "$fail"