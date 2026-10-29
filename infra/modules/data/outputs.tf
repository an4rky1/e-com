output "db_address" {
  description = "Hostname of the Postgres instance (no port)."
  value       = aws_db_instance.main.address
}

output "db_port" {
  description = "Port of the Postgres instance."
  value       = aws_db_instance.main.port
}

output "db_password" {
  description = "Master password — sensitive because it lands in the app secret next."
  value       = local.db_password
  sensitive   = true
}

output "db_identifier" {
  description = "Identifier of the instance, for anything that logs or tags around it."
  value       = aws_db_instance.main.identifier
}

output "redis_address" {
  description = "Hostname of the Redis cache node."
  value       = aws_elasticache_cluster.main.cache_nodes[0].address
}

output "redis_url" {
  description = "Connection URL the services read as REDIS_URL."
  value       = "redis://${aws_elasticache_cluster.main.cache_nodes[0].address}:${aws_elasticache_cluster.main.port}"
  sensitive   = true
}
