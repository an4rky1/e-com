#!/usr/bin/env bash
#
# Applies every service's Prisma migrations to the database that service writes to.
#
# Why this exists as a script rather than as a loop in the workflow: the mapping from directory
# name to database name is not the identity (`notification` writes to `notify`, `session`
# to `session_engine`), and a clean checkout has no idea about it. The mapping lives once, in
# `tools/service-dbs.pairs`, next to the other tools that need it — an ECS task that provisions
# the databases and the one that fills them read the same file, so a new service cannot land in
# one and not the other, and the symptom would be a service booting against another service's
# schema. Here `bash tools/migrate.sh` on a laptop and the CI step run the same mapping, with
# the same engine paths — Prisma publishes no linux-nixos binaries, so this sources
# prisma-env.sh exactly as `npm run generate` does.
#
# Nothing else in this repository creates tables. `prisma db push` is not used, and the dev
# databases were provisioned by hand and are kept in step by these migrations, so a database that
# has never been migrated fails the first service that touches it with
# `relation "users" does not exist`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=tools/prisma-env.sh
. "$ROOT/tools/prisma-env.sh"

# The same host and credentials the end-to-end scripts use: a dev database is the podman
# container from docker-compose.yml, a CI database is the `postgres` service container, and both
# answer on localhost:5432 as `postgres`. Overridable for anyone whose stack differs.
POSTGRES_URL_PREFIX="${POSTGRES_URL_PREFIX:-postgresql://postgres:postgres@localhost:5432}"

while read -r svc db; do
  [ -n "${svc:-}" ] || continue
  case "$svc" in \#*) continue ;; esac # header comment in the pairs file
  printf 'migrate: %s -> %s\n' "$svc" "$db"
  DATABASE_URL="$POSTGRES_URL_PREFIX/$db" \
    npx prisma migrate deploy --schema "prisma/$svc/schema.prisma"
done < "$ROOT/tools/service-dbs.pairs"
