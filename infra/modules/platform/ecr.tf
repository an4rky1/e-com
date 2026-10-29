/**
 * @fileoverview The ECR repositories are looked up, never created here.
 *
 * @remarks `auth-platform/<service>` is shared by every environment — one image per git
 * SHA, one repository per service, and `make push` addresses them without knowing which
 * environment is deploying. Creating them in an environment's state would have two states
 * fighting over one name, so `infra/bootstrap` owns them and this module only resolves
 * them at plan time.
 */
data "aws_ecr_repository" "services" {
  for_each = local.services

  name = "${var.ecr_repository_prefix}/${each.key}"
}
