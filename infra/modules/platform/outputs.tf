output "cluster_name" {
  description = "ECS cluster name — `make status` targets this."
  value       = aws_ecs_cluster.main.name
}

output "alb_dns_name" {
  description = "Public hostname of the load balancer. This is the front's origin once TLS exists."
  value       = aws_lb.main.dns_name
}

output "alb_zone_id" {
  description = "Canonical hosted zone of the balancer, for a future Route53 alias record."
  value       = aws_lb.main.zone_id
}

output "gateway_url" {
  description = "Gateway as the VPC sees it — the value the front is built with."
  value       = "http://${local.discovery["api-gateway"]}:3000"
}

output "service_names" {
  description = "ECS service names, keyed by catalog entry."
  value       = { for name in keys(local.services) : name => aws_ecs_service.services[name].name }
}

output "ecr_repository_urls" {
  description = "Image repository per service — what `make push` targets."
  value       = { for name in keys(local.services) : name => data.aws_ecr_repository.services[name].repository_url }
}

output "log_group_names" {
  description = "CloudWatch log group per service."
  value       = { for name in keys(local.services) : name => aws_cloudwatch_log_group.services[name].name }
}

output "secret_arn" {
  description = "ARN of the app secret every task reads from."
  value       = aws_secretsmanager_secret.app.arn
}

output "cloud_map_namespace" {
  description = "Private DNS namespace peer addresses live in."
  value       = var.enable_service_discovery ? aws_service_discovery_private_dns_namespace.main[0].name : null
}

output "container_env" {
  description = "Env map per container, exactly as the task definitions carry it. Exposed for tests."
  value       = local.container_env
}

output "container_secrets" {
  description = "Secret key list per container, exactly as the task definitions carry it. Exposed for tests."
  value       = local.container_secrets
}

output "task_definition" {
  description = "Per service: what ECS is told to run — family, size, network mode and the container JSON. Exposed for tests."
  value = {
    for name, task in aws_ecs_task_definition.services :
    name => {
      family                = task.family
      cpu                   = task.cpu
      memory                = task.memory
      network_mode          = task.network_mode
      container_definitions = task.container_definitions
    }
  }
}

output "service_wiring" {
  description = "Per service: how it hangs off the balancer and Cloud Map, as the ECS services declare it. Exposed for tests."
  value = {
    for name, service in aws_ecs_service.services :
    name => {
      behind_balancer = length(service.load_balancer) > 0
      in_cloud_map    = length(service.service_registries) > 0
      container_port  = try(one(service.load_balancer).container_port, null)
    }
  }
}

output "listener_shape" {
  description = <<-EOT
    What the balancer answers on 80, and what on 443 when TLS is on. Everything here is
    configuration-derived, so it is known at plan — which is what lets an offline test
    assert the shape without a certificate, a zone or an account. Exposed for tests.
  EOT
  value = {
    http_action = local.tls_enabled ? "redirect" : "forward"
    https = local.tls_enabled ? {
      port       = 443
      domain     = var.tls.domain_name
      ssl_policy = var.tls.ssl_policy
      zone       = var.tls.route53_zone_name != null ? var.tls.route53_zone_name : var.tls.route53_zone_id
    } : null
  }
}

output "autoscaling_wiring" {
  description = <<-EOT
    Per service: the scaling target and its bounds, as registered with Application Auto
    Scaling. Configuration-derived (known at plan) except nothing — exposed for tests.
  EOT
  value = {
    enabled            = var.autoscaling.enabled
    cpu_target_percent = var.autoscaling.cpu_target_percent
    scale_in_cooldown  = var.autoscaling.scale_in_cooldown
    scale_out_cooldown = var.autoscaling.scale_out_cooldown
    services = {
      for name, target in aws_appautoscaling_target.services :
      name => {
        resource_id  = target.resource_id
        min_capacity = target.min_capacity
        max_capacity = target.max_capacity
      }
    }
  }
}

