variable "aws_region" {
  description = "Region for the state bucket and the lock table. Must match the region every environment's backend block names."
  type        = string
  default     = "eu-central-1"
}

variable "state_bucket" {
  description = <<-EOT
    Name of the S3 bucket holding Terraform state. Coupled by design: every
    `infra/envs/*/backend.tf` repeats this string, because a backend block cannot take
    variables — changing it means changing all three places in one commit.
  EOT
  type        = string
  default     = "auth-platform-tfstate"
}

variable "lock_table" {
  description = "DynamoDB table used for state locking. Same three-place coupling as the bucket name."
  type        = string
  default     = "auth-platform-locks"
}

variable "ecr_repository_prefix" {
  description = "Repository namespace: one `<prefix>/<service>` per catalog entry. Coupled to the platform module's default."
  type        = string
  default     = "auth-platform"
}

variable "ecr_force_delete" {
  description = "Allow destroying non-empty repositories. Keep false unless the images are disposable."
  type        = bool
  default     = false
}
