/**
 * @fileoverview One log group per service, created up front rather than by the task.
 *
 * @remarks The task role may only `PutLogEvents` into groups that already exist — if the
 * task created its own group it would need `logs:CreateLogGroup`, which means every
 * misconfigured stream name silently mints a new group nobody greps. Creating them here
 * keeps retention (a cost and a compliance setting) in Terraform instead of in defaults.
 */
resource "aws_cloudwatch_log_group" "services" {
  for_each = local.services

  name              = "/auth-platform/${var.environment}/${each.key}"
  retention_in_days = var.log_retention_days

  tags = {
    Service     = each.key
    ManagedBy   = "terraform"
    Environment = var.environment
  }
}
