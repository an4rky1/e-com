#!/usr/bin/env bash
# Preflight for the end-to-end scripts: the backing stack has to be up before a service can boot.
#
# Without this, a stopped Postgres produces a wall of "identity never started" and
# "EADDRINUSE on port …" from processes that were never the problem, and the run reads as a
# code failure. A missing dependency is not a test failure, so this exits with a distinct status
# and a message that names the missing piece.
#
# Reachable is not enough for a database that is merely up: it also has to hold the schema the
# code reads and writes. It does not get checked here, because nothing may patch the schema on the
# side any more — the vocabularies live in Postgres enum types that only `prisma migrate deploy`
# applies (see `.github/workflows/ci.yml`), and a database left behind by an older checkout fails
# loudly at boot instead of being silently repaired on every run.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

require() {
  local name="$1" check="$2"
  if ! eval "$check" >/dev/null 2>&1; then
    echo "preflight: $name is not reachable." >&2
    echo "preflight: start the stack with:  podman compose -f $ROOT/docker-compose.yml up -d" >&2
    exit 75
  fi
}

require "postgres" "podman exec auth-postgres pg_isready -U postgres"
require "redis" "podman exec auth-redis redis-cli ping"
require "redpanda" "podman exec auth-redpanda rpk cluster health"
