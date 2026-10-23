# Auth Platform — 9 microservices in an NX monorepo

Production-shaped authentication and authorization platform. Every service follows Clean
Architecture, DDD + CQRS, and publishes facts through a transactional outbox to Kafka.

## Layout

```
apps/<service>/        thin bootstrap only — process concerns, no business logic
libs/core/         kernel: AggregateRoot, DomainEvent, Result, Ensure, ports
libs/contracts/        shared types, topic catalogue, .proto contracts
libs/platform/*        config, error-handling, health, shutdown
libs/infra/*           prisma, kafka, outbox, grpc
libs/domains/<svc>/    all logic: domain / application / infrastructure / presentation
prisma/<svc>/          one schema per service, generating that service's own client
```

Apps are deliberately thin. A service can be run from a different bootstrap — a CLI, a test
harness, a serverless adapter — without duplicating wiring, because every decision lives in
`libs/domains/<service>`.

### Why per-service Prisma clients

Each service generates a Prisma client from **its own** schema. That makes table ownership a
compile error rather than a convention: identity has no way to name a session row, because
that model is not in its client.

## Services

| Service | Database | Answers |
|---|---|---|
| `identity` | `identity` | who is this user |
| `credential-vault` | `credential_vault` | prove you are this user (Argon2id + pepper) |
| `session-token` | `session_engine` | what did we issue, is it still valid |
| `access-control` | `access_control` | what may they do (RBAC + ABAC) |
| `auth-gateway` | `auth_gateway` | walk them through the flow |
| `mfa` | `mfa` | second factor |
| `api-key` | `api_key` | machine credentials |
| `account-security` | `account_security` | does this look like an attack |
| `notification` | `notify` | turn facts into messages |

Plus an `api-gateway` edge (stateless) that fronts all of them.

## The transactional outbox

Every state mutation writes its `outbox_events` rows **in the same transaction** as the
change. The relay then claims rows with `FOR UPDATE SKIP LOCKED`, publishes to Kafka, and
retries with exponential backoff plus full jitter before dead-lettering.

This is what makes the guarantee *at-least-once with no lost events*: producing to Kafka
directly after a commit would leave a window where the state is durable and the event is
gone. `dedup_key` (unique per event type) makes a retried command a no-op, and consumers
deduplicate on `<topic>:<eventId>`.

Verified end to end against real Postgres + Redpanda: create user → outbox row committed
atomically → relay drains it → Kafka.

## Running it

```bash
# 1. infrastructure (postgres, redis, redpanda)
podman compose up -d          # or: docker compose up -d

# 2. generate a service's Prisma client
source tools/prisma-env.sh
npx prisma generate --schema prisma/identity/schema.prisma

# 3. run a service
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/identity \
SERVICE_NAME=identity PORT=3001 \
npx nx serve identity
```

### NixOS

Prisma publishes no `linux-nixos` engines. `tools/prisma-env.sh` points the CLI at the Debian
OpenSSL 3 builds shipped in `@prisma/engines`, which load correctly on NixOS. The same
`PRISMA_QUERY_ENGINE_LIBRARY` must be exported at **runtime** or the client fails to boot.

### Local broker

Redpanda is API-compatible with Kafka and has no JVM. Topics already exist as
`platform.<aggregate>.<event>.v<N>` with `.dlq` / `.retry` siblings; auto-creation is off, so
create new ones explicitly with `rpk topic create`.

## Quality gates

```bash
npx nx run-many -t typecheck --all
npx nx run-many -t lint --all
npx nx run-many -t test --all
```

Layering is machine-enforced twice: NX dependency constraints police lib → lib edges, and
`no-restricted-imports` overrides police intra-lib edges (because all four layers of a service
live inside one lib, which NX tags cannot see).

## Conventions worth knowing

- **CQRS commands and queries are classes**, not interfaces or string keys. `@nestjs/cqrs` v11
  resolves handlers from `command.constructor`, so a plain object or a string bus key can
  never dispatch.
- **No TypeScript `enum`** — `as const` objects plus union types, so adding a state is not a
  migration and the wire format stays plain text.
- **No `any`**; JSON columns take `Prisma.InputJsonValue` via one documented cast.
- DI tokens are `Symbol`s; every module config reads its own `<PREFIX>_*` namespace and never
  `process.env` directly.