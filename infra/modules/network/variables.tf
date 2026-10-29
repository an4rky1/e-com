variable "name_prefix" {
  description = "Prefix for every resource name, e.g. `auth-platform-dev`."
  type        = string
}

variable "environment" {
  description = "Environment tag, e.g. `dev` or `prod`."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC. Two public and two private subnets are carved from it."
  type        = string
  default     = "10.20.0.0/16"
}

variable "availability_zones" {
  description = <<-EOT
    AZs to spread the subnets over. Defaults to the first two available in the region —
    an explicit list is only needed when a region's zone letters have been remapped for
    the account, which is exactly the case where "the first two" is wrong.
  EOT
  type        = list(string)
  default     = []
}
