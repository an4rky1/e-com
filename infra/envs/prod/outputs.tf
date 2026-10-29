/**
 * @fileoverview What an operator actually needs from a dev apply.
 */
output "alb_dns_name" {
  description = "Public hostname of the load balancer — the front's origin over plain HTTP."
  value       = module.platform.alb_dns_name
}

output "gateway_url" {
  description = "Gateway address as the VPC resolves it (what the front is built with)."
  value       = module.platform.gateway_url
}

output "cluster_name" {
  description = "ECS cluster name for `make status`."
  value       = module.platform.cluster_name
}

output "service_names" {
  description = "ECS service names for `make status`."
  value       = module.platform.service_names
}

output "secret_arn" {
  description = "App secret every task reads from."
  value       = module.platform.secret_arn
  sensitive   = true
}

output "ecr_repository_urls" {
  description = "Where `make push` puts each service's image."
  value       = module.platform.ecr_repository_urls
}
