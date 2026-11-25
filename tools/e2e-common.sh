#!/usr/bin/env bash
#
# Environment common to every e2e harness: the Prisma engine pin, the throwaway secrets, the
# dev-stack Kafka settings, the log directory, the cleanup trap and the pass/fail assertion
# helpers.
#
# Sourced by tools/e2e-gateway.sh, tools/e2e-login.sh and tools/e2e-front.sh after `cd "$ROOT"`.
# The stack itself is sourced through tools/preflight-stack.sh the same way every script always
# has — the file is optional so a harness can run against a stack someone else started.

set -uo pipefail

LOG=/tmp/opencode

# The stack has to be up before a service can boot. A stopped Postgres otherwise
# surfaces as "service never started", which reads as a code failure.
shell_source="$(dirname "${BASH_SOURCE[0]}")/preflight-stack.sh"
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
# Shared by every process every harness boots: the token each gRPC peer presents and each
# gRPC controller checks. One value, because one trust boundary serves all of them.
export GRPC_SERVICE_TOKEN="$(head -c 32 /dev/urandom | base64)"

# Service pids for the cleanup trap.
PIDS=()
# `npx` runs the interpreter as its own child, so killing the recorded pid alone leaves a node
# process holding its ports — and the next run, which is free to pick the same ones, dies on
# EADDRINUSE against a process that belongs to a test that already reported success.
e2e_cleanup() {
  for pid in "${PIDS[@]:-}"; do
    pkill -P "$pid" 2>/dev/null
    kill "$pid" 2>/dev/null
  done
  wait 2>/dev/null
}
trap e2e_cleanup EXIT

pass=0; fail=0
# Assertion helpers. Scripts exit on the tally at the end — non-zero on any failure, which is
# what CI reads.
check() {
  if [ "$2" = "$3" ]; then printf "  \033[32mPASS\033[0m %s\n" "$1"; pass=$((pass+1));
  else printf "  \033[31mFAIL\033[0m %s (expected=%s got=%s)\n" "$1" "$3" "$2"; fail=$((fail+1)); fi
}
check_contains() {
  if echo "$2" | grep -qF -- "$3"; then printf "  \033[32mPASS\033[0m %s\n" "$1"; pass=$((pass+1));
  else printf "  \033[31mFAIL\033[0m %s (missing=%s)\n" "$1" "$3"; fail=$((fail+1)); fi
}
check_true() {
  if [ "$2" = "true" ]; then printf "  \033[32mPASS\033[0m %s\n" "$1"; pass=$((pass+1));
  else printf "  \033[31mFAIL\033[0m %s\n" "$1"; fail=$((fail+1)); fi
}
