output "state_bucket" {
  description = "Bucket every environment's backend block points at."
  value       = aws_s3_bucket.state.bucket
}

output "lock_table" {
  description = "Lock table every environment's backend block points at."
  value       = aws_dynamodb_table.locks.name
}

output "ecr_repository_urls" {
  description = "Image repository per service — what `make push` targets."
  value       = { for name, repo in aws_ecr_repository.apps : name => repo.repository_url }
}
