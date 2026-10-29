/**
 * @fileoverview Version and provider requirements for the data module.
 *
 * @remarks `random` supplies the database password when the operator does not hand one in:
 * a password that must exist before the first apply cannot come from a variable nobody has
 * set yet, and it must not be a literal in the repository either.
 */
terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0, < 7.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.5"
    }
  }
}
