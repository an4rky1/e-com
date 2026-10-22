#!/usr/bin/env bash
# Prisma engine resolution for NixOS.
#
# Why this exists: Prisma publishes no `linux-nixos` binaries, so the CLI fails trying to
# fetch one. The Debian OpenSSL 3 builds ship inside `@prisma/engines` and load correctly on
# NixOS (verified: both the schema engine binary and the query engine .so execute here), so
# we point Prisma at those instead of downloading anything.
#
# Usage:  source tools/prisma-env.sh && npx prisma generate --schema prisma/identity/schema.prisma
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
ENGINES="$ROOT/node_modules/@prisma/engines"

export PRISMA_SCHEMA_ENGINE_BINARY="$ENGINES/schema-engine-debian-openssl-3.0.x"
export PRISMA_QUERY_ENGINE_LIBRARY="$ENGINES/libquery_engine-debian-openssl-3.0.x.so.node"
export PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=true