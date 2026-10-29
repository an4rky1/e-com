# Local-emulator overrides for `tools/local-infra-test.sh` (not auto-loaded — pass it
# with `-var-file=local.tfvars`).
#
# desired_count = 0 because a first apply has no images in the emulator's ECR yet: the
# resources, wiring and drift checks are what this run proves, and a task that cannot pull
# would only prove Docker is not connected. Scale it back to 1 after `make push`.
desired_count      = 0
log_retention_days = 7

# TLS on, against a zone this run creates: the certificate, its validation records, the
# completed validation and the 443 listener are all part of what the drift check proves.
# The emulator cannot observe DNS (see the ACM patch in tools/local-infra-test.sh), so
# validation completes instantly there — the wiring is what is under test, not the wait.
tls = {
  domain_name       = "dev.auth.test"
  route53_zone_name = "auth.test."
}
