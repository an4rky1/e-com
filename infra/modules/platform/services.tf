/**
 * @fileoverview Everything derived from the service catalog: addresses, env, secret keys.
 *
 * @remarks Peer addresses are Cloud Map names, not IPs or `localhost`: in ECS every task is
 * its own ENI, so `localhost` is the task itself. The gateway and the orchestrator dial
 * `identity.<env>.auth.internal:13001` and friends, which is why the six gRPC servers are
 * registered in discovery below and why the Makefile's `AWS_GATEWAY_URL` has the exact
 * shape it has.
 *
 * @remarks Two different address vocabularies meet here on purpose. The edge
 * (`api-gateway`) reads its peers from the `GATEWAY_` namespace — `GATEWAY_IDENTITY_URL`
 * etc. — while the orchestrator (`auth-flow`) reads raw `IDENTITY_GRPC_URL` variables
 * straight off `process.env`. Both are set for the service that wants them and no other:
 * they share names in code only because they never share a container.
 */

module "catalog" {
  source = "../catalog"
}

locals {
  services = module.catalog.services
  backends = { for name, s in local.services : name => s if !s.is_front }

  # Container image per service, from the repositories bootstrap created.
  image_uri = {
    for name in keys(local.services) :
    name => "${data.aws_ecr_repository.services[name].repository_url}:${var.image_tag}"
  }

  # Cloud Map FQDN: <service>.<env>.auth.internal. The gateway's entry is the address the
  # front bakes into its build (`AWS_GATEWAY_URL` in the Makefile).
  discovery = {
    for name in keys(local.backends) :
    name => "${name}.${var.environment}.auth.internal"
  }

  # Only the six services that actually bind a gRPC socket produce an address; mfa serves
  # HTTP only, so it never appears here.
  grpc_address = {
    for name, s in local.backends :
    name => "${local.discovery[name]}:${s.grpc_port}" if s.grpc_port != null
  }

  # The edge's peer table — the `GATEWAY_` namespace of libs/gateway.
  gateway_peer_env = {
    GATEWAY_IDENTITY_URL         = local.grpc_address["identity"]
    GATEWAY_ACCESS_CONTROL_URL   = local.grpc_address["access-control"]
    GATEWAY_CREDENTIAL_VAULT_URL = local.grpc_address["credential-vault"]
    GATEWAY_SESSION_URL          = local.grpc_address["session"]
    GATEWAY_AUTH_FLOW_URL        = local.grpc_address["auth-flow"]
    GATEWAY_CATALOG_URL          = local.grpc_address["catalog"]
    GATEWAY_CART_URL             = local.grpc_address["cart"]
    GATEWAY_INVENTORY_URL        = local.grpc_address["inventory"]
    GATEWAY_BILLING_URL          = local.grpc_address["billing"]
    GATEWAY_ORDER_URL            = local.grpc_address["order"]
  }

  # The orchestrator's peer table — read directly by apps/auth-flow/src/app.module.ts.
  # mfa has no gRPC server today (its own main.ts binds HTTP only), so its address is where
  # the peer *would* sit: the same dead-but-honest endpoint the local e2e scripts point at.
  auth_flow_peer_env = {
    IDENTITY_GRPC_URL         = local.grpc_address["identity"]
    CREDENTIAL_VAULT_GRPC_URL = local.grpc_address["credential-vault"]
    SESSION_GRPC_URL          = local.grpc_address["session"]
    MFA_GRPC_URL              = "${local.discovery["mfa"]}:13006"
    ACCOUNT_SECURITY_GRPC_URL = local.grpc_address["account-security"]
  }

  # Shop peers the order saga and the cart read-model dial directly (raw env, same pattern
  # as auth-flow). Defaults in each app.module are localhost; ECS needs Cloud Map names.
  order_peer_env = {
    CART_GRPC_URL      = local.grpc_address["cart"]
    INVENTORY_GRPC_URL = local.grpc_address["inventory"]
    BILLING_GRPC_URL   = local.grpc_address["billing"]
  }

  cart_peer_env = {
    CATALOG_GRPC_URL = local.grpc_address["catalog"]
  }

  # Env shared by every backend task. OTEL_SDK_DISABLED is not an opinion about tracing —
  # the SDK defaults to exporting at localhost:4318, which inside a task is the task itself.
  # When a collector ships as a sidecar, this flips to the OTLP endpoint instead.
  backend_env = {
    for name, s in local.backends :
    name => merge(
      {
        SERVICE_NAME      = name
        PORT              = tostring(s.http_port)
        KAFKA_ENABLED     = var.kafka_enabled ? "true" : "false"
        OTEL_SDK_DISABLED = "true"
      },
      s.grpc_port != null ? { GRPC_URL = "0.0.0.0:${s.grpc_port}" } : {},
      name == "api-gateway" ? merge(local.gateway_peer_env, {
        GATEWAY_OAUTH_PUBLIC_ORIGIN = var.oauth.public_origin
      }) : {},
      name == "auth-flow" ? local.auth_flow_peer_env : {},
      name == "order" ? local.order_peer_env : {},
      name == "cart" ? local.cart_peer_env : {}
    )
  }

  # The front is the one container with a single concern: where the gateway lives. The same
  # URL is a Dockerfile build argument (rewrites are baked at `next build`) and a runtime
  # env (next start re-reads it), so both must be this value.
  front_env = {
    GATEWAY_URL = "http://${local.discovery["api-gateway"]}:3000"
  }

  container_env = merge(
    local.backend_env,
    { front = local.front_env }
  )
}
