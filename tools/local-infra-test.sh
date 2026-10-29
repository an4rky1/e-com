#!/usr/bin/env bash
#
# Full Terraform apply against a local AWS emulator — no credentials, no bill, no account.
#
# The trick the design leans on: nothing in infra/ names an emulator. The provider block is
# `region` and nothing else, so exporting AWS_ENDPOINT_URL + fake credentials redirects the
# same configuration to moto. One configuration, two backends, no `if local` branches.
#
# What it proves, in order:
#   1. bootstrap applies (state bucket, lock table, the twelve ECR repositories)
#   2. envs/dev applies with -var-file=local.tfvars (desired_count = 0: no images to pull)
#   3. a second plan is empty — resources and wiring are stable, not merely creatable
#
# The whole run happens in a throwaway copy of infra/, state included — the emulator's S3
# bucket holds it until the container is replaced — so the real working tree keeps no state
# and the real account is never a typo away.
set -euo pipefail

export AWS_REGION="${AWS_REGION:-eu-central-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"
# A wildcard DNS name that resolves to loopback, not a bare IP — this is load-bearing.
# S3 and S3 Control address their targets as host labels in front of whatever endpoint they
# are given: CreateBucket goes to `<bucket>.<endpoint>`, bucket tags to `<account>.<endpoint>`.
# With 127.0.0.1 those become `auth-platform-tfstate.127.0.0.1`, which no resolver answers
# (terraform's pure-Go resolver never even consults /etc/hosts or nss-myhostname). nip.io
# resolves any number of labels in front of the IP, so every form the SDK can build lands
# back on 127.0.0.1:5000. Needs DNS, like every other hostname on this machine.
ENDPOINT="${AWS_ENDPOINT_URL_OVERRIDE:-http://127.0.0.1.nip.io:5000}"
MOTO_CONTAINER="${MOTO_CONTAINER:-auth-platform-moto}"
MOTO_IMAGE="${MOTO_IMAGE:-motoserver/moto:5.2.4}"

command -v terraform >/dev/null || { echo "error: terraform not found" >&2; exit 1; }
command -v docker >/dev/null || { echo "error: docker not found" >&2; exit 1; }

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# moto models a cache cluster but never fills in its CacheNodes — a real CreateCacheCluster
# always answers with at least one node, and `module.data`'s outputs read
# `cache_nodes[0].address` the way every terraform-aws module does. Without the list, apply
# dies in the outputs with an index error that would read like a bug in this repository.
#
# Two more fields the emulator drops that the configuration reads back: the cache cluster's
# security groups (moto stores them under a name no response shape looks for) and the ECS
# health check grace period (no such attribute on the model at all). Both are ordinary
# attributes in AWS, so both come back empty here and would rewrite on every plan — the
# drift check would fail for a reason that has nothing to do with this repository.
#
# The patch runs as sitecustomize inside the (pinned) container and synthesizes what the real
# API returns; it changes no Terraform and no moto, and a bump of MOTO_IMAGE that breaks it
# fails loudly here rather than silently.
mkdir -p "$WORK/moto-patch"
cat > "$WORK/moto-patch/sitecustomize.py" <<'PY'
try:
    import datetime
    from types import SimpleNamespace
    import moto.elasticache.models as _m

    _orig = _m.CacheCluster.__init__

    def _init(self, *a, **kw):
        _orig(self, *a, **kw)
        region = self.arn.split(":")[3]
        count = getattr(self, "num_cache_nodes", 1) or 1
        self.cache_nodes = [
            SimpleNamespace(
                cache_node_id="%04d" % (i + 1),
                cache_node_status="available",
                cache_node_create_time=datetime.datetime.now(datetime.timezone.utc),
                customer_availability_zone="%sa" % region,
                endpoint=SimpleNamespace(
                    address="%s-%04d.%s.cache.amazonaws.com"
                    % (self.cache_cluster_id, i + 1, region),
                    port=self.port,
                ),
            )
            for i in range(count)
        ]

    _m.CacheCluster.__init__ = _init
except Exception as exc:
    import sys

    print("moto CacheNodes patch failed: %s" % exc, file=sys.stderr)

try:
    import moto.elasticache.models as _ec

    _orig_sg_init = _ec.CacheCluster.__init__

    def _sg_init(self, *a, **kw):
        _orig_sg_init(self, *a, **kw)
        sgs = getattr(self, "security_group_ids", None) or []
        if sgs and isinstance(sgs[0], str):
            self.security_groups = [
                {"SecurityGroupId": sg, "Status": "active"} for sg in sgs
            ]

    _ec.CacheCluster.__init__ = _sg_init
except Exception as exc:
    import sys

    print("moto security groups patch failed: %s" % exc, file=sys.stderr)

try:
    import moto.ecs.models as _em
    import moto.ecs.responses as _er

    _orig_svc_init = _em.Service.__init__

    def _svc_init(self, *a, **kw):
        _orig_svc_init(self, *a, **kw)
        if not hasattr(self, "health_check_grace_period_seconds"):
            self.health_check_grace_period_seconds = None

    _em.Service.__init__ = _svc_init

    _orig_create_service = _er.EC2ContainerServiceResponse.create_service

    def _create_service(self):
        result = _orig_create_service(self)
        try:
            result.result["service"].health_check_grace_period_seconds = self._get_param(
                "healthCheckGracePeriodSeconds"
            )
        except Exception:
            pass
        return result

    _er.EC2ContainerServiceResponse.create_service = _create_service
except Exception as exc:
    import sys

    print("moto health check grace period patch failed: %s" % exc, file=sys.stderr)
PY

echo "==> starting the emulator ($MOTO_IMAGE on $ENDPOINT)"
docker rm -f "$MOTO_CONTAINER" >/dev/null 2>&1 || true
# Fresh container every run: moto's state lives in memory, and yesterday's bucket would
# make today's bootstrap apply fail for a reason that has nothing to do with the code.
docker run -d --name "$MOTO_CONTAINER" -p 5000:5000 \
  -v "$WORK/moto-patch:/patch:ro" -e PYTHONPATH=/patch "$MOTO_IMAGE" >/dev/null

# Every SDK in the path (terraform, aws, curl-with-aws) reads these: the endpoint sends all
# traffic to moto, the fake keys satisfy the signature check.
export AWS_ENDPOINT_URL="$ENDPOINT"
export AWS_ACCESS_KEY_ID=testing
export AWS_SECRET_ACCESS_KEY=testing
export AWS_SESSION=testing
export AWS_EC2_METADATA_DISABLED=true

# --- a throwaway copy of infra/ -------------------------------------------------------
# Local state would otherwise land in the working tree (terraform.tfstate next to the real
# sources), where the next `plan` against real AWS would see a full stack to create. Only
# the provider binaries are shared with the copy, through a symlink: init verifies them
# against the committed lock file — offline, no re-download — and writes everything else
# into the throwaway tree. `envs/dev` keeps its real S3 backend: terraform's backend client
# reads AWS_ENDPOINT_URL like the provider does, so state lands in the emulator's bucket
# exactly as it would in AWS's, and the run proves that leg of the stack too.
cp -r "$REPO_ROOT/infra" "$WORK/infra"
init_dir() {
  rm -rf "$WORK/infra/$1/.terraform"
  mkdir -p "$WORK/infra/$1/.terraform"
  if [ -d "$REPO_ROOT/infra/$1/.terraform/providers" ]; then
    ln -s "$REPO_ROOT/infra/$1/.terraform/providers" "$WORK/infra/$1/.terraform/providers"
  fi
  terraform -chdir="$WORK/infra/$1" init -input=false
}

echo "==> bootstrap: state backend + ECR repositories"
init_dir bootstrap
terraform -chdir="$WORK/infra/bootstrap" apply -input=false -auto-approve

# Only now can envs/dev initialize: its backend probes the very bucket bootstrap just
# created (ListObjectsV2 for workspaces), and against a fresh emulator that bucket is
# seconds old.
echo "==> envs/dev: apply with -var-file=local.tfvars (desired_count=0)"
init_dir envs/dev
terraform -chdir="$WORK/infra/envs/dev" apply -input=false -auto-approve \
  -var-file=local.tfvars

echo "==> envs/dev: a second plan must be empty (drift check)"
set +e
terraform -chdir="$WORK/infra/envs/dev" plan -input=false -detailed-exitcode \
  -var-file=local.tfvars
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  echo "FAIL: the plan after apply is not empty (exit $rc) — resources do not round-trip" >&2
  exit 1
fi

echo "==> outputs (as the emulator resolved them)"
terraform -chdir="$WORK/infra/envs/dev" output -raw alb_dns_name | sed 's/^/  alb_dns_name:   /'
terraform -chdir="$WORK/infra/envs/dev" output -raw cluster_name | sed 's/^/  cluster_name:   /'

echo "local-infra-test: bootstrap applied, env applied, plan clean"
