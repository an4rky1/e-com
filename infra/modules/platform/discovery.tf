/**
 * @fileoverview Cloud Map: the DNS layer ECS tasks find each other through.
 *
 * @remarks One private namespace per environment — `<env>.auth.internal` — and one A-record
 * service per backend. ECS registers each task's ENI address under its service name, so
 * `identity.dev.auth.internal` always resolves to the running identity task and nothing
 * else. The name set matches the Makefile exactly: `AWS_GATEWAY_URL` is
 * `http://api-gateway.$(ENV).auth.internal:3000`.
 *
 * @remarks The namespace is private to the VPC. Nothing outside the VPC can resolve these
 * names, which is what makes the gateway's peer table useless to anyone who reaches it.
 *
 * @remarks `enable_service_discovery` exists as an escape hatch: an emulator that cannot
 * register tasks should cost a flag, not the whole apply.
 */

resource "aws_service_discovery_private_dns_namespace" "main" {
  count = var.enable_service_discovery ? 1 : 0

  name        = "${var.environment}.auth.internal"
  description = "Internal service addresses for ${var.name_prefix}"
  vpc         = var.vpc_id

  tags = {
    Name        = "${var.environment}.auth.internal"
    ManagedBy   = "terraform"
    Environment = var.environment
  }
}

resource "aws_service_discovery_service" "services" {
  for_each = var.enable_service_discovery ? local.backends : {}

  name        = each.key
  description = "${each.key} tasks in ${var.name_prefix}"
  dns_config {
    # The namespace lives inside dns_config — aws provider v6 moved it there.
    namespace_id = aws_service_discovery_private_dns_namespace.main[0].id

    dns_records {
      type = "A"
      ttl  = 10
    }
    routing_policy = "MULTIVALUE"
  }

  # Required in shape, not in arguments: ECS only registers tasks under a service that
  # declares custom health checks (so discovery reports a task healthy only while its own
  # probe answers). `failure_threshold` is deprecated — AWS pins it at 1 — but it has to be
  # stated: an empty block is never sent on create, so the read comes back without the
  # block and the service is replaced on every plan.
  health_check_custom_config {
    failure_threshold = 1
  }

  tags = {
    Service     = each.key
    ManagedBy   = "terraform"
    Environment = var.environment
  }
}
