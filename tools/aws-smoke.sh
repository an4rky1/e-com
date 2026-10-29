#!/usr/bin/env bash
#
# Health-check a deployed environment through the load balancer — the only surface a
# client ever sees, and the one where a correct service behind a wrong rule still reads
# as broken.
#
# Three checks, one per thing that can be silently wrong after a deploy:
#   /           -> 200   the front answers (default listener action, target group healthy)
#   /auth/oauth -> 200   the gateway answers behind the /auth/* rule (rule + its target)
#   /auth/me    -> 401   the edge still refuses an anonymous caller — a 200 here would mean
#                        the guard is gone, which is worse than an outage
#
# Every check retries: Fargate cold starts and a balancer that has not yet marked its
# targets healthy both resolve on their own, and neither is a failure worth waking
# anyone for. Anything still wrong after the window is a real failure.
set -euo pipefail

ENVIRONMENT="${1:-dev}"
export AWS_REGION="${AWS_REGION:-eu-central-1}"

command -v aws >/dev/null || { echo "error: aws CLI not found" >&2; exit 1; }
command -v curl >/dev/null || { echo "error: curl not found" >&2; exit 1; }

if [ -z "${ALB_DNS:-}" ]; then
  aws sts get-caller-identity >/dev/null || {
    echo "error: AWS credentials not found (aws sts get-caller-identity)" >&2
    exit 1
  }
  ALB_DNS=$(aws elbv2 describe-load-balancers --names "auth-platform-$ENVIRONMENT-alb" \
    --query 'LoadBalancers[0].DNSName' --output text 2>/dev/null || true)
fi

if [ -z "$ALB_DNS" ] || [ "$ALB_DNS" = "None" ]; then
  echo "error: no load balancer named auth-platform-$ENVIRONMENT-alb in $AWS_REGION" >&2
  echo "       run 'make apply ENV=$ENVIRONMENT' first, or set ALB_DNS" >&2
  exit 1
fi

BASE="http://$ALB_DNS"
DEADLINE=$(( $(date +%s) + 120 ))

pass=0
fail=0

# expect <label> <path> <wanted-code> — polls until the deadline; the first answer that
# sticks is the one reported.
expect() {
  local label="$1" path="$2" wanted="$3" code=""
  while :; do
    code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$BASE$path" || echo 000)
    if [ "$code" = "$wanted" ]; then
      printf '  \033[32mPASS\033[0m %s (%s)\n' "$label" "$code"
      pass=$((pass + 1))
      return 0
    fi
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then
      printf '  \033[31mFAIL\033[0m %s (wanted=%s got=%s)\n' "$label" "$wanted" "$code"
      fail=$((fail + 1))
      return 0
    fi
    sleep 5
  done
}

echo "smoke: $BASE (env=$ENVIRONMENT)"
expect "front answers /" "/" "200"
expect "gateway answers /auth/oauth behind the /auth/* rule" "/auth/oauth" "200"
expect "anonymous caller is refused at /auth/me" "/auth/me" "401"

echo "smoke: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
