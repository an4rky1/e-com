#!/usr/bin/env bash
#
# One-off ECS tasks against a deployed environment: create the databases, then migrate them.
#
# Both operations run *in* the VPC — RDS has no public endpoint and no NAT gateway exists,
# so a laptop cannot reach it, and the natural executor is a task that already carries the
# platform's own networking. Each run reuses a service's task definition (family
# auth-platform-<env>-<service>) with only the command overridden: the image, the injected
# DATABASE_URL, the security group and the subnets are then exactly what the service itself
# would get, and there is no second task definition to keep in step with the first.
#
# The network comes from the identity service's stored configuration rather than from
# Terraform outputs: describe-services answers before anything is running (desired count 0
# is fine), and an operator with only AWS credentials — no state access — can migrate.
#
# The caller needs ecs:RunTask, ecs:DescribeServices/Tasks/Wait, iam:PassRole for the
# task and execution roles, and logs:Filter/GetLogEvents for the failure path.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"

usage() {
  echo "usage: bash tools/aws-ecs-task.sh <db-init|migrate> [env]" >&2
  exit 2
}

[ $# -ge 1 ] || usage
ACTION="$1"
ENVIRONMENT="${2:-dev}"
case "$ACTION" in db-init | migrate) ;; *) usage ;; esac

command -v aws >/dev/null || { echo "error: aws CLI not found" >&2; exit 1; }
aws sts get-caller-identity >/dev/null || {
  echo "error: AWS credentials not found (aws sts get-caller-identity)" >&2
  exit 1
}
# Same default as infra/ — every resource lives in this region unless the caller says
# otherwise, and exporting it keeps the CLI, the waiter and `aws logs tail` in one place.
export AWS_REGION="${AWS_REGION:-eu-central-1}"

CLUSTER="auth-platform-$ENVIRONMENT"
PREFIX="auth-platform-$ENVIRONMENT"

service_exists() {
  local status
  status=$(aws ecs describe-services --cluster "$CLUSTER" --services "$PREFIX-identity" \
    --query 'services[0].status' --output text 2>/dev/null)
  [ "$status" = "ACTIVE" ]
}

if ! service_exists; then
  echo "error: service $PREFIX-identity is not ACTIVE in cluster $CLUSTER" >&2
  echo "       run 'make bootstrap && make apply ENV=$ENVIRONMENT' first" >&2
  exit 1
fi

# The awsvpc configuration the platform's own services were created with. Space-separated
# from --output text, comma-separated on the wire.
SUBNETS=$(aws ecs describe-services --cluster "$CLUSTER" --services "$PREFIX-identity" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration.subnets' --output text | tr ' ' ',')
SECURITY_GROUPS=$(aws ecs describe-services --cluster "$CLUSTER" --services "$PREFIX-identity" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration.securityGroups' --output text | tr ' ' ',')
NETWORK="awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SECURITY_GROUPS],assignPublicIp=ENABLED}"

# run_task <service> <command...> — starts one task, waits for it, fails loudly with the
# task's own log stream when the container exits non-zero.
run_task() {
  local service="$1"
  shift
  local family="$PREFIX-$service"
  local command_json task_arn exit_code reason

  command_json=$(printf '"%s",' "$@" | sed 's/,$//')
  task_arn=$(aws ecs run-task \
    --cluster "$CLUSTER" \
    --task-definition "$family" \
    --launch-type FARGATE \
    --network-configuration "$NETWORK" \
    --overrides "{\"containerOverrides\":[{\"name\":\"$service\",\"command\":[$command_json]}]}" \
    --query 'tasks[0].taskArn' --output text)

  echo "  started $task_arn"
  aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$task_arn"

  exit_code=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task_arn" \
    --query 'tasks[0].containers[0].exitCode' --output text)
  if [ "$exit_code" = "0" ]; then
    return 0
  fi

  reason=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task_arn" \
    --query 'tasks[0].stoppedReason' --output text)
  echo "  failed: container exit=$exit_code, task: $reason" >&2
  # The container's own output is the diagnosis; the API only knows it died.
  aws logs tail "/auth-platform/$ENVIRONMENT/$service" --since 10m --format short 2>/dev/null | tail -40 >&2 || true
  return 1
}

case "$ACTION" in
  db-init)
    echo "db-init: creating databases on the $ENVIRONMENT stack"
    # One task is enough: the script rewrites its own DATABASE_URL to the maintenance
    # database, and every database lives on the same instance.
    run_task identity bash tools/create-databases.sh
    echo "db-init: done"
    ;;

  migrate)
    echo "migrate: applying Prisma migrations on the $ENVIRONMENT stack"
    while read -r svc db; do
      [ -n "${svc:-}" ] || continue
      case "$svc" in \#*) continue ;; esac # header comment in the pairs file
      printf 'migrate: %s -> %s\n' "$svc" "$db"
      run_task "$svc" npx prisma migrate deploy --schema "prisma/$svc/schema.prisma"
    done < "$ROOT/tools/service-dbs.pairs"
    echo "migrate: done"
    ;;
esac
