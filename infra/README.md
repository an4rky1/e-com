# Terraform — the AWS deployment

Everything this repository runs in AWS is declared here: one account-level stack that owns
the state backend and the image repositories, and one directory per environment that owns
the network, the data and the platform in front of it. Three workflows share the code and
only differ in what they talk to:

```bash
make infra-fmt        # format — no network, no credentials
make infra-validate   # fmt -check + init -backend=false + validate, for all three directories
make infra-test       # terraform test on mock providers: a full plan without AWS
```

```bash
make bootstrap         # once per account: state backend + ECR (needs AWS)
make init plan apply   # ENV=dev by default; ENV=prod for the other one
make images push       # build the twelve images, tag them with the git SHA, push to ECR
make deploy            # new task definitions, ECS rolls the services
make smoke             # curl the ALB: front 200, gateway 200, anonymous /auth/me 401
```

```bash
bash tools/local-infra-test.sh   # a full apply against a local emulator — see below
make stub stub-smoke             # the same images and env layout, no AWS at all
```

## Layout

```
infra/bootstrap/          S3 state bucket, DynamoDB lock table, the twelve ECR repositories
infra/modules/catalog/    the service map: ports, databases, is_front — one source of truth
infra/modules/network/    VPC, two public + two private subnets, security groups, no NAT
infra/modules/data/       RDS Postgres (one master user) and ElastiCache Redis
infra/modules/platform/   ALB, ECS cluster + services, Cloud Map, secrets, IAM, logs
infra/envs/dev/           the dev environment; also the offline test suite
infra/envs/prod/          the prod environment — same shape, bigger defaults
```

State lives in `auth-platform-tfstate` under `auth-platform/<env>/terraform.tfstate`,
locked by `auth-platform-locks`, all in `eu-central-1`. The backend block is hand-written
literals on purpose (`backend.tf`): Terraform backends take no variables, and repeating the
three values in both environments keeps the coupling visible.

## The shape it builds

- **ALB on HTTP/80 only.** TLS terminates at a certificate the MVP does not own yet — the
  front's `PUBLIC_ORIGIN` must become `https://` before any OAuth provider accepts a
  callback. Two rules: the default action to the front's target group, and `/auth/*` to the
  gateway's. Health checks are `/` for the front and `/health` for the gateway.
- **ECS Fargate, tasks in public subnets** with `assign_public_ip`: there is no NAT, so a
  private task could not reach ECR. The security groups are what make it safe — nothing
  reaches a task except the load balancer and its siblings.
- **Cloud Map** — one private namespace `<env>.auth.internal`, one A-record per backend, so
  the gateway dials `identity.dev.auth.internal:13001` and the front is built with
  `http://api-gateway.dev.auth.internal:3000` (the Makefile's `AWS_GATEWAY_URL`).
  `enable_service_discovery = false` is the escape hatch for an emulator that cannot
  register tasks.
- **One Secrets Manager document**, each task handed only the JSON keys it reads. The
  connection URLs are keyed per database (`DATABASE_URL_SESSION_ENGINE` for session's
  `session_engine`) and re-emitted to the container as plain `DATABASE_URL`, because that is
  what every Prisma schema reads.
- **Images**: `auth-platform/<service>:<git sha>`, shared across environments; `infra/bootstrap`
  creates the repositories, the environment only resolves them at plan time.

## Databases

Nothing here creates tables — `prisma migrate deploy` does, from the host via
`make migrate` (local Postgres) or inside ECS:

```bash
make db-init ENV=dev      # one ECS task: CREATE DATABASE for all ten (tools/aws-ecs-task.sh)
make migrate-env ENV=dev  # one ECS task per service: prisma migrate deploy
```

Both run the same `tools/aws-ecs-task.sh`, which finds the network from the running
`identity` service and streams the task's logs out when it fails. `db-init` needs the task
execution role plus `ecs:RunTask`, `ecs:DescribeServices`, `ecs:DescribeTasks`,
`ecs:WaitTasksStopped`, `iam:PassRole` and `logs:FilterLogEvents`/`logs:GetLogEvents`.

## The local emulator

`bash tools/local-infra-test.sh` applies **everything** — bootstrap and dev — against a
throwaway [moto](https://github.com/getmoto/moto) container, then asserts the second plan is
empty. The provider block stays bare (`region` and nothing else): the script exports
`AWS_ENDPOINT_URL` and fake credentials, and the same configuration talks to moto instead of
AWS. No `if local` branches, no second provider block to drift.

The run happens in a copy of `infra/` with a local state file, so the working tree never
holds state that would confuse the next real `plan`. `-var-file=local.tfvars` sets
`desired_count = 0`: the resources and their wiring are what the run proves, and a task with
no image to pull would only prove Docker is connected. Scale it to 1 after `make push`.

## The local stub

`make stub` builds the twelve images and starts them over `docker-compose.yml` with
`docker-compose.stub.yml` — the same environment layout ECS gets, compose DNS standing in
for Cloud Map (`identity:13001` for `identity.dev.auth.internal:13001`). `make stub-migrate`
applies the schema inside the network; `make stub-smoke` asserts every service answers
`/health` and that register → login → `/auth/me` works through the front's rewrites on
`http://127.0.0.1:3000`. The front owns host port 3000 there, which is why Grafana sits on
3100 in the base compose file.

## Conventions worth knowing

- `ENV` defaults to `dev` everywhere; `terraform.tfvars` restates the defaults so an apply
  with no flags and an apply with the file build the same stack.
- Task families are `auth-platform-<env>-<service>`, log groups
  `/auth-platform/<env>/<service>` — which is what `make status` and the failure path in
  `aws-ecs-task.sh` address.
- The offline tests assert on module **outputs** (`task_definition`, `service_wiring`),
  not on child resources: a root-level test can only see what the root module exports.
- `terraform validate` does not catch a type error hidden inside `try()`; the tests do, by
  forcing the value to be known at plan time.
