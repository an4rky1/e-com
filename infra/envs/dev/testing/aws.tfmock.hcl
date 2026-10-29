/**
 * @fileoverview Mock data for `make infra-test`: the AWS provider, minus AWS.
 *
 * Loaded by `platform.tftest.hcl` through `mock_provider "aws" { source = "./testing" }`.
 * Two rules shape every entry:
 *
 * `override_during = plan` — a mock generates computed values during *apply* unless told
 * otherwise, which would leave every ARN "(known after apply)" and no assertion touching
 * one could evaluate. Plan is the run block the tests use, so the values must exist by
 * then. (The provider-level `override_during` does not reach these blocks in Terraform
 * 1.17 — hence it is restated per resource rather than inherited.)
 *
 * `defaults` — the values Terraform would generate on its own are random 8-character
 * strings, which is fine until the AWS provider validates them as ARNs during planning.
 * Anything one resource feeds into another's arguments is pinned to a well-formed
 * example of the real shape, so a test never fails on the generator's formatting.
 */

mock_data "aws_availability_zones" {
  override_during = plan
  defaults = {
    names = ["eu-central-1a", "eu-central-1b"]
  }
}

mock_data "aws_ecr_repository" {
  override_during = plan
  # The shape `make push` addresses: $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/auth-platform/<svc>.
  defaults = {
    repository_url = "123456789012.dkr.ecr.eu-central-1.amazonaws.com/auth-platform/identity"
  }
}

mock_resource "aws_vpc" {
  override_during = plan
  defaults = {
    id = "vpc-0123456789abcdef0"
  }
}

mock_resource "aws_subnet" {
  override_during = plan
  defaults = {
    id = "subnet-0123456789abcdef0"
  }
}

mock_resource "aws_security_group" {
  override_during = plan
  defaults = {
    id = "sg-0123456789abcdef0"
  }
}

mock_resource "aws_internet_gateway" {
  override_during = plan
  defaults = {
    id = "igw-0123456789abcdef0"
  }
}

mock_resource "aws_iam_role" {
  override_during = plan
  defaults = {
    id  = "auth-platform-dev-task"
    arn = "arn:aws:iam::123456789012:role/auth-platform-dev-task"
  }
}

mock_resource "aws_secretsmanager_secret" {
  override_during = plan
  defaults = {
    arn = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:auth-platform-dev/app-AbCdEf"
  }
}

mock_resource "aws_ecs_cluster" {
  override_during = plan
  defaults = {
    id  = "arn:aws:ecs:eu-central-1:123456789012:cluster/auth-platform-dev"
    arn = "arn:aws:ecs:eu-central-1:123456789012:cluster/auth-platform-dev"
  }
}

mock_resource "aws_ecs_task_definition" {
  override_during = plan
  defaults = {
    arn = "arn:aws:ecs:eu-central-1:123456789012:task-definition/auth-platform-dev-identity:1"
  }
}

mock_resource "aws_lb" {
  override_during = plan
  defaults = {
    arn      = "arn:aws:elasticloadbalancing:eu-central-1:123456789012:loadbalancer/app/auth-platform-dev/0123456789abcdef"
    id       = "arn:aws:elasticloadbalancing:eu-central-1:123456789012:loadbalancer/app/auth-platform-dev/0123456789abcdef"
    dns_name = "auth-platform-dev-0123456789.eu-central-1.elb.amazonaws.com"
    zone_id  = "Z0123456789ABCDEF"
  }
}

mock_resource "aws_lb_target_group" {
  override_during = plan
  defaults = {
    arn = "arn:aws:elasticloadbalancing:eu-central-1:123456789012:targetgroup/auth-platform-dev/0123456789abcdef"
    id  = "arn:aws:elasticloadbalancing:eu-central-1:123456789012:targetgroup/auth-platform-dev/0123456789abcdef"
  }
}

mock_resource "aws_lb_listener" {
  override_during = plan
  defaults = {
    arn = "arn:aws:elasticloadbalancing:eu-central-1:123456789012:listener/app/auth-platform-dev/0123456789abcdef/0123456789abcdef"
  }
}

mock_resource "aws_service_discovery_private_dns_namespace" {
  override_during = plan
  defaults = {
    id  = "ns-0123456789abcdef"
    arn = "arn:aws:servicediscovery:eu-central-1:123456789012:namespace/ns-0123456789abcdef"
  }
}

mock_resource "aws_service_discovery_service" {
  override_during = plan
  defaults = {
    id  = "svc-0123456789abcdef"
    arn = "arn:aws:servicediscovery:eu-central-1:123456789012:service/svc-0123456789abcdef"
  }
}
