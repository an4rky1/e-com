#!/usr/bin/env bash
# Brings the hand-written CHECK constraints back in step with the vocabulary the code writes.
#
# The databases were provisioned from DDL that predates parts of the domain: `credentials`
# never allowed the `locked` status a lockout produces, `security_signals` still names signals
# an older design used, and `mfa_factors`/`api_keys` are missing states that have since become
# reachable. A constraint is the safety net for exactly that kind of drift, so the fix is to
# move the constraint to the code rather than to bend the code to the constraint.
#
# Each table is altered in a single transaction -- the drop and the add succeed or fail
# together, so a rejected ADD can never leave a table with no check at all. Every statement is
# an `IF EXISTS`/plain re-ADD, so a second run is a no-op and this is safe to run on each
# preflight. Values no code path can produce are dropped along the way: a superseded `rotated`
# status and the `sms`/`email`/`webauthn` methods would only let the database accept rows the
# application could never explain.
#
# Exits non-zero if Postgres refuses a new definition, which is the signal that the schema
# moved ahead of this file -- align it the same way and rerun.
set -euo pipefail

CONTAINER="${POSTGRES_CONTAINER:-auth-postgres}"

align() {
  local db="$1" table="$2" column="$3" constraint="$4" values="$5"
  podman exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 --single-transaction -d "$db" \
    -c "ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${constraint};" \
    -c "ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (${column} IN (${values}));" \
    >/dev/null
  echo "align-db: ${db}.${table}.${column} -> (${values})"
}

# A credential locks when too many attempts fail, and the row carries that state for as long
# as the lockout lasts.
align credential_vault credentials status credentials_status_check \
  "'active','locked','revoked'"

# The signal kinds `account-security` emits when it scores a login. The column is a free text
# field in Prisma, so nothing but this check stops the vocabulary from drifting again.
align account_security security_signals signal_type security_signals_type_check \
  "'new_device_detected','suspicious_login_detected','anomaly_detected'"

# `unverified` is the state a freshly created row sits in before its first successful code;
# without it an enrolment cannot be recorded. Only TOTP and recovery codes are methods today.
align mfa mfa_factors status mfa_factors_status_check \
  "'unverified','pending','active','disabled'"
align mfa mfa_factors method mfa_factors_method_check \
  "'totp','backup_code'"

# `expired` is a status the key can be in when it is read back; without it a stored expired key
# cannot be written.
align api_key api_keys status api_keys_status_check \
  "'active','revoked','expired'"
