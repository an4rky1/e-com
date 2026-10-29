output "vpc_id" {
  description = "VPC everything else is placed in."
  value       = aws_vpc.main.id
}

output "vpc_cidr" {
  description = "CIDR of the VPC."
  value       = aws_vpc.main.cidr_block
}

output "public_subnet_ids" {
  description = "Subnets for the load balancer and the Fargate tasks."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Subnets for RDS and ElastiCache."
  value       = aws_subnet.private[*].id
}

output "availability_zones" {
  description = "AZs the subnets were spread over."
  value       = local.azs
}

output "security_group_ids" {
  description = "Security groups keyed by the traffic they gate."
  value = {
    alb     = aws_security_group.alb.id
    service = aws_security_group.service.id
    db      = aws_security_group.db.id
    redis   = aws_security_group.redis.id
  }
}
