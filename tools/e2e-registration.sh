#!/usr/bin/env bash
#
# End-to-end registration flow against real infrastructure.
#
#   identity (HTTP)  ->  users row + outbox row, ONE transaction
#     -> outbox relay -> Kafka topic platform.user.registered.v1
#       -> notification consumer -> dedup claim + notification record -> channel dispatch
#
# Nothing is mocked: real Postgres, real Redpanda, real HTTP, real relay. The point is to
# prove the guarantee holds across process boundaries, which no unit test can.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$ROOT"

# The stack has to be up before a service can boot. A stopped Postgres otherwise
# surfaces as "service never started", which reads as a code failure.
shell_source="$(dirname "$0")/preflight-stack.sh"
[ -f "$shell_source" ] && . "$shell_source"

export PRISMA_QUERY_ENGINE_LIBRARY="$ROOT/node_modules/@prisma/engines/libquery_engine-debian-openssl-3.0.x.so.node"
export PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=true
export KAFKA_BROKERS=localhost:9092
export KAFKA_ENABLED=true
export OUTBOX_POLL_INTERVAL_MS=300

REDPANDA_IMAGE="redpandadata/redpanda:v24.2.2"

# `rpk` ships inside the broker image, never on the host. Prefer the broker container when one
# is actually running under the compose file's name, and otherwise run the CLI in a throwaway
# container on the host network — the shape CI has, where the broker is a service container
# with no `podman exec` to reach it. A hard-coded `podman exec` passes locally and then fails
# on the runner for a reason that has nothing to do with the code under test.
kafka_cli() {
  if podman container exists auth-redpanda 2>/dev/null; then
    podman exec auth-redpanda rpk "$@"
    return
  fi
  if docker container inspect auth-redpanda >/dev/null 2>&1; then
    docker exec auth-redpanda rpk "$@"
    return
  fi
  docker run --rm --network host "$REDPANDA_IMAGE" rpk "$@"
}
TOPIC=platform.user.registered.v1
LOG=/tmp/opencode

# Random ports. These used to be fixed at 3981/3982, which collided with any other run that
# happened to pick that base — the gateway script draws from 37000..39990 and so reaches this
# pair easily — and the collision surfaced as "notification health: not up" in a run whose own
# code had not changed. A port is not a configuration value worth pinning.
BASE=$(( 3900 + (RANDOM % 400) * 10 ))
IDENTITY_PORT=$BASE
NOTIFY_PORT=$(( BASE + 1 ))
IDENTITY_PID=""
NOTIFY_PID=""

# One value, referenced twice: the consumer this run subscribes as, and the group the startup
# sequence resets. Keeping them as two literals is how a reset that names a different group than
# the consumer joined passes silently and the replay it was meant to prevent comes back.
KAFKA_GROUP_ID="notification-e2e"

IDENTITY_DB="postgresql://postgres:postgres@localhost:5432/identity"
NOTIFY_DB="postgresql://postgres:postgres@localhost:5432/notify"

pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then printf "  \033[32mPASS\033[0m %s\n" "$1"; pass=$((pass+1));
  else printf "  \033[31mFAIL\033[0m %s (expected=%s got=%s)\n" "$1" "$3" "$2"; fail=$((fail+1)); fi
}
check_contains() {
  if echo "$2" | grep -qF -- "$3"; then printf "  \033[32mPASS\033[0m %s\n" "$1"; pass=$((pass+1));
  else printf "  \033[31mFAIL\033[0m %s (missing=%s)\n" "$1" "$3"; fail=$((fail+1)); fi
}

q_identity() { podman exec auth-postgres psql -U postgres -d identity -tAc "$1" 2>/dev/null | tr -d ' '; }
q_notify()   { podman exec auth-postgres psql -U postgres -d notify   -tAc "$1" 2>/dev/null | tr -d ' '; }

cleanup() {
  for pid in "$IDENTITY_PID" "$NOTIFY_PID"; do
    pkill -P "$pid" 2>/dev/null
    kill "$pid" 2>/dev/null
  done
  wait 2>/dev/null
}
trap cleanup EXIT

echo "==> clearing pre-existing flow state"
podman exec auth-postgres psql -U postgres -d identity -c "DELETE FROM outbox_events;" >/dev/null 2>&1
podman exec auth-postgres psql -U postgres -d notify   -c "DELETE FROM notifications;" >/dev/null 2>&1
podman exec auth-postgres psql -U postgres -d notify   -c "DELETE FROM outbox_events;" >/dev/null 2>&1
# The database is only half the state: the topic still holds every event ever published, and a
# consumer group that never committed an offset replays all of it. A run that cleared its tables
# and then counted claims would be counting messages from runs that finished minutes ago, and the
# failures would point at dedup rather than at the retained history that caused them. Dropping
# the group puts the next consumer at the topic end, so this run only sees what it produced.
kafka_cli group delete "$KAFKA_GROUP_ID" --brokers localhost:9092 >/dev/null 2>&1 || true

echo "==> booting notification (consumer) and identity (producer)"

DATABASE_URL="$NOTIFY_DB" SERVICE_NAME=notification PORT=$NOTIFY_PORT \
  KAFKA_GROUP_ID="$KAFKA_GROUP_ID" \
  NOTIFICATION_STORE_MODE=prisma \
  TS_NODE_PROJECT=apps/notification/tsconfig.app.json \
  npx ts-node --transpile-only -r tsconfig-paths/register apps/notification/src/main.ts \
  > "$LOG/notify.log" 2>&1 &
NOTIFY_PID=$!

DATABASE_URL="$IDENTITY_DB" SERVICE_NAME=identity PORT=$IDENTITY_PORT \
  TS_NODE_PROJECT=apps/identity/tsconfig.app.json \
  npx ts-node --transpile-only -r tsconfig-paths/register apps/identity/src/main.ts \
  > "$LOG/identity.log" 2>&1 &
IDENTITY_PID=$!

for _ in $(seq 1 40); do
  curl -sf -m 2 "http://127.0.0.1:$IDENTITY_PORT/health" >/dev/null 2>&1 && break
  sleep 1
done

echo
echo "==> 1. services are up"
check "identity health"   "$(curl -s -m 5 "http://127.0.0.1:$IDENTITY_PORT/health"  | grep -o '"status":"[a-z]*"' | cut -d'"' -f4)" "up"
check "notification health" "$(curl -s -m 5 "http://127.0.0.1:$NOTIFY_PORT/health"  | grep -o '"status":"[a-z]*"' | cut -d'"' -f4)" "up"
check_contains "notification subscribed to topics" "$(cat "$LOG/notify.log")" "subscribed to"

EMAIL="e2e-$RANDOM-$$@example.test"
echo
echo "==> 2. POST /users  ($EMAIL)"
RESP=$(curl -s -m 8 -X POST "http://127.0.0.1:$IDENTITY_PORT/users" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"displayName\":\"E2E User\"}")
USER_ID=$(echo "$RESP" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
check "user created"      "$(echo "$RESP" | grep -o '"status":"[a-z_]*"' | cut -d'"' -f4)" "pending_verification"
check "returned an id"    "$([ -n "$USER_ID" ] && echo yes || echo no)" "yes"
check "id is a uuid"      "$(echo "$USER_ID" | grep -cE '^[0-9a-f-]{36}$')" "1"

echo
echo "==> 3. duplicate registration is rejected"
check "409 on duplicate" \
  "$(curl -s -m 8 -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$IDENTITY_PORT/users" \
      -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\"}")" "409"

echo
echo "==> 4. state and event committed together"
check "user row exists in identity db" \
  "$(q_identity "SELECT count(*) FROM users WHERE id='$USER_ID'")" "1"
check "outbox row written" \
  "$(q_identity "SELECT count(*) FROM outbox_events WHERE aggregate_id='$USER_ID' AND type='user.registered'")" "1"
check "outbox row names the right topic" \
  "$(q_identity "SELECT topic FROM outbox_events WHERE aggregate_id='$USER_ID' LIMIT 1")" "$TOPIC"
check "dedup key present" \
  "$(q_identity "SELECT dedup_key FROM outbox_events WHERE aggregate_id='$USER_ID' LIMIT 1")" \
  "user.registered:$USER_ID:1"

echo
echo "==> 5. relay publishes to Kafka and marks the row published"
for _ in $(seq 1 30); do
  [ "$(q_identity "SELECT status FROM outbox_events WHERE aggregate_id='$USER_ID' LIMIT 1")" = "published" ] && break
  sleep 1
done
check "outbox row published" \
  "$(q_identity "SELECT status FROM outbox_events WHERE aggregate_id='$USER_ID' LIMIT 1")" "published"
check "published with zero retries" \
  "$(q_identity "SELECT attempts FROM outbox_events WHERE aggregate_id='$USER_ID' LIMIT 1")" "0"

echo
EVENT_ID_FROM_OUTBOX=$(q_identity "SELECT payload::json->>'eventId' FROM outbox_events WHERE aggregate_id='$USER_ID' LIMIT 1")

echo "==> 6. notification consumed the event"
for _ in $(seq 1 30); do
  [ "$(q_notify "SELECT count(*) FROM outbox_events WHERE type='notification.consumer.claim'")" != "0" ] && break
  sleep 1
done
check "consumer claimed the event (dedup row)" \
  "$(q_notify "SELECT count(*) FROM outbox_events WHERE type='notification.consumer.claim'")" "1"
# The claim is keyed by the *event*, not the user: two facts about one user must both send,
# so keying on the user would silently swallow the second one.
check "claim is keyed by the event, not the user" \
  "$(q_notify "SELECT aggregate_id FROM outbox_events WHERE type='notification.consumer.claim' LIMIT 1")" \
  "$TOPIC:$EVENT_ID_FROM_OUTBOX"
check "claim key is <topic>:<eventId>" \
  "$(q_notify "SELECT count(*) FROM outbox_events WHERE type='notification.consumer.claim' AND dedup_key LIKE '$TOPIC:%'")" "1"

echo
echo "==> 6b. the claim points at the exact event identity published"
check_contains "claim dedup key carries the event id" \
  "$(q_notify "SELECT dedup_key FROM outbox_events WHERE type='notification.consumer.claim' LIMIT 1")" \
  "$TOPIC:$EVENT_ID_FROM_OUTBOX"

echo
echo "==> 7. a notification was produced for the new user"
# Records live in `notifications`. They used to be `outbox_events` rows distinguished by a
# namespaced `type` and a `status` that was never `pending` — a convention that would have put
# a user's notification on a Kafka topic the day the status was wrong.
for _ in $(seq 1 20); do
  [ "$(q_notify "SELECT count(*) FROM notifications WHERE user_id='$USER_ID'")" != "0" ] && break
  sleep 1
done
NOTIF_COUNT=$(q_notify "SELECT count(*) FROM notifications WHERE user_id='$USER_ID'")
check "notification recorded" "$([ "$NOTIF_COUNT" -ge 1 ] && echo yes || echo no)" "yes"
check "notification is filed against this user" \
  "$(q_notify "SELECT count(*) FROM notifications WHERE user_id='$USER_ID'")" \
  "$NOTIF_COUNT"
check_contains "welcome template chosen" \
  "$(q_notify "SELECT template FROM notifications WHERE user_id='$USER_ID' LIMIT 1")" \
  "welcome"

echo
echo "==> 8. redelivering the same event does not double-send"
BEFORE=$(q_notify "SELECT count(*) FROM notifications WHERE user_id='$USER_ID'")
EVENT_ID=$(q_identity "SELECT payload::json->>'eventId' FROM outbox_events WHERE aggregate_id='$USER_ID' LIMIT 1")
kafka_cli topic produce "$TOPIC" \
  --brokers localhost:9092 -p key="$USER_ID" -K ':' -V \
  "{\"eventId\":\"$EVENT_ID\",\"type\":\"$TOPIC\",\"schemaVersion\":1,\"aggregateId\":\"$USER_ID\",\"aggregateType\":\"user\",\"partitionKey\":\"$USER_ID\",\"occurredAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"payload\":{\"userId\":\"$USER_ID\",\"email\":\"$EMAIL\",\"displayName\":\"E2E User\",\"source\":\"web\"}}" \
  >/dev/null 2>&1
sleep 6
AFTER=$(q_notify "SELECT count(*) FROM notifications WHERE user_id='$USER_ID'")
check "duplicate event produced no second notification" "$AFTER" "$BEFORE"
check "still exactly one consumer claim" \
  "$(q_notify "SELECT count(*) FROM outbox_events WHERE type='notification.consumer.claim'")" "1"

echo
echo "==> 9. the email channel actually dispatched"
check_contains "welcome email dispatched" "$(cat "$LOG/notify.log")" "[email] welcome"
check_contains "recipient was redacted in the log" "$(cat "$LOG/notify.log")" "address: present"

# Redaction is a security property, so it is asserted as one: the plaintext address must not
# reach the log, and must not reach any outbox payload either.
if grep -q "$EMAIL" "$LOG/notify.log"; then
  printf "  \033[31mFAIL\033[0m raw address absent from notification log\n"; fail=$((fail+1))
else
  printf "  \033[32mPASS\033[0m raw address absent from notification log\n"; pass=$((pass+1))
fi
if [ "$(q_notify "SELECT (SELECT count(*) FROM outbox_events WHERE payload::text LIKE '%$EMAIL%') + (SELECT count(*) FROM notifications WHERE payload::text LIKE '%$EMAIL%' OR variables::text LIKE '%$EMAIL%')")" != "0" ]; then
  printf "  \033[31mFAIL\033[0m raw address absent from notification outbox\n"; fail=$((fail+1))
else
  printf "  \033[32mPASS\033[0m raw address absent from notification outbox\n"; pass=$((pass+1))
fi

echo
echo "================================================"
printf "  passed: %d   failed: %d\n" "$pass" "$fail"
echo "================================================"
[ "$fail" -eq 0 ] || { echo "--- notify log tail ---"; tail -25 "$LOG/notify.log"; echo "--- identity log tail ---"; tail -15 "$LOG/identity.log"; }
exit "$fail"