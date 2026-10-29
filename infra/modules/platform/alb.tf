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
 * @remarks **Two shapes, decided by `var.tls`.** Without a domain the balancer is what
 * the MVP ships: port 80 only, `/auth/*` forwarded directly to the gateway. With one, port
 * 80 answers every request with a 301 to the same host on 443, and 443 carries both rules
 * behind a certificate whose DNS validation completed before the listener was allowed to
 * exist (`certificate_arn` reads the *validation* resource, not the certificate — that
 * dependency is the whole guarantee). The OAuth `PUBLIC_ORIGIN` must become `https://`
 * to match: providers reject a callback that arrives over plain http, and the redirect
 * here is what makes that origin reachable.
 */

locals {
  # TLS is one decision, read everywhere below: a domain present means a certificate, a
  # validation, a 443 listener and an 80 that only redirects.
  tls_enabled = var.tls.domain_name != null

  # The zone the validation record lands in: an existing one by id, a created one by name.
  # Null while TLS is off — the record has no `for_each` entry to use it then.
  tls_zone_id = var.tls.route53_zone_id != null ? var.tls.route53_zone_id : try(aws_route53_zone.tls[0].zone_id, null)
}

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
    type             = local.tls_enabled ? "redirect" : "forward"
    target_group_arn = local.tls_enabled ? null : aws_lb_target_group.front.arn

    # 301 rather than 302: the destination is a property of the host, not of this request,
    # and a permanent redirect is the one a browser may cache instead of re-asking an edge
    # that will answer the same way forever.
    dynamic "redirect" {
      for_each = local.tls_enabled ? [1] : []
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
}

# The deliberate direct surface — an API client that does not want a browser in the
# middle posts to the balancer itself. It exists only while the edge is plain HTTP:
# once TLS is on, this rule would answer on port 80 with content the 301 above promised
# to move, so the https listener owns the same path instead.
resource "aws_lb_listener_rule" "gateway" {
  count = local.tls_enabled ? 0 : 1

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

# ---- TLS -------------------------------------------------------------------------

# Owned here only when `route53_zone_name` is given; an existing zone arrives by id and
# stays untouched. A zone this module creates is a zone this module may write records to,
# which is the only reason both forms are allowed.
resource "aws_route53_zone" "tls" {
  count = var.tls.domain_name != null && var.tls.route53_zone_name != null ? 1 : 0

  name = var.tls.route53_zone_name

  tags = {
    Name        = var.tls.route53_zone_name
    ManagedBy   = "terraform"
    Environment = var.environment
  }
}

resource "aws_acm_certificate" "tls" {
  count = local.tls_enabled ? 1 : 0

  domain_name       = var.tls.domain_name
  validation_method = "DNS"

  tags = {
    Name        = var.tls.domain_name
    ManagedBy   = "terraform"
    Environment = var.environment
  }

  # A replacement must be installable while the old one still serves: DNS validation
  # takes minutes, and a listener with no certificate answers nothing.
  lifecycle {
    create_before_destroy = true
  }
}

# Keys come from the configuration — `var.tls.domain_name` is known at plan — while the
# CNAME name and value are only known once ACM answers. Keying on the config is what keeps
# this out of "for_each depends on attributes that cannot be determined until apply".
resource "aws_route53_record" "tls_validation" {
  for_each = local.tls_enabled ? { (var.tls.domain_name) = true } : {}

  zone_id = local.tls_zone_id
  name    = one([for o in aws_acm_certificate.tls[0].domain_validation_options : o if o.domain_name == var.tls.domain_name]).resource_record_name
  type    = one([for o in aws_acm_certificate.tls[0].domain_validation_options : o if o.domain_name == var.tls.domain_name]).resource_record_type
  records = [one([for o in aws_acm_certificate.tls[0].domain_validation_options : o if o.domain_name == var.tls.domain_name]).resource_record_value]
  ttl     = 60

  allow_overwrite = true
}

# The dependency the https listener is built on: it waits for ISSUED, so a listener cannot
# exist before the record above was published and observed. Failing here is a failed plan
# of the TLS pair, never a half-open balancer.
resource "aws_acm_certificate_validation" "tls" {
  count = local.tls_enabled ? 1 : 0

  certificate_arn         = aws_acm_certificate.tls[0].arn
  validation_record_fqdns = [for record in aws_route53_record.tls_validation : record.fqdn]

  timeouts {
    create = "15m"
  }
}

resource "aws_lb_listener" "https" {
  count = local.tls_enabled ? 1 : 0

  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = var.tls.ssl_policy
  certificate_arn   = aws_acm_certificate_validation.tls[0].certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.front.arn
  }
}

resource "aws_lb_listener_rule" "gateway_https" {
  count = local.tls_enabled ? 1 : 0

  listener_arn = aws_lb_listener.https[0].arn
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
