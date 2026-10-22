#!/usr/bin/env bash
#
# The browser, end to end.
#
# Everything else is driven over curl or gRPC directly. This boots the same six services
# `tools/e2e-gateway.sh` boots — the front is a *client* of the edge, so it cannot need fewer
# peers than the edge itself does — then hands the browser to Playwright and asserts only what
# a browser can catch: that the front proxies `/api/auth/*` to the gateway, that a refused
# sign-in is shown rather than swallowed, and that a token lands where the signed-in view uses
# it.
#
# The account and its password are created out of band, exactly as the gateway harness does it.
# The gateway refuses `POST /users/:id/password` to the account's own caller — that refusal is
# the privilege boundary — so a front cannot sign anyone in without a password that already
# exists somewhere else.
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

LOG=/tmp/opencode

# Two randomised blocks, drawn independently, for the same reason the gateway harness does
# it: a fixed block collides with a concurrent run and the collision reads as a service being
# down in a run whose own code had not changed.
BASE=$(( 39000 + (RANDOM % 300) * 10 ))
GRPC_BASE=$(( 49000 + (RANDOM % 300) * 10 ))
GW_PORT=$BASE
declare -A PORT=( [identity]=$(( BASE + 1 )) [access-control]=$(( BASE + 2 )) \
                  [credential-vault]=$(( BASE + 3 )) [session-token]=$(( BASE + 4 )) \
                  [auth-gateway]=$(( BASE + 5 )) )
# Derived from the scalar BASE, not from ${PORT[...]}: inside $(( )) bash parses an array
# subscript as an arithmetic expression, so ${PORT[access-control]} reads as the difference
# of two unset variables and trips `set -u`.
declare -A GRPC=( [identity]=$(( GRPC_BASE + 1 )) [access-control]=$(( GRPC_BASE + 2 )) \
                  [credential-vault]=$(( GRPC_BASE + 3 )) [session-token]=$(( GRPC_BASE + 4 )) \
                  [auth-gateway]=$(( GRPC_BASE + 5 )) )

# The front proxies to the gateway through its own origin, so this address is the harness's
# and the browser's, never a peer's. Exported because Playwright reads it the same way.
export GATEWAY_URL="http://127.0.0.1:$GW_PORT"

# The spec's beforeAll sets the password through the same helper the bash harnesses use, and
# that helper dials peers by address. Left unset it falls back to the compiled-in defaults
# (`localhost:31003`), which point at ports nobody is listening on — and the failure is a
# plausible-looking "connection refused" during sign-in rather than a missing variable.
export IDENTITY_GRPC_URL="localhost:${GRPC[identity]}"
export CREDENTIAL_VAULT_GRPC_URL="localhost:${GRPC[credential-vault]}"
export SESSION_TOKEN_GRPC_URL="localhost:${GRPC[session-token]}"
export AUTH_GATEWAY_GRPC_URL="localhost:${GRPC[auth-gateway]}"
export MFA_GRPC_URL="localhost:39006"

# On NixOS the browsers Playwright downloads do not link against the system: the shared
# libraries they need are not there. A chromium built by nixpkgs carries its own. Found on
# PATH first (`environment.systemPackages`), then via nix-build into a stable tmp path so a
# missing binary is a slow first run, not a failed one.
if [ -z "${CHROMIUM_EXECUTABLE:-}" ]; then
  if command -v chromium >/dev/null 2>&1; then
    CHROMIUM_EXECUTABLE="$(command -v chromium)"
  elif command -v nix-build >/dev/null 2>&1; then
    if [ ! -x /tmp/opencode/chromium-result/bin/chromium ]; then
      nix-build -E 'with import <nixpkgs> {}; chromium' \
        -o /tmp/opencode/chromium-result >/dev/null 2>&1
    fi
    [ -x /tmp/opencode/chromium-result/bin/chromium ] && \
      CHROMIUM_EXECUTABLE=/tmp/opencode/chromium-result/bin/chromium
  fi
fi
if [ -n "${CHROMIUM_EXECUTABLE:-}" ]; then
  export CHROMIUM_EXECUTABLE
  echo "==> chromium: $CHROMIUM_EXECUTABLE"
fi

PIDS=()
# `npx` runs the interpreter as its own child, so killing only the recorded pid leaves a node
# process bound to its port — and the next run, free to pick the same ones, dies on
# EADDRINUSE against a process that belongs to a test that already reported success.
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    pkill -P "$pid" 2>/dev/null
    kill "$pid" 2>/dev/null
  done
  wait 2>/dev/null
}
trap cleanup EXIT

# port pairs: http, grpc (the gateway fans out over gRPC to every peer)
boot() { # name http_port grpc_port db
  local name="$1" port="$2" grpc="$3" db="$4"
  DATABASE_URL="postgresql://postgres:postgres@localhost:5432/$db" \
  SERVICE_NAME="$name" PORT="$port" GRPC_URL="0.0.0.0:$grpc" \
  IDENTITY_GRPC_URL="localhost:${GRPC[identity]}" \
  ACCESS_CONTROL_GRPC_URL="localhost:${GRPC[access-control]}" \
  CREDENTIAL_VAULT_GRPC_URL="localhost:${GRPC[credential-vault]}" \
  SESSION_TOKEN_GRPC_URL="localhost:${GRPC[session-token]}" \
  AUTH_GATEWAY_GRPC_URL="localhost:${GRPC[auth-gateway]}" \
  MFA_GRPC_URL="localhost:39006" \
  TS_NODE_PROJECT="apps/$name/tsconfig.app.json" \
    npx ts-node --transpile-only -r tsconfig-paths/register "apps/$name/src/main.ts" \
    > "$LOG/front-$name.log" 2>&1 &
  PIDS+=($!)
}

for name in identity access-control credential-vault session-token auth-gateway api-gateway; do
  : > "$LOG/front-$name.log"
done

echo "==> booting identity, access-control, credential-vault, session-token, auth-gateway, api-gateway"
for name in identity access-control credential-vault session-token auth-gateway; do
  case "$name" in
    identity)          db=identity ;;
    access-control)    db=access_control ;;
    credential-vault)  db=credential_vault ;;
    session-token)     db=session_engine ;;
    auth-gateway)      db=auth_gateway ;;
  esac
  boot "$name" "${PORT[$name]}" "${GRPC[$name]}" "$db"
done

# The gateway owns no database: it has no Prisma client and no DATABASE_URL, which is the
# property that keeps business state from forking at the edge.
DATABASE_URL="" SERVICE_NAME=api-gateway PORT="$GW_PORT" \
  REDIS_URL="${REDIS_URL:-redis://localhost:6379}" \
  GATEWAY_IDENTITY_URL=localhost:${GRPC[identity]} \
  GATEWAY_ACCESS_CONTROL_URL=localhost:${GRPC[access-control]} \
  GATEWAY_CREDENTIAL_VAULT_URL=localhost:${GRPC[credential-vault]} \
  GATEWAY_SESSION_TOKEN_URL=localhost:${GRPC[session-token]} \
  GATEWAY_AUTH_GATEWAY_URL=localhost:${GRPC[auth-gateway]} \
  TS_NODE_PROJECT=apps/api-gateway/tsconfig.app.json \
    npx ts-node --transpile-only -r tsconfig-paths/register apps/api-gateway/src/main.ts \
    > "$LOG/front-api-gateway.log" 2>&1 &
  PIDS+=($!)

GW="$GATEWAY_URL"
ready=0
for _ in $(seq 1 70); do
  up=0
  for p in "$GW_PORT" "${PORT[identity]}" "${PORT[access-control]}" \
           "${PORT[credential-vault]}" "${PORT[session-token]}" "${PORT[auth-gateway]}"; do
    curl -sf -m 2 "http://127.0.0.1:$p/health" >/dev/null 2>&1 && up=$((up+1))
  done
  if [ "$up" -eq 6 ]; then ready=1; break; fi
  sleep 1
done
[ "$ready" -eq 1 ] || echo "  (not every service came up in time; results below may be partial)"

echo
echo "==> running Playwright against the front on :3000"
# The account, the password and the two assertions that need them all live in the spec's
# beforeAll: a bash step here would mean the same email and password written in two files,
# and the two drifting is a test that fails for a reason no assertion describes. The front is
# started by Playwright's own webServer block, so the two only have to agree on where the
# gateway is.
# The exit status of the browser run, kept out of an `if` so a failing Playwright still
# reaches the summary below — and so a failure cannot be reported as a pass.
playwright_failed=0
if BASE_URL="http://localhost:3000" GATEWAY_URL="$GATEWAY_URL" \
     npx playwright test --config apps/front-e2e/playwright.config.mts --project=chromium \
     > "$LOG/front-playwright.log" 2>&1; then
  echo "  Playwright passed"
else
  playwright_failed=1
  echo "  Playwright FAILED"
  sed 's/\x1b\[[0-9;]*m//g' "$LOG/front-playwright.log" | tail -40
fi

echo
echo "================================================"
if [ "$ready" -eq 1 ]; then
  echo "  stack healthy; see Playwright output above"
else
  echo "  stack did not come up cleanly; see $LOG/front-*.log"
fi
echo "================================================"
if [ "$ready" -ne 1 ]; then
  for s in identity access-control credential-vault session-token auth-gateway api-gateway; do
    echo "--- $s ---"; tail -12 "$LOG/front-$s.log" 2>/dev/null
  done
  exit 1
fi
# The stack being healthy and the browser passing are independent outcomes: a healthy stack
# with a failing assertion is a real failure, and exiting on the stack's status alone would
# report it as success.
exit "$playwright_failed"
