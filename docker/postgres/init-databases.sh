#!/bin/bash
# One database per stateful microservice. Table ownership is per service: cross-service
# reads go over gRPC, never over a shared schema.
#
# Idempotent on purpose — this volume already held databases from an earlier stack and
# re-running init must not destroy them.
set -euo pipefail

for db in identity credential_vault mfa api_key session_engine access_control \
          auth_gateway account_security notify; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
    SELECT 'CREATE DATABASE $db OWNER $POSTGRES_USER'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$db')\gexec
EOSQL
  echo "  database ready: $db"
done