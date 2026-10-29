variable "name_prefix" {
  description = "Prefix for every resource name, e.g. `auth-platform-dev`."
  type        = string
}

variable "environment" {
  description = "Environment tag, e.g. `dev` or `prod`."
  type        = string
}

variable "private_subnet_ids" {
  description = "Subnets for the database and the cache — the ones with no route to the internet."
  type        = list(string)
}

variable "security_group_ids" {
  description = "Security groups for the data tier, as produced by the network module."
  type = object({
    db    = string
    redis = string
  })
}

variable "db_instance_class" {
  description = "RDS instance class. `db.t4g.micro` is enough for a single-tenant dev stack."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_engine_version" {
  description = "Postgres engine version. The services' Prisma schemas target Postgres 16."
  type        = string
  default     = "16"
}

variable "db_master_password" {
  description = <<-EOT
    Master password for Postgres. Null generates one with `random_password` and keeps it in
    state — fine for dev, set it from a secret store for prod. Never a literal in git.
  EOT
  type        = string
  default     = null
  sensitive   = true
}

variable "db_multi_az" {
  description = "Multi-AZ failover. Off for dev (a second AZ costs real money), on for prod."
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  description = "Backup retention. 0 disables automated backups entirely — acceptable only for throwaway stacks."
  type        = number
  default     = 7
}

variable "redis_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t4g.micro"
}

variable "redis_engine_version" {
  description = "Redis engine version for the shared cache, queue and rate-limit store."
  type        = string
  default     = "7.0"
}
