/**
 * @fileoverview Prod environment: provider, modules, wiring.
 *
 * @remarks The provider block is deliberately bare — region and nothing else. The local
 * emulator run works through `AWS_ENDPOINT_URL` and fake credentials exported by
 * `tools/local-infra-test.sh`, which the provider honours without a single line of
 * Terraform changing. One configuration, two backends, no `if local` branches to drift.
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

provider "aws" {
  region = var.aws_region
}

locals {
  name_prefix = "auth-platform-${var.environment}"
}

module "network" {
  source = "../../modules/network"

  name_prefix = local.name_prefix
  environment = var.environment
  vpc_cidr    = var.vpc_cidr
}

module "data" {
  source = "../../modules/data"

  name_prefix        = local.name_prefix
  environment        = var.environment
  private_subnet_ids = module.network.private_subnet_ids
  security_group_ids = {
    db    = module.network.security_group_ids.db
    redis = module.network.security_group_ids.redis
  }

  db_instance_class        = var.db_instance_class
  db_engine_version        = var.db_engine_version
  db_multi_az              = var.db_multi_az
  db_backup_retention_days = var.db_backup_retention_days
  redis_node_type          = var.redis_node_type
  redis_engine_version     = var.redis_engine_version
}

module "platform" {
  source = "../../modules/platform"

  name_prefix       = local.name_prefix
  environment       = var.environment
  aws_region        = var.aws_region
  vpc_id            = module.network.vpc_id
  public_subnet_ids = module.network.public_subnet_ids
  security_group_ids = {
    alb     = module.network.security_group_ids.alb
    service = module.network.security_group_ids.service
  }

  db = {
    address  = module.data.db_address
    port     = module.data.db_port
    password = module.data.db_password
  }
  redis_url = module.data.redis_url

  image_tag                = var.image_tag
  desired_count            = var.desired_count
  task_cpu                 = var.task_cpu
  task_memory              = var.task_memory
  front_cpu                = var.front_cpu
  front_memory             = var.front_memory
  log_retention_days       = var.log_retention_days
  kafka_enabled            = var.kafka_enabled
  enable_service_discovery = var.enable_service_discovery
  oauth                    = var.oauth
  tls                      = var.tls
  autoscaling              = var.autoscaling

  grpc_service_token               = var.grpc_service_token
  session_access_token_signing_key = var.session_access_token_signing_key
  session_refresh_token_pepper     = var.session_refresh_token_pepper
  vault_pepper                     = var.vault_pepper
  mfa_secret_encryption_key        = var.mfa_secret_encryption_key
  gateway_jwt_secret               = var.gateway_jwt_secret
}
