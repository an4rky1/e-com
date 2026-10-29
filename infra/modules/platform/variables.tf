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
