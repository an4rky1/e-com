#!/usr/bin/env bash
#
# Generates every service's Prisma client from its own schema.
#
# Each service owns one schema and emits its client into `libs/domains/<service>/src/generated`
# — a directory that is deliberately not committed. Checking in ~210 MB of generated code means
# every schema edit is a five-digit-line diff nobody can review, so the client is built by this
# script instead: `npm ci && npm run generate` reproduces a working tree from a clean checkout.
#
# The engine paths come from prisma-env.sh: Prisma publishes no linux-nixos binaries, and the
# Debian builds inside `@prisma/engines` load here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=tools/prisma-env.sh
. "$ROOT/tools/prisma-env.sh"

for schema in prisma/*/schema.prisma; do
  printf 'generate: %s\n' "$schema"
  npx prisma generate --schema "$schema" >/dev/null
done
