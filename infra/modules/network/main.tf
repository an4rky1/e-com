/**
 * @fileoverview VPC, subnets, routing and the security groups every other module hangs off.
 *
 * @remarks Security groups carry the actual security posture here, because with `awsvpc`
 * tasks each service gets its own ENI and SG references scale with the group, not with
 * addresses: no rule below names a CIDR for service-to-service traffic. The only wide rule
 * is the load balancer's 80/0.0.0.0/0 — it is the one surface that must be reachable.
 *
 * @remarks `self = true` on the service group is what lets the gateway dial any peer on any
 * gRPC port without enumerating twelve ports per service, and it is scoped to the group:
 * a task can only reach tasks that carry the same tag of trust.
 */

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = length(var.availability_zones) > 0 ? var.availability_zones : slice(data.aws_availability_zones.available.names, 0, 2)

  # 4 bits each: public 0-3, private 8-11, leaving room to grow inside the /16.
  public_cidrs  = [for i in range(length(local.azs)) : cidrsubnet(var.vpc_cidr, 4, i)]
  private_cidrs = [for i in range(length(local.azs)) : cidrsubnet(var.vpc_cidr, 4, i + 8)]

  common_tags = {
    ManagedBy   = "terraform"
    Environment = var.environment
    Project     = "auth-platform"
  }
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true # Cloud Map's private DNS names resolve only if the VPC asks for them.

  tags = merge(local.common_tags, { Name = "${var.name_prefix}-vpc" })
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = merge(local.common_tags, { Name = "${var.name_prefix}-igw" })
}

resource "aws_subnet" "public" {
  count = length(local.public_cidrs)

  vpc_id                  = aws_vpc.main.id
  cidr_block              = local.public_cidrs[count.index]
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true # Tasks here pull from ECR directly; see the file header.

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-public-${local.azs[count.index]}"
    Tier = "public"
  })
}

resource "aws_subnet" "private" {
  count = length(local.private_cidrs)

  vpc_id            = aws_vpc.main.id
  cidr_block        = local.private_cidrs[count.index]
  availability_zone = local.azs[count.index]

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-private-${local.azs[count.index]}"
    Tier = "private"
  })
}

# --- Routing -------------------------------------------------------------------
# Public subnets route to the internet gateway. Private subnets keep the VPC's local
# routes only: nothing inside them initiates an outbound connection, so a NAT gateway
# would buy no reachability today — only a bill.

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = merge(local.common_tags, { Name = "${var.name_prefix}-public" })
}

resource "aws_route_table_association" "public" {
  count = length(aws_subnet.public)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  tags = merge(local.common_tags, { Name = "${var.name_prefix}-private" })
}

resource "aws_route_table_association" "private" {
  count = length(aws_subnet.private)

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# --- Security groups -----------------------------------------------------------

resource "aws_security_group" "alb" {
  name        = "${var.name_prefix}-alb"
  description = "Public edge: HTTP in from anywhere, nothing else."
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTP from the internet"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "${var.name_prefix}-alb" })
}

resource "aws_security_group" "service" {
  name        = "${var.name_prefix}-service"
  description = "Fargate tasks: peer traffic inside the group, HTTP from the balancer."
  vpc_id      = aws_vpc.main.id

  # Service to service — every port, because gRPC peers listen on their own numbers and
  # enumerating them here would be a second copy of the service catalog to keep in sync.
  ingress {
    description = "Task to task within the group"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    self        = true
  }

  # Only the two containers the balancer targets listen on 3000; health checks arrive
  # on the same port, so this rule covers both the routing and the probe.
  ingress {
    description     = "Balancer to front and gateway"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  tags = merge(local.common_tags, { Name = "${var.name_prefix}-service" })
}

resource "aws_security_group" "db" {
  name        = "${var.name_prefix}-db"
  description = "Postgres from tasks only."
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Postgres from task security group"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
  }

  tags = merge(local.common_tags, { Name = "${var.name_prefix}-db" })
}

resource "aws_security_group" "redis" {
  name        = "${var.name_prefix}-redis"
  description = "Redis from tasks only."
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Redis from task security group"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
  }

  tags = merge(local.common_tags, { Name = "${var.name_prefix}-redis" })
}
