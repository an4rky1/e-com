/**
 * @fileoverview VPC topology for one environment.
 *
 * @remarks The MVP shape is two public and two private subnets across two AZs and **no NAT
 * gateway**: Fargate tasks sit in the public subnets with `assign_public_ip` so they can pull
 * from ECR without a NAT bill, while RDS and ElastiCache take the private subnets where no
 * route to the internet exists. Everything that must not be reached from outside — the
 * databases — is in the subnets with no inbound path. The documented upgrade for a harder
 * deployment is a NAT gateway (or VPC endpoints) and moving the tasks behind it; the module
 * keeps the split in place so that move changes routing, not structure.
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
