/**
 * @fileoverview Version and provider requirements for the state backend.
 *
 * @remarks Bootstrap is the only directory in this repository that is applied with real
 * AWS credentials before anything else exists — S3 and DynamoDB for the Terraform state of
 * every environment. It is deliberately tiny: the moment this grows a second concern, the
 * chicken-and-egg problem it solves (state needs infrastructure) starts solving itself.
 */
terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0, < 7.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}
