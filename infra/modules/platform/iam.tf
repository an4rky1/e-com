/**
 * @fileoverview One task role for the whole platform.
 *
 * @remarks The same role serves as task role and execution role. Splitting them is the
 * right move when services need different AWS permissions (a future MSK consumer wants
 * `kafka-cluster:*` and nobody else does); today every task needs the identical three
 * capabilities — pull the image, write its log group, read the app secret — and a second
 * role would be a second copy of the same policy with no second behaviour behind it.
 *
 * @remarks `ecr:GetAuthorizationToken` is `Resource: "*"` because AWS does not scope it to
 * a repository; everything else is scoped to exactly the repositories, log groups and the
 * one secret this environment uses.
 */

locals {
  ecs_task_assume_role = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role" "task" {
  name               = "${var.name_prefix}-task"
  assume_role_policy = local.ecs_task_assume_role

  tags = {
    Name        = "${var.name_prefix}-task"
    ManagedBy   = "terraform"
    Environment = var.environment
  }
}

resource "aws_iam_role_policy" "task" {
  name = "${var.name_prefix}-task"
  role = aws_iam_role.task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "EcrAuth"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid    = "EcrPull"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
        ]
        Resource = [for repo in data.aws_ecr_repository.services : repo.arn]
      },
      {
        Sid    = "Logs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = [for group in aws_cloudwatch_log_group.services : "${group.arn}:*"]
      },
      {
        Sid      = "AppSecret"
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = aws_secretsmanager_secret.app.arn
      },
    ]
  })
}
