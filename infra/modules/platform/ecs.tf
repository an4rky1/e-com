/**
 * @fileoverview The cluster, one task definition and one service per entry in the catalog.
 *
 * @remarks Tasks run in the **public** subnets with `assign_public_ip`: there is no NAT
 * gateway in this MVP, so a private task could not reach ECR at all. The security groups
 * are what make that safe — nothing routes into a task except the load balancer (on the
 * two ports it targets) and sibling tasks (via the group's own self rule). Moving behind
 * a NAT later is a subnet and a boolean, not a redesign.
 *
 * @remarks Both ports a service binds are in its port map: HTTP for probes and gRPC for
 * peers. They are different numbers on purpose — a service serving both on one number
 * binds it twice and dies on itself, which is exactly how the local stack boots them.
 *
 * @remarks `service_registries` registers the task in Cloud Map; the front is excluded
 * because nothing dials it — the load balancer reaches it by ENI address instead.
 *
 * @remarks The container JSON is assembled from `local.container_env` and
 * `local.container_secrets`, the same maps the module outputs expose, so a test asserting
 * on the output asserts on what the task definition actually carries.
 */

resource "aws_ecs_cluster" "main" {
  name = var.name_prefix

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    Name        = var.name_prefix
    ManagedBy   = "terraform"
    Environment = var.environment
  }
}

resource "aws_ecs_task_definition" "services" {
  for_each = local.services

  family                   = "${var.name_prefix}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.is_front ? var.front_cpu : var.task_cpu
  memory                   = each.value.is_front ? var.front_memory : var.task_memory
  execution_role_arn       = aws_iam_role.task.arn
  task_role_arn            = aws_iam_role.task.arn

  # Log groups before tasks: a task that starts before its group exists cannot write to it
  # under the least-privilege policy above.
  depends_on = [aws_cloudwatch_log_group.services]

  container_definitions = jsonencode([{
    name      = each.key
    image     = local.image_uri[each.key]
    essential = true

    portMappings = concat(
      [{ containerPort = each.value.http_port, protocol = "tcp" }],
      each.value.grpc_port != null ? [{ containerPort = each.value.grpc_port, protocol = "tcp" }] : []
    )

    environment = [
      for key, value in local.container_env[each.key] : { name = key, value = value }
    ]

    secrets = [
      for env_name, json_key in local.container_secrets[each.key] : {
        name      = env_name
        valueFrom = "${aws_secretsmanager_secret.app.arn}:${json_key}"
      }
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.services[each.key].name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = each.key
      }
    }
  }])
}

resource "aws_ecs_service" "services" {
  for_each = local.services

  name            = "${var.name_prefix}-${each.key}"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.services[each.key].arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  platform_version = "LATEST"

  network_configuration {
    subnets          = var.public_subnet_ids
    security_groups  = [var.security_group_ids.service]
    assign_public_ip = true
  }

  dynamic "load_balancer" {
    for_each = each.value.is_front || each.key == "api-gateway" ? [1] : []
    content {
      target_group_arn = each.value.is_front ? aws_lb_target_group.front.arn : aws_lb_target_group.gateway.arn
      container_name   = each.key
      container_port   = 3000
    }
  }

  dynamic "service_registries" {
    # The resource itself in the list, so `value.arn` below reads an object: iterating
    # over `.arn` directly would hand the block a bare string (which only ever surfaced
    # once tests made the ARN known at plan time — an unknown value masks the type error).
    for_each = each.value.is_front ? [] : try([aws_service_discovery_service.services[each.key]], [])
    content {
      registry_arn = service_registries.value.arn
    }
  }

  health_check_grace_period_seconds = each.value.is_front || each.key == "api-gateway" ? 60 : null

  tags = {
    Service     = each.key
    ManagedBy   = "terraform"
    Environment = var.environment
  }
}

# ---- autoscaling -----------------------------------------------------------------
#
# One target per service, registered against the service that already exists (the
# reference below is the ordering), and one target-tracking policy holding average CPU.
# Desired count is what ECS runs; these bounds are what may change it without a human —
# which is why they live next to the service they bound rather than in a runbook.

resource "aws_appautoscaling_target" "services" {
  for_each = var.autoscaling.enabled ? aws_ecs_service.services : {}

  max_capacity       = var.autoscaling.max_capacity
  min_capacity       = var.autoscaling.min_capacity
  resource_id        = "service/${aws_ecs_cluster.main.name}/${each.value.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "services" {
  for_each = aws_appautoscaling_target.services

  name               = "${var.name_prefix}-${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = each.value.resource_id
  scalable_dimension = each.value.scalable_dimension
  service_namespace  = each.value.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }

    target_value       = var.autoscaling.cpu_target_percent
    scale_in_cooldown  = var.autoscaling.scale_in_cooldown
    scale_out_cooldown = var.autoscaling.scale_out_cooldown
  }

  depends_on = [aws_appautoscaling_target.services]
}
