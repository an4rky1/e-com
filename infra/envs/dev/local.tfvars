# Local-emulator overrides for `tools/local-infra-test.sh` (not auto-loaded — pass it
# with `-var-file=local.tfvars`).
#
# desired_count = 0 because a first apply has no images in the emulator's ECR yet: the
# resources, wiring and drift checks are what this run proves, and a task that cannot pull
# would only prove Docker is not connected. Scale it back to 1 after `make push`.
desired_count      = 0
log_retention_days = 7
