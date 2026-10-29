/**
 * @fileoverview Inputs for the dev environment.
 *
 * @remarks Defaults ARE the dev values: a bare `terraform apply` in this directory builds
 * a dev stack, and `terraform.tfvars` says so out loud rather than relying on that. The
 * prod directory overrides the same names with the same structure — the two files differ
 * in defaults and tfvars, never in shape, so a new input lands in both by copy.
 */
variable "aws_region" {
  description = "Region for every resource in this environment."
  type        = string
  default     = "eu-central-1"
}

variable "environment" {
  description = "Environment name. Names the VPC, the services and the Cloud Map namespace."
  type        = string
  default     = "dev"
}

variable "vpc_cidr" {
  description = "CIDR for the environment's VPC."
  type        = string
  default     = "10.20.0.0/16"
}

variable "image_tag" {
  description = "Tag of the images to run. `make deploy` passes the git SHA."
  type        = string
  default     = "latest"
}

variable "desired_count" {
  description = "Tasks per service. 0 scales the whole platform down without destroying it."
  type        = number
  default     = 1
}

variable "db_instance_class" {
  description = "Postgres instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_engine_version" {
  description = "Postgres engine version."
  type        = string
  default     = "16"
}

variable "db_multi_az" {
  description = "Multi-AZ failover for Postgres."
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  description = "Automated backup retention; 0 disables backups."
  type        = number
  default     = 7
}

variable "redis_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t4g.micro"
}

variable "redis_engine_version" {
  description = "Redis engine version."
  type        = string
  default     = "7.0"
}

variable "task_cpu" {
  description = "Fargate CPU units per backend task."
  type        = string
  default     = "256"
}

variable "task_memory" {
  description = "Fargate memory (MiB) per backend task."
  type        = string
  default     = "512"
}

variable "front_cpu" {
  description = "Fargate CPU units for the front task."
  type        = string
  default     = "512"
}

variable "front_memory" {
  description = "Fargate memory (MiB) for the front task."
  type        = string
  default     = "1024"
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention per service."
  type        = number
  default     = 30
}

variable "kafka_enabled" {
  description = "Hand KAFKA_ENABLED to tasks. False until an event bus exists in this stack."
  type        = bool
  default     = false
}

variable "enable_service_discovery" {
  description = "Register tasks in Cloud Map. Only disabled for emulators that cannot."
  type        = bool
  default     = true
}

variable "oauth" {
  description = "OAuth walk configuration. Empty disables every provider, like an empty .env.local."
  type = object({
    public_origin = optional(string, "")
    state_secret  = optional(string)
    google = optional(object({
      client_id     = string
      client_secret = string
    }))
    github = optional(object({
      client_id     = string
      client_secret = string
    }))
    telegram = optional(object({
      bot_token    = string
      bot_username = string
    }))
  })
  default = {}
}

variable "grpc_service_token" {
  description = "Shared gRPC service token. Null generates one and keeps it in state."
  type        = string
  default     = null
}

variable "session_access_token_signing_key" {
  description = "Access-token signing key. Null generates one."
  type        = string
  default     = null
}

variable "session_refresh_token_pepper" {
  description = "Refresh-token pepper. Null generates one."
  type        = string
  default     = null
}

variable "vault_pepper" {
  description = "Password-hash pepper. Null generates one."
  type        = string
  default     = null
}

variable "mfa_secret_encryption_key" {
  description = "MFA secret-encryption key. Null generates one."
  type        = string
  default     = null
}

variable "gateway_jwt_secret" {
  description = "Gateway JWT secret. Null generates one."
  type        = string
  default     = null
}

variable "tls" {
  description = "Balancer TLS. Passed through to the platform module, which owns the semantics: domain_name plus a Route53 zone (existing by id, or created by name) opens 443 behind a DNS-validated ACM certificate and turns port 80 into a 301 to https. Empty keeps the stack HTTP-only."
  type = object({
    domain_name       = optional(string)
    route53_zone_id   = optional(string)
    route53_zone_name = optional(string)
    ssl_policy        = optional(string, "ELBSecurityPolicy-TLS13-1-2-2021-06")
  })
  default = {}

  # The domain/zone pairing, validated here rather than inside the module: a child
  # module's variable failures are not addressable by expect_failures, and the offline
  # suite asserts exactly this refusal.
  validation {
    condition = (
      var.tls.domain_name == null ||
      var.tls.route53_zone_id != null || var.tls.route53_zone_name != null
    )
    error_message = "tls.domain_name needs a zone: set route53_zone_id (existing) or route53_zone_name (create one)."
  }

  validation {
    condition     = var.tls.domain_name != null || (var.tls.route53_zone_id == null && var.tls.route53_zone_name == null)
    error_message = "a route53 zone without tls.domain_name names a zone for no certificate; set the domain or drop the zone."
  }

  validation {
    condition     = !(var.tls.route53_zone_id != null && var.tls.route53_zone_name != null)
    error_message = "give exactly one zone: route53_zone_id for one that exists, route53_zone_name for one to create."
  }
}

variable "autoscaling" {
  description = "ECS target-tracking autoscaling, passed through to the platform module. On by default; enabled = false pins desired_count as the whole story."
  type = object({
    enabled            = optional(bool, true)
    min_capacity       = optional(number, 1)
    max_capacity       = optional(number, 4)
    cpu_target_percent = optional(number, 60)
    scale_in_cooldown  = optional(number, 300)
    scale_out_cooldown = optional(number, 60)
  })
  default = {}
}
