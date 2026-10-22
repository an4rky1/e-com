#!/usr/bin/env bash
#
# Boots every service's composition root and reports whether the DI graph resolves.
#
# @remarks Unit tests never build a Nest container, so a broken provider graph — a missing
# provider, an unresolvable token, a type-only import that erased a constructor-injected
# class from `design:paramtypes` — passes 1233 tests and only fails at deploy time. This is
# the cheapest place to catch it: it needs no HTTP traffic and no assertions.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$ROOT"

# The stack has to be up before a service can boot. A stopped Postgres otherwise
# surfaces as "service never started", which reads as a code failure.
shell_source="$(dirname "$0")/preflight-stack.sh"
[ -f "$shell_source" ] && . "$shell_source"

export PRISMA_QUERY_ENGINE_LIBRARY="$ROOT/node_modules/@prisma/engines/libquery_engine-debian-openssl-3.0.x.so.node"
export PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=true
export KAFKA_ENABLED=false
export OUTBOX_ENABLED=false

# service -> database. The `identity` schema additionally holds outbox_events for every
# service, so it stands in for any service whose own database is not reachable.
declare -a SERVICES=(
  "identity:identity"
  "access-control:access_control"
  "credential-vault:credential_vault"
  "session-token:session_engine"
  "auth-gateway:auth_gateway"
  "mfa:mfa"
  "api-key:api_key"
  "account-security:account_security"
  "notification:notify"
  "audit-log:audit_log"
  "api-gateway:api_gateway"
)

# auth-gateway needs a downstream channel and a real peer for its gRPC adapters.
export IDENTITY_GRPC_URL=localhost:30001

# The api-gateway is the edge: five peer packages, each on its own host. It has no database,
# so the `DATABASE_URL` the loop hands every service is ignored rather than refused — which is
# the point of the check for this one.
export GATEWAY_IDENTITY_URL=localhost:30001
export GATEWAY_ACCESS_CONTROL_URL=localhost:30002
export GATEWAY_CREDENTIAL_VAULT_URL=localhost:30003
export GATEWAY_SESSION_TOKEN_URL=localhost:30004
export GATEWAY_AUTH_GATEWAY_URL=localhost:30005

# Secrets a service legitimately refuses to default. `mfa` fails fast without its AES key,
# which is correct: a secret that silently falls back is worse than a service that will not
# start. The check supplies a throwaway value; nothing here is durable.
export MFA_SECRET_ENCRYPTION_KEY="$(head -c 32 /dev/urandom | base64)"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
export VAULT_PEPPER="$(head -c 32 /dev/urandom | base64)"
export SESSION_ACCESS_TOKEN_SIGNING_KEY="$(head -c 32 /dev/urandom | base64)"
export SESSION_REFRESH_TOKEN_PEPPER="$(head -c 32 /dev/urandom | base64)"
export GATEWAY_JWT_SECRET="$(head -c 32 /dev/urandom | base64)"
# Every gRPC controller checks this token and every channel presents it, so a service with no
# value refuses to boot on both ends. The check supplies a throwaway one, as above.
export GRPC_SERVICE_TOKEN="$(head -c 32 /dev/urandom | base64)"

pass=0; fail=0; failed=()

for entry in "${SERVICES[@]}"; do
  svc="${entry%%:*}"; db="${entry##*:}"
  port=$(( 4100 + RANDOM % 500 ))
  log="/tmp/opencode/boot-$svc.log"

  (
    cd "$ROOT"
    DATABASE_URL="postgresql://postgres:postgres@localhost:5432/$db" \
    SERVICE_NAME="$svc" PORT="$port" \
    TS_NODE_PROJECT="apps/$svc/tsconfig.app.json" \
    timeout 45 node -r ts-node/register/transpile-only -r tsconfig-paths/register "apps/$svc/src/main.ts"
  ) > "$log" 2>&1 &

  pid=$!
  ok=""
  for _ in $(seq 1 40); do
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    if curl -sf -m 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done

  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null

  if [ -n "$ok" ]; then
    printf "  \033[32mBOOTS\033[0m  %s\n" "$svc"; pass=$((pass+1))
  else
    reason=$(sed 's/\x1b\[[0-9;]*m//g' "$log" | grep -oE "(UnknownDependenciesException|UnknownExportException|UnknownElementException|Nest can't resolve dependencies of the [A-Za-z]+|Cannot find module '[^']+'|is not a part of the currently processed module)" | head -1)
    printf "  \033[31mFAILS\033[0m  %-20s %s\n" "$svc" "${reason:-see $log}"; fail=$((fail+1)); failed+=("$svc")
  fi
done

echo
echo "================================================"
printf "  booted: %d   failed: %d\n" "$pass" "$fail"
[ "$fail" -gt 0 ] && printf "  failing: %s\n" "${failed[*]}"
echo "================================================"
exit 0