#!/usr/bin/env bash
# Preflight for the end-to-end scripts: the backing stack has to be up before a service can boot.
#
# Without this, a stopped Postgres produces a wall of "identity never started" and
# "EADDRINUSE on port …" from processes that were never the problem, and the run reads as a
# code failure. A missing dependency is not a test failure, so this exits with a distinct status
# and a message that names the missing piece.
#
# Reachable is not enough: the tables also have to accept what the code writes. The databases
# outlive any single checkout, so their CHECK constraints are re-aligned here on every run --
# otherwise a value the domain gained since provisioning (the `locked` credential status, for
# one) surfaces as a Postgres error inside a login and reads as an application bug. The
# alignment runs in a child process, so its `set -e` cannot leak into the scripts that source
# this file.
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

if ! bash "$ROOT/tools/align-db-constraints.sh"; then
  echo "preflight: a CHECK constraint does not accept a value the code writes." >&2
  echo "preflight: the expected vocabulary is declared in $ROOT/tools/align-db-constraints.sh." >&2
  exit 76
fi
