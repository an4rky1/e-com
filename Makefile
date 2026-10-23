# Auth platform: local dev, container images, Terraform, and the local deploy stub.
#
# Three audiences share this file:
#   - a laptop running the stack without AWS (dev + stub groups work with zero credentials);
#   - a maintainer validating infra offline (infra-validate and infra-test need no network);
#   - an operator deploying to a real account (plan/apply/deploy guard on `aws sts` first).
#
# Run `make help` for the target list. `ENV` selects the Terraform environment
# (dev | prod) and defaults to dev everywhere.

.DEFAULT_GOAL := help

ENV            ?= dev
TAG            ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo local)
COMPOSE        ?= docker compose
AWS            ?= aws
AWS_REGION     ?= eu-central-1
ECR_REPOSITORY ?= auth-platform

# Baked into the front image at build time (next.config rewrites evaluate once per build).
# The deploy default is the Cloud Map name of the gateway inside the VPC; override for the
# stub or for a laptop.
GATEWAY_URL ?= http://localhost:3000
# Same URL as seen from inside the stub network (compose DNS, mirrors Cloud Map).
STUB_GATEWAY_URL := http://api-gateway:3000
# Deterministic Cloud Map name: api-gateway.<ENV>.auth.internal — must match infra/.
AWS_GATEWAY_URL = http://api-gateway.$(ENV).auth.internal:3000

# The eleven stateful/edge services plus the front. Single source for image builds;
# api-gateway is stateless but still ships as a container.
SERVICES := identity access-control credential-vault session-token auth-gateway \
	mfa api-key account-security notification audit-log api-gateway

TF_BOOTSTRAP := terraform -chdir=infra/bootstrap
TF_ENV       := terraform -chdir=infra/envs/$(ENV)

.PHONY: help install generate lint typecheck test check \
	up down down-v logs migrate boot-check \
	e2e-registration e2e-login e2e-gateway e2e-rate-limit e2e e2e-front \
	image images push \
	infra-fmt infra-validate infra-test bootstrap init plan apply destroy output \
	db-init migrate-env deploy smoke status \
	stub stub-down stub-logs stub-migrate stub-smoke

##@ Local development

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_-]+:.*##/ {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2} /^##@/ {printf "\n\033[1m%s\033[0m\n", substr($$0, 5)}' $(MAKEFILE_LIST)

install: ## Install npm dependencies (npm ci)
	npm ci

generate: ## Generate Prisma clients for every service
	npm run generate

lint: ## ESLint across the workspace
	npm run lint

typecheck: ## tsc --noEmit across the workspace
	npm run typecheck

test: ## Jest across the workspace
	npm run test

check: lint typecheck test ## lint + typecheck + test

up: ## Start Postgres/Redis/Redpanda (docker-compose.yml)
	$(COMPOSE) up -d

down: ## Stop the local infra containers (keeps volumes)
	$(COMPOSE) down

down-v: ## Stop and delete local infra volumes
	$(COMPOSE) down -v

logs: ## Tail infra container logs
	$(COMPOSE) logs -f

migrate: ## Apply every service's Prisma migrations to local Postgres
	bash tools/migrate.sh

boot-check: ## Boot every application once and assert it comes up
	bash tools/boot-check.sh

e2e-registration: ## Registration, outbox and notification flow
	bash tools/e2e-registration.sh

e2e-login: ## Sign-in, session and token validation flow
	bash tools/e2e-login.sh

e2e-gateway: ## Public gateway edge flow
	bash tools/e2e-gateway.sh

e2e-rate-limit: ## Rate limiting at the edge (needs local Redis)
	REDIS_URL=redis://localhost:6379 bash tools/e2e-rate-limit.sh

e2e: e2e-registration e2e-login e2e-gateway e2e-rate-limit ## All backend E2E scripts

e2e-front: ## Browser E2E: boots the real stack and drives the sign-in page
	bash tools/e2e-front.sh

##@ Container images

image: ## Build one backend image (APP=<name>, TAG=<tag>)
	@test -n "$(APP)" || { echo "usage: make image APP=<service> [TAG=<tag>]"; exit 1; }
	docker build --target backend --build-arg APP=$(APP) \
		-t $(ECR_REPOSITORY)/$(APP):$(TAG) .

image-front: ## Build the front image (GATEWAY_URL=<gateway base url>, TAG=<tag>)
	docker build --target front --build-arg GATEWAY_URL=$(GATEWAY_URL) \
		-t $(ECR_REPOSITORY)/front:$(TAG) .

images: ## Build every service image plus the front
	@set -e; for app in $(SERVICES); do $(MAKE) image APP=$$app TAG=$(TAG); done
	$(MAKE) image-front TAG=$(TAG)

push: ## Tag and push every image to ECR (needs AWS credentials)
	@ACCOUNT=$$($(AWS) sts get-caller-identity --query Account --output text) || { \
		echo "error: AWS credentials not found (aws sts get-caller-identity)"; exit 1; }
	@ACCOUNT=$$($(AWS) sts get-caller-identity --query Account --output text); \
	URI="$$ACCOUNT.dkr.ecr.$(AWS_REGION).amazonaws.com/$(ECR_REPOSITORY)"; \
	$(AWS) ecr describe-repositories --repository-names $(ECR_REPOSITORY) >/dev/null 2>&1 || \
		$(AWS) ecr create-repository --repository-name $(ECR_REPOSITORY) >/dev/null; \
	$(AWS) ecr get-login-password --region $(AWS_REGION) | \
		docker login --username AWS --password-stdin "$$ACCOUNT.dkr.ecr.$(AWS_REGION).amazonaws.com"; \
	set -e; for app in $(SERVICES) front; do \
		docker tag $(ECR_REPOSITORY)/$$app:$(TAG) "$$URI/$$app:$(TAG)" && \
		docker push "$$URI/$$app:$(TAG)"; \
	done

##@ Terraform

infra-fmt: ## Format infra/ sources
	terraform fmt -recursive infra

infra-validate: ## Offline fmt -check + init -backend=false + validate (no AWS needed)
	terraform fmt -check -recursive infra
	@set -e; for dir in infra/bootstrap infra/envs/dev infra/envs/prod; do \
		echo "==> $$dir"; \
		terraform -chdir=$$dir init -backend=false -input=false >/dev/null; \
		terraform -chdir=$$dir validate; \
	done

infra-test: ## Offline terraform test on mock providers (plan without AWS)
	terraform -chdir=infra/envs/dev test

bootstrap: ## Create the Terraform state backend (needs AWS; once per account/region)
	@$(AWS) sts get-caller-identity >/dev/null || { echo "error: AWS credentials not found"; exit 1; }
	$(TF_BOOTSTRAP) init -input=false
	$(TF_BOOTSTRAP) apply -auto-approve -var aws_region=$(AWS_REGION)

init: ## terraform init for ENV=$(ENV) (needs AWS for the S3 backend)
	@$(AWS) sts get-caller-identity >/dev/null || { echo "error: AWS credentials not found"; exit 1; }
	$(TF_ENV) init -input=false

plan: ## terraform plan for ENV=$(ENV) (needs AWS)
	@$(AWS) sts get-caller-identity >/dev/null || { echo "error: AWS credentials not found"; exit 1; }
	$(TF_ENV) plan -out=$(ENV).tfplan

apply: ## terraform apply for ENV=$(ENV) (needs AWS)
	@$(AWS) sts get-caller-identity >/dev/null || { echo "error: AWS credentials not found"; exit 1; }
	$(TF_ENV) apply $(ENV).tfplan

destroy: ## terraform destroy for ENV=$(ENV) (needs AWS; asks for confirmation)
	@$(AWS) sts get-caller-identity >/dev/null || { echo "error: AWS credentials not found"; exit 1; }
	$(TF_ENV) destroy

output: ## Show Terraform outputs for ENV=$(ENV)
	$(TF_ENV) output

##@ Deploy to AWS (make infra available first; see docs in infra/)

db-init: ## Create the ten service databases in RDS (ECS task, ENV=$(ENV))
	bash tools/aws-ecs-task.sh db-init $(ENV)

migrate-env: ## Run Prisma migrations against RDS (ECS task, ENV=$(ENV))
	bash tools/aws-ecs-task.sh migrate $(ENV)

deploy: ## Build for ENV=$(ENV), push, apply and migrate (needs AWS)
	$(MAKE) images GATEWAY_URL=$(AWS_GATEWAY_URL) TAG=$(TAG)
	$(MAKE) push TAG=$(TAG)
	$(TF_ENV) apply -auto-approve -var image_tag=$(TAG)
	bash tools/aws-ecs-task.sh migrate $(ENV)

smoke: ## Health-check the deployed stack through the ALB (ENV=$(ENV))
	bash tools/aws-smoke.sh $(ENV)

status: ## ECS service status for ENV=$(ENV)
	$(AWS) ecs describe-services --cluster auth-platform-$(ENV) \
		--services $(shell echo $(SERVICES) | tr ' ' '\n' | sed 's/^/auth-platform-$(ENV)-/' | tr '\n' ' ') \
		--query 'services[].{name:serviceName,running:runningCount,desired:desiredCount,status:status}' \
		--output table

##@ Local deploy stub (same images and env layout as ECS, no AWS)

stub: ## Build images for the stub and start the full stack (infra compose + overlay)
	$(MAKE) images GATEWAY_URL=$(STUB_GATEWAY_URL) TAG=$(TAG)
	TAG=$(TAG) $(COMPOSE) -f docker-compose.yml -f docker-compose.stub.yml up -d

stub-down: ## Stop the stub stack
	$(COMPOSE) -f docker-compose.yml -f docker-compose.stub.yml down

stub-logs: ## Tail stub stack logs
	$(COMPOSE) -f docker-compose.yml -f docker-compose.stub.yml logs -f

stub-migrate: ## Apply migrations inside the stub network
	$(COMPOSE) -f docker-compose.yml -f docker-compose.stub.yml run --rm migrate

stub-smoke: ## Assert every stub service answers /health and the login path works
	bash tools/stub-smoke.sh
