#!/usr/bin/env bash
#
# Creates the ten service databases on the shared RDS instance.
#
# Runs *inside* an ECS task (`tools/aws-ecs-task.sh db-init` puts it there): the databases
# live in a private subnet, so the only caller that can reach them is a task that already
# runs in the VPC. `DATABASE_URL` is injected by the task definition and points at this
# task's own database — every database shares one instance and one master user, so the
# maintenance database is the same URL with the path swapped, no secret needs to exist for
# it, and the script never sees a password it was not given.
#
# Idempotent, like `docker/postgres/init-databases.sh` on a laptop: an existing database is
# reported, not an error. `prisma migrate deploy` creates its own database when missing, so
# this script is for provisioning ahead of migrations, not a prerequisite of them.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "error: DATABASE_URL is not set — this script expects to run inside an ECS task" >&2
  exit 1
fi

# postgresql://user:pass@host:5432/<database> -> .../postgres. The generated URLs carry no
# query string (the password is special=false by construction), so stripping the last path
# segment is the whole edit.
MAINTENANCE_URL="${DATABASE_URL%/*}/postgres"

status=0
while read -r svc db; do
  [ -n "${svc:-}" ] || continue
  case "$svc" in \#*) continue ;; esac # header comment in the pairs file

  # One statement per invocation on purpose: `prisma db execute` sends the whole script as a
  # single command, and PostgreSQL refuses CREATE DATABASE inside the implicit transaction
  # that wraps a multi-statement string.
  if err=$(printf 'CREATE DATABASE %s' "$db" | npx prisma db execute --url "$MAINTENANCE_URL" --stdin 2>&1); then
    printf 'created: %s\n' "$db"
  elif printf '%s' "$err" | grep -q 'already exists'; then
    printf 'exists:  %s\n' "$db"
  else
    printf 'failed:  %s\n%s\n' "$db" "$err" >&2
    status=1
  fi
done < "$ROOT/tools/service-dbs.pairs"

exit $status
