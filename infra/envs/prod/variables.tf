/**
 * @fileoverview Inputs for the prod environment.
 *
 * @remarks Defaults ARE the prod values, and `terraform.tfvars` restates them out loud.
 * This file is a byte-for-byte sibling of `../dev/variables.tf` except for the two
 * environment defaults — same names, same shape — so a new input is added to both by
 * copy and can never be prod-only.
 */
variable "aws_region" {
  description = "Region for every resource in this environment."
  type        = string
  default     = "eu-central-1"
}

variable "environment" {
  description = "Environment name. Names the VPC, the services and the Cloud Map namespace."
  type        = string
  default     = "prod"
}

variable "vpc_cidr" {
  description = "CIDR for the environment's VPC."
  type        = string
  default     = "10.30.0.0/16"
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
