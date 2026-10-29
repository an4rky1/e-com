# Auth Platform — 9 microservices in an NX monorepo

Production-shaped authentication and authorization platform. Every service follows Clean
Architecture, DDD + CQRS, and publishes facts through a transactional outbox to Kafka.

## Layout

```
apps/<service>/        thin bootstrap only — process concerns, no business logic
libs/core/         kernel: AggregateRoot, DomainEvent, Result, Ensure, ports
libs/contracts/        shared types, HTTP contract, topic catalogue, .proto contracts
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
| `session` | `session_engine` | what did we issue, is it still valid |
| `access-control` | `access_control` | what may they do (RBAC + ABAC) |
| `auth-flow` | `auth_flow` | walk them through the flow |
| `mfa` | `mfa` | second factor |
| `api-key` | `api_key` | machine credentials |
| `account-security` | `account_security` | does this look like an attack |
| `notification` | `notify` | turn facts into messages |

Plus an `api-gateway` edge (stateless) that fronts all of them.

## Two processes, one word: "gateway"

They are not two halves of the same thing — they sit on opposite sides of one gRPC hop:

| | `api-gateway` | `auth-flow` |
|---|---|---|
| lives in | `apps/api-gateway`, `libs/gateway` | `apps/auth-flow`, `libs/domains/auth-flow` |
| public face | HTTP :3000 — the only process the browser talks to | gRPC :13005 — never reachable from a browser |
| state | **none**: no `DATABASE_URL` in its config schema, no DB, no outbox, no Kafka | `auth_flow` DB: the flow state machine + its outbox |
| job | JWT check, rate limits, idempotency, validation, OAuth walk, peer dispatch | sequencing a login/register/MFA walk across five peers |
| peers | identity, access-control, session, credential-vault, **auth-flow** | identity, credential-vault, session, mfa, account-security |

The request path for a password sign-in is
`browser → api-gateway → (StartFlow, AdvanceFlow) → auth-flow → peers`: the edge makes two
gRPC calls and only the second one ever carries the password; it does not know what a flow
*is* beyond those two calls. Routes that need no sequencing (`refresh`, `logout`, `/users`,
the OAuth resolve) go straight from the edge to their peer — the edge never proxies
auth-flow's state machine for anything but a flow.

Why not one process: the edge is deliberately stateless (a row on the edge goes stale; a
DB credential there is blast radius), while a flow *must* survive across steps, retries and
second factors. Splitting them keeps each property enforceable — the edge's config schema
has no database key, so it cannot quietly grow one, and the flow's tables have no HTTP
surface, so they cannot be reached around the edge's guards.

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

## Registering an account

Local (email + password): the `/register` page or `POST /auth/register` with
`{ email, password, displayName? }`. The page signs the new account in immediately. The gateway
writes the password credential first and the user second: a refused user create triggers a
compensating revoke of that credential (best-effort — it never masks the original error), so a
failed registration leaves no user and, normally, no credential. `password` is gated at 8–512
characters at the edge; the vault's own 12–256 floor is what the credential enforces.

## OAuth providers (Google, GitHub, Telegram)

Nothing here is needed to boot. Every `GATEWAY_OAUTH_*` value defaults to the empty string,
empty means disabled, and a disabled provider simply does not appear on `/register` or on
`GET /auth/oauth`.

Set on the **api-gateway** process:

| Variable | Meaning |
|---|---|
| `GATEWAY_OAUTH_PUBLIC_ORIGIN` | the front's origin, e.g. `http://localhost:3000` |
| `GATEWAY_OAUTH_STATE_SECRET` | HMAC key for the signed `state` nonce (`openssl rand -hex 32`) |
| `GATEWAY_OAUTH_GOOGLE_CLIENT_ID` / `_SECRET` | Google OAuth client |
| `GATEWAY_OAUTH_GITHUB_CLIENT_ID` / `_SECRET` | GitHub OAuth app |
| `GATEWAY_OAUTH_TELEGRAM_BOT_TOKEN` | bot token from [@BotFather](https://t.me/BotFather) |
| `GATEWAY_OAUTH_TELEGRAM_BOT_USERNAME` | the bot's username without `@` — what the widget renders with |

`PUBLIC_ORIGIN` and `STATE_SECRET` gate the whole redirect walk: a provider configured with
only a client pair resolves to disabled rather than starting a flow whose `state` is unsigned
and whose redirect URI is unknown. Telegram has its own, narrower gate — an origin plus *both*
bot values — because it never starts a redirect walk and its callback is bound by the bot's
HMAC rather than by a `state`.

Redirect URIs the consoles must accept — the browser talks to the front, which proxies
`/api/auth/*` to the gateway, so the paths carry the front's prefix:

- Google: `${GATEWAY_OAUTH_PUBLIC_ORIGIN}/api/auth/oauth/google/callback`
- GitHub: `${GATEWAY_OAUTH_PUBLIC_ORIGIN}/api/auth/oauth/github/callback`

Google: [console](https://console.cloud.google.com/apis/credentials) → OAuth consent screen →
Credentials → **OAuth client ID** (Web application) → authorized redirect URI as above. Scopes
requested are `openid email profile`.

GitHub: Settings → Developer settings → OAuth Apps → **New OAuth app** → Authorization callback
URL as above. The gateway reads `/user` plus `/user/emails`.

A callback links an account only when the provider asserts a **verified** email (Google
`email_verified`, GitHub's verified entries in `/user/emails`): identity links by address, and
an unverified address would be account takeover. Failures send the browser back to
`/#oauth_error=<message>`.

### Telegram

Telegram has no redirect walk: the widget on `/register` **is** the start. The gateway reports
`telegram: true` with the bot username in `GET /auth/oauth`, the front attaches
`telegram.org/js/telegram-widget.js` with its `data-auth-url` set to
`${PUBLIC_ORIGIN}/api/auth/oauth/telegram/callback`, and Telegram posts the browser straight
to that URL with `id`, names, `auth_date` and an HMAC signed by the bot token. The gateway
verifies the signature (every field but `hash`, key-sorted, keyed with `SHA256(bot_token)`),
refuses callbacks older than 24 hours, and then resolves and issues exactly like any other
provider — no `state`, no code exchange.

Telegram vouches for a numeric id, not an address, so the account is given one in the
`.invalid` namespace (RFC 2606): syntactically real, structurally unroutable, recorded
unverified. The id is the subject the link is keyed on; the address exists only because
identity looks accounts up by address.

The widget's `data-auth-url` must be reachable from Telegram's page: `http://localhost`
works for development, but a deployed front needs an **https** origin — `PUBLIC_ORIGIN`
included.

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