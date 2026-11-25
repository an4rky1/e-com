#!/usr/bin/env bash
#
# Boots every service as a background daemon and waits for each `/health` to answer.
#
# Uses the workspace defaults — identity on 3001, access-control on 3002, and so on; gRPC on the
# HTTP+10000 binds. Peer addresses are set to the real binds rather than the app modules'
# `localhost:31001`-style defaults, which describe the e2e harness's randomised ports: nothing
# under the default boots a peer by itself.
#
# The backing stack must already be up: `podman compose -f docker-compose.yml up -d`.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$ROOT"

export PRISMA_QUERY_ENGINE_LIBRARY="$ROOT/node_modules/@prisma/engines/libquery_engine-debian-openssl-3.0.x.so.node"
export PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=true
export KAFKA_BROKERS=localhost:9092
export KAFKA_ENABLED=true
export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"

# Services refuse to default these on purpose; `tools/boot-check.sh` supplies the same throwaway
# values, and so does this one — nothing started here is durable.
export MFA_SECRET_ENCRYPTION_KEY="$(head -c 32 /dev/urandom | base64)"
export VAULT_PEPPER="$(head -c 32 /dev/urandom | base64)"
export SESSION_ACCESS_TOKEN_SIGNING_KEY="$(head -c 32 /dev/urandom | base64)"
export SESSION_REFRESH_TOKEN_PEPPER="$(head -c 32 /dev/urandom | base64)"
export GATEWAY_JWT_SECRET="$(head -c 32 /dev/urandom | base64)"
export GRPC_SERVICE_TOKEN="$(head -c 32 /dev/urandom | base64)"

declare -A PORT=(
  [identity]=3001 [access-control]=3002 [credential-vault]=3003 [session]=3004
  [auth-flow]=3005 [mfa]=3006 [api-key]=3007 [account-security]=3008
  [notification]=3009 [audit-log]=3010 [catalog]=3011 [cart]=3012
  [inventory]=3013 [billing]=3014 [order]=3015 [api-gateway]=4000
)

LOG_DIR="/tmp/opencode/services"
mkdir -p "$LOG_DIR"

BOOT() { # svc db [ENV=VAL ...]
  local svc="$1" db="$2"
  shift 2
  # Already healthy — re-running the script must not try to re-bind a running port.
  if curl -sf -m 2 "http://127.0.0.1:${PORT[$svc]}/health" >/dev/null 2>&1; then
    return 0
  fi
  nohup env \
    DATABASE_URL="postgresql://postgres:postgres@localhost:5432/$db" \
    SERVICE_NAME="$svc" \
    PORT="${PORT[$svc]}" \
    "$@" \
    TS_NODE_PROJECT="apps/$svc/tsconfig.app.json" \
    node -r ts-node/register/transpile-only -r tsconfig-paths/register "apps/$svc/src/main.ts" \
    > "$LOG_DIR/$svc.log" 2>&1 &
  echo "$!" > "$LOG_DIR/$svc.pid"
}

BOOT identity identity
BOOT access-control access_control
BOOT account-security account_security
BOOT credential-vault credential_vault
BOOT session session_engine
BOOT mfa mfa
BOOT api-key api_key
BOOT audit-log audit_log
BOOT notification notify
BOOT catalog catalog
BOOT cart cart
BOOT inventory inventory
BOOT billing billing
BOOT order order
BOOT api-gateway api_gateway \
  GATEWAY_IDENTITY_URL=localhost:13001 \
  GATEWAY_ACCESS_CONTROL_URL=localhost:13002 \
  GATEWAY_CREDENTIAL_VAULT_URL=localhost:13003 \
  GATEWAY_SESSION_URL=localhost:13004 \
  GATEWAY_AUTH_FLOW_URL=localhost:13005
# auth-flow calls its peers directly; its own app.module defaults point at the e2e harness's
# randomised ports, so the real binds are set explicitly here.
BOOT auth-flow auth_flow \
  IDENTITY_GRPC_URL=localhost:13001 \
  CREDENTIAL_VAULT_GRPC_URL=localhost:13003 \
  SESSION_GRPC_URL=localhost:13004 \
  MFA_GRPC_URL=localhost:13006 \
  ACCOUNT_SECURITY_GRPC_URL=localhost:13008

echo "==> booted; waiting for /health on every service"
fail=0
for svc in identity access-control credential-vault session auth-flow mfa api-key \
           account-security notification audit-log catalog cart inventory billing order \
           api-gateway; do
  port="${PORT[$svc]}"
  ok=""
  for _ in $(seq 1 60); do
    if ! kill -0 "$(cat "$LOG_DIR/$svc.pid" 2>/dev/null)" 2>/dev/null; then break; fi
    if curl -sf -m 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
  if [ -n "$ok" ]; then printf "  BOOTS  %-18s http %s\n" "$svc" "$port"; else
    printf "  FAILS  %-18s — see $LOG_DIR/$svc.log\n" "$svc"; fail=$((fail+1)); fi
done
exit "$fail"
