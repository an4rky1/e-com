/**
 * @fileoverview The stateful tier: one Postgres instance, one Redis node, no public face.
 *
 * @remarks One RDS instance serves all ten databases rather than one instance per service:
 * the services are separated by *database name*, not by server, and ten micro-instances
 * would be ten bills for a separation Postgres already enforces. The names live in the
 * platform module's service catalog (they are the same names `tools/migrate.sh` uses
 * locally), while this module owns only the server they run on.
 *
 * @remarks `skip_final_snapshot = true` and no deletion protection are deliberate dev
 * defaults; the prod environment overrides both through its tfvars. Destroying a dev
 * database should not require a snapshot funeral to complete.
 *
 * @remarks The ElastiCache node is a single cache node, not a replication group. Failover
 * and replicas are the upgrade; a cluster with one member is what the platform's cache,
 * BullMQ and rate limiting actually need today.
 */

locals {
  db_password = var.db_master_password != null ? var.db_master_password : random_password.db[0].result
}

resource "random_password" "db" {
  count = var.db_master_password == null ? 1 : 0

  length  = 32
  special = false # A URL-embedded password must not need percent-encoding to connect.
}

resource "aws_db_subnet_group" "main" {
  name       = "${var.name_prefix}-db"
  subnet_ids = var.private_subnet_ids

  tags = {
    Name        = "${var.name_prefix}-db"
    ManagedBy   = "terraform"
    Environment = var.environment
  }
}

resource "aws_db_instance" "main" {
  identifier = "${var.name_prefix}-db"

  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = "postgres"
  username = "postgres"
  password = local.db_password

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [var.security_group_ids.db]
  publicly_accessible    = false

  multi_az                = var.db_multi_az
  backup_retention_period = var.db_backup_retention_days
  deletion_protection     = var.environment == "prod"
  skip_final_snapshot     = var.environment != "prod"

  tags = {
    Name        = "${var.name_prefix}-db"
    ManagedBy   = "terraform"
    Environment = var.environment
  }
}

resource "aws_elasticache_subnet_group" "main" {
  name       = "${var.name_prefix}-redis"
  subnet_ids = var.private_subnet_ids
}

resource "aws_elasticache_cluster" "main" {
  cluster_id           = "${var.name_prefix}-redis"
  engine               = "redis"
  engine_version       = var.redis_engine_version
  node_type            = var.redis_node_type
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  port                 = 6379

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [var.security_group_ids.redis]

  tags = {
    Name        = "${var.name_prefix}-redis"
    ManagedBy   = "terraform"
    Environment = var.environment
  }
}
