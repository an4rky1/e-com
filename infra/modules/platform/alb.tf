/**
 * @fileoverview The public edge: one ALB, two targets, two rules.
 *
 * @remarks The balancer fronts exactly two containers. Everything else is reached the way
 * the browser reaches it locally: through the front's `/api` proxy, which rewrites to the
 * gateway over Cloud Map. The `/auth/*` rule is the deliberate direct surface — an API
 * client that does not want a browser in the middle posts to the balancer itself.
 *
 * @remarks Health checks are the liveness endpoint, not readiness: `/` for the front and
 * `/health` for the gateway never touch a dependency, so a Postgres blip does not empty
 * the target group while the edge could still serve a sign-in page. Readiness
 * (`/health/ready`) exists for exactly the moment a service *should* leave rotation, and
 * wiring it here would make a database outage look like a deploy failure.
 *
 * @remarks HTTP only, port 80. TLS terminates at a certificate the MVP does not own yet —
 * the front's `PUBLIC_ORIGIN` must become https:// before any OAuth provider accepts a
 * redirect, which is a deliberate gate, not an oversight.
 */

resource "aws_lb" "main" {
  name               = "${var.name_prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [var.security_group_ids.alb]
  subnets            = var.public_subnet_ids

  idle_timeout               = 60
  enable_deletion_protection = var.environment == "prod"

  tags = {
    Name        = "${var.name_prefix}-alb"
    ManagedBy   = "terraform"
    Environment = var.environment
  }
}

resource "aws_lb_target_group" "front" {
  name        = "${var.name_prefix}-front"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  deregistration_delay = 30

  health_check {
    path                = "/"
    matcher             = "200-399"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = {
    Name      = "${var.name_prefix}-front"
    ManagedBy = "terraform"
  }
}

resource "aws_lb_target_group" "gateway" {
  name        = "${var.name_prefix}-gw"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  deregistration_delay = 30

  health_check {
    path                = "/health"
    matcher             = "200-399"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = {
    Name      = "${var.name_prefix}-gw"
    ManagedBy = "terraform"
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.front.arn
  }
}

resource "aws_lb_listener_rule" "gateway" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10

  condition {
    path_pattern {
      values = ["/auth/*"]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway.arn
  }
}
