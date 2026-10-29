variable "name_prefix" {
  description = "Prefix for every resource name. Also the ECS cluster name — the Makefile's `make status` reads `auth-platform-$(ENV)`."
  type        = string
}

variable "environment" {
  description = "Environment name, e.g. `dev`. Doubles as the Cloud Map namespace: `<environment>.auth.internal`."
  type        = string
}

variable "aws_region" {
  description = "Region, echoed into the awslogs configuration of every task."
  type        = string
}

variable "vpc_id" {
  description = "VPC the cluster, balancer and discovery namespace live in."
  type        = string
}

variable "public_subnet_ids" {
  description = "Subnets for the load balancer and the Fargate tasks."
  type        = list(string)
}

variable "security_group_ids" {
  description = "Security groups for the balancer and the tasks, as produced by the network module."
  type = object({
    alb     = string
    service = string
  })
}

variable "db" {
  description = "Connection facts for the shared Postgres instance, from the data module."
  type = object({
    address  = string
    port     = number
    password = string
  })
  sensitive = true
}

variable "redis_url" {
  description = "REDIS_URL for the shared cache, queue and rate-limit store."
  type        = string
  sensitive   = true
}

variable "image_tag" {
  description = "Tag every service image is pulled at. `make deploy` passes the git SHA here."
  type        = string
  default     = "latest"
}

variable "ecr_repository_prefix" {
  description = <<-EOT
    ECR repository namespace. Repositories are `auth-platform/<service>` and are owned by
    `infra/bootstrap`, not by this module: one set of repositories serves every environment,
    which is exactly how `make push` addresses them. Coupled to bootstrap's default.
  EOT
  type        = string
  default     = "auth-platform"
}

variable "desired_count" {
  description = "Tasks per service. The local emulator run sets 0 — the containers have no images to pull."
  type        = number
  default     = 1
}

variable "task_cpu" {
  description = "Fargate CPU units for a backend task."
  type        = string
  default     = "256"
}

variable "task_memory" {
  description = "Fargate memory (MiB) for a backend task."
  type        = string
  default     = "512"
}

variable "front_cpu" {
  description = "Fargate CPU units for the front task — Next.js renders, it does not only proxy."
  type        = string
  default     = "512"
}

variable "front_memory" {
  description = "Fargate memory (MiB) for the front task."
  type        = string
  default     = "1024"
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for every service's log group."
  type        = number
  default     = 30
}

variable "kafka_enabled" {
  description = <<-EOT
    Value of KAFKA_ENABLED handed to every task. The MVP deploys no event bus, so this
    defaults to false: with it false the producers skip sends and the consumers never dial,
    and the platform boots cleanly instead of retrying a broker that does not exist. Flip
    it once MSK (or a self-hosted bus) is in the stack.
  EOT
  type        = bool
  default     = false
}

variable "enable_service_discovery" {
  description = "Create the Cloud Map namespace and register every backend. Escape hatch for emulators that cannot register tasks."
  type        = bool
  default     = true
}

variable "oauth" {
  description = <<-EOT
    The OAuth walk as the deployed front knows it. Empty (the default) disables every
    provider, exactly like a local checkout with an empty `.env.local`: the platform boots
    and hides the buttons rather than offering a callback that cannot complete. Set
    `public_origin` to the load balancer's origin and fill a provider pair to turn one on.
  EOT
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
  default   = {}
  sensitive = true
}

variable "grpc_service_token" {
  description = "Shared gRPC service token. Null generates one and keeps it in state."
  type        = string
  default     = null
  sensitive   = true
}

variable "session_access_token_signing_key" {
  description = "Key the session service signs with and the edge verifies with. Null generates one."
  type        = string
  default     = null
  sensitive   = true
}

variable "session_refresh_token_pepper" {
  description = "Refresh-token pepper. Null generates one."
  type        = string
  default     = null
  sensitive   = true
}

variable "vault_pepper" {
  description = "Password-hash pepper for the credential vault. Null generates one."
  type        = string
  default     = null
  sensitive   = true
}

variable "mfa_secret_encryption_key" {
  description = "Key the MFA service encrypts TOTP secrets with. Null generates one."
  type        = string
  default     = null
  sensitive   = true
}

variable "gateway_jwt_secret" {
  description = "Gateway JWT secret. Null generates one."
  type        = string
  default     = null
  sensitive   = true
}

variable "tls" {
  description = <<-EOT
    TLS for the balancer. Empty (the default) keeps the stack HTTP-only on port 80, which
    is how the MVP ships. To turn it on, set `domain_name` and point it at a Route53 zone:
    `route53_zone_id` for a zone that already exists, or `route53_zone_name` for one this
    configuration should create. The certificate is requested with DNS validation, its
    validation records land in that zone, and port 443 opens only through
    `aws_acm_certificate_validation` — so the listener can never present a certificate
    nobody has proven control of. Port 80 then answers with a 301 to the same host on
    HTTPS, because an OAuth redirect that bounces through http:// loses the callback.    A domain without a zone is refused at validation time rather than left pending: a
    certificate nobody can validate never reaches a listener, and a plan-time error says
    which half of the pair is missing. The pairing itself is validated on the environment's
    passthrough variable (`envs/*/variables.tf`), not here: a child module's variable
    failures are not addressable by the offline tests, and a refusal nobody can test is a
    refusal that quietly stops existing.
  EOT
  type = object({
    domain_name       = optional(string)
    route53_zone_id   = optional(string)
    route53_zone_name = optional(string)
    ssl_policy        = optional(string, "ELBSecurityPolicy-TLS13-1-2-2021-06")
  })
  default = {}
}

variable "autoscaling" {
  description = <<-EOT
    Target-tracking autoscaling for every ECS service: one policy per service that holds
    average CPU at `cpu_target_percent` between `min_capacity` and `max_capacity` tasks.
    On by default — a platform that only scales by hand is one incident away from a fixed
    ceiling — and switchable off with `enabled = false` for an environment that wants a
    predictable bill instead.
  EOT
  type = object({
    enabled            = optional(bool, true)
    min_capacity       = optional(number, 1)
    max_capacity       = optional(number, 4)
    cpu_target_percent = optional(number, 60)
    scale_in_cooldown  = optional(number, 300)
    scale_out_cooldown = optional(number, 60)
  })
  default = {}

  validation {
    condition     = var.autoscaling.min_capacity <= var.autoscaling.max_capacity
    error_message = "autoscaling.min_capacity must not exceed max_capacity."
  }

  validation {
    condition     = var.autoscaling.cpu_target_percent > 0 && var.autoscaling.cpu_target_percent <= 100
    error_message = "autoscaling.cpu_target_percent is a percentage: 1..100."
  }
}
