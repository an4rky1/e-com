/**
 * @fileoverview The dev stack, planned offline on mocked providers.
 *
 * `make infra-test` runs this with no AWS credentials and no network: `mock_provider`
 * swaps in stand-ins for both providers, so every AWS-computed attribute (ARNs, the ECR
 * image URI, generated passwords) is a placeholder while everything Terraform itself
 * derives from the configuration is the real thing. The assertions therefore pin the
 * wiring — catalog shape, peer addresses, ports, env maps, secret key lists — and stay
 * silent about names AWS will decide. That is the part that breaks silently otherwise:
 * a wrong peer URL or a leaked secret key compiles fine and only shows up in a task
 * that cannot boot.
 *
 * @remarks The provider stand-ins themselves live in `testing/aws.tfmock.hcl`, loaded
 * with `source = "./testing"` — pinned, well-formed values for every computed attribute
 * another resource's arguments depend on, plus plan-time generation (a mock that only
 * generates during apply would leave every ARN "(known after apply)" and no assertion
 * touching one could evaluate).
 *
 * @remarks A test file runs in the root module's scope, where child-module *outputs*
 * are addressable and child-module *resources* are not — hence `task_definition` and
 * `service_wiring` on the platform module, read straight off the resources rather than
 * restated, so an assertion on them asserts on what ECS was actually told.
 *
 * @remarks Sensitivity: `var.oauth` and `var.db` are sensitive, so they taint the env
 * map and the secret document on the way through. `nonsensitive()` wraps those reads —
 * the values under test are configuration literals ("identity.dev.auth.internal:13001"),
 * not credentials, and an assertion whose condition is itself sensitive is rejected.
 */

mock_provider "aws" {
  source = "./testing"
}

mock_provider "random" {}

variables {
  environment = "dev"
}

run "the_catalog_becomes_exactly_twelve_tasks" {
  command = plan

  assert {
    condition     = length(module.platform.task_definition) == 12 && length(module.platform.service_names) == 12
    error_message = "the catalog has 11 backends plus the front; each needs one task definition and one service."
  }

  assert {
    condition     = module.platform.cluster_name == "auth-platform-dev"
    error_message = "make status targets the cluster auth-platform-$(ENV); dev must be auth-platform-dev."
  }

  assert {
    condition = alltrue([
      for name, service_name in module.platform.service_names :
      service_name == "auth-platform-dev-${name}"
    ])
    error_message = "every service must be named auth-platform-$(ENV)-<catalog entry>, the shape make status parses."
  }

  assert {
    condition = alltrue([
      for name, task in module.platform.task_definition :
      task.network_mode == "awsvpc" && startswith(task.family, "auth-platform-dev-")
    ])
    error_message = "Fargate tasks run awsvpc with a family per service; anything else drops the ENI Cloud Map registers."
  }
}

run "the_gateway_dials_cloud_map_names_not_localhost" {
  command = plan

  assert {
    condition = (
      nonsensitive(module.platform.container_env)["api-gateway"]["GATEWAY_IDENTITY_URL"] == "identity.dev.auth.internal:13001" &&
      nonsensitive(module.platform.container_env)["api-gateway"]["GATEWAY_ACCESS_CONTROL_URL"] == "access-control.dev.auth.internal:13002" &&
      nonsensitive(module.platform.container_env)["api-gateway"]["GATEWAY_CREDENTIAL_VAULT_URL"] == "credential-vault.dev.auth.internal:13003" &&
      nonsensitive(module.platform.container_env)["api-gateway"]["GATEWAY_SESSION_URL"] == "session.dev.auth.internal:13004" &&
      nonsensitive(module.platform.container_env)["api-gateway"]["GATEWAY_AUTH_FLOW_URL"] == "auth-flow.dev.auth.internal:13005"
    )
    error_message = "the edge's peer table must resolve inside the VPC — localhost is the task itself in ECS."
  }

  assert {
    condition = (
      nonsensitive(module.platform.container_env)["auth-flow"]["IDENTITY_GRPC_URL"] == "identity.dev.auth.internal:13001" &&
      nonsensitive(module.platform.container_env)["auth-flow"]["CREDENTIAL_VAULT_GRPC_URL"] == "credential-vault.dev.auth.internal:13003" &&
      nonsensitive(module.platform.container_env)["auth-flow"]["SESSION_GRPC_URL"] == "session.dev.auth.internal:13004" &&
      nonsensitive(module.platform.container_env)["auth-flow"]["MFA_GRPC_URL"] == "mfa.dev.auth.internal:13006" &&
      nonsensitive(module.platform.container_env)["auth-flow"]["ACCOUNT_SECURITY_GRPC_URL"] == "account-security.dev.auth.internal:13008"
    )
    error_message = "the orchestrator reads raw *_GRPC_URL variables; its peer table must be the same Cloud Map names."
  }

  assert {
    condition     = nonsensitive(module.platform.container_env)["front"]["GATEWAY_URL"] == "http://api-gateway.dev.auth.internal:3000"
    error_message = "the front's runtime GATEWAY_URL is the Makefile's AWS_GATEWAY_URL for ENV=dev."
  }

  assert {
    condition = alltrue([
      for name, env in nonsensitive(module.platform.container_env) :
      env["OTEL_SDK_DISABLED"] == "true" && env["KAFKA_ENABLED"] == "false" if name != "front"
    ])
    error_message = "backends disable the default OTLP exporter (it would dial localhost:4318) and Kafka stays off until a bus exists."
  }

  assert {
    condition = alltrue([
      for name, env in nonsensitive(module.platform.container_env) :
      env["PORT"] == {
        identity         = "3001"
        access-control   = "3002"
        credential-vault = "3003"
        session          = "3004"
        auth-flow        = "3005"
        mfa              = "3006"
        api-key          = "3007"
        account-security = "3008"
        notification     = "3009"
        audit-log        = "3010"
        api-gateway      = "3000"
      }[name] if name != "front"
    ])
    error_message = "PORT must echo the catalog's http_port, the number each container binds."
  }
}

run "every_task_sees_only_the_secrets_it_reads" {
  command = plan

  assert {
    condition     = length(nonsensitive(module.platform.container_secrets)["front"]) == 0
    error_message = "the front renders pages; a secret key list on it would be a mistake, not a precaution."
  }

  assert {
    # Env name => JSON key: Prisma reads plain DATABASE_URL, the shared document keys it
    # per database. The static keys are name => key (identical on both sides).
    condition = (
      nonsensitive(module.platform.container_secrets)["identity"]["DATABASE_URL"] == "DATABASE_URL_IDENTITY" &&
      !contains(keys(nonsensitive(module.platform.container_secrets)["identity"]), "GATEWAY_OAUTH_STATE_SECRET")
    )
    error_message = "a backend must see DATABASE_URL (what Prisma reads) sourced from its own JSON key — and never the edge's OAuth keys."
  }

  assert {
    condition     = nonsensitive(module.platform.container_secrets)["session"]["DATABASE_URL"] == "DATABASE_URL_SESSION_ENGINE" && nonsensitive(module.platform.container_secrets)["notification"]["DATABASE_URL"] == "DATABASE_URL_NOTIFY"
    error_message = "directory names and database names differ on purpose (session -> session_engine, notification -> notify); the JSON key must be the database name, upper-cased."
  }

  assert {
    condition     = !contains(keys(nonsensitive(module.platform.container_secrets)["api-gateway"]), "DATABASE_URL") && contains(keys(nonsensitive(module.platform.container_secrets)["api-gateway"]), "GATEWAY_OAUTH_STATE_SECRET")
    error_message = "the edge has no database and is the only task that reads the OAuth secrets."
  }

  assert {
    condition = length({
      for name, secrets in nonsensitive(module.platform.container_secrets) :
      name => secrets if contains(keys(secrets), "DATABASE_URL")
    }) == 10
    error_message = "exactly the ten database-backed services may ask for a DATABASE_URL."
  }
}

run "the_task_definition_json_is_what_the_container_gets" {
  command = plan

  assert {
    condition = alltrue([
      for entry in jsondecode(nonsensitive(module.platform.task_definition["identity"].container_definitions))[0].environment :
      entry.name != "DATABASE_URL" && entry.name != "GRPC_SERVICE_TOKEN"
    ])
    error_message = "credentials travel as secret references, never as environment literals in the task definition."
  }

  assert {
    # The container env is DATABASE_URL, but the reference must end at identity's own
    # JSON key — that split is the whole point of the name => key map.
    condition = length([
      for entry in jsondecode(nonsensitive(module.platform.task_definition["identity"].container_definitions))[0].secrets :
      entry if entry.name == "DATABASE_URL" && endswith(entry.valueFrom, ":DATABASE_URL_IDENTITY")
      ]) == 1 && alltrue([
      for entry in jsondecode(nonsensitive(module.platform.task_definition["identity"].container_definitions))[0].secrets :
      contains(
        values(nonsensitive(module.platform.container_secrets)["identity"]),
        reverse(split(":", entry.valueFrom))[0]
      )
    ])
    error_message = "identity must see DATABASE_URL sourced from DATABASE_URL_IDENTITY, and every reference must name one of its own JSON keys."
  }

  assert {
    condition     = length(jsondecode(nonsensitive(module.platform.task_definition["identity"].container_definitions))[0].portMappings) == 2 && length(jsondecode(nonsensitive(module.platform.task_definition["audit-log"].container_definitions))[0].portMappings) == 1
    error_message = "HTTP plus gRPC ports for the six servers; HTTP only for the services without one."
  }

  assert {
    condition     = module.platform.task_definition["identity"].cpu == "256" && module.platform.task_definition["front"].cpu == "512" && module.platform.task_definition["front"].memory == "1024"
    error_message = "backends run on task_cpu/task_memory; the front renders and gets front_cpu/front_memory."
  }

  assert {
    condition     = endswith(jsondecode(nonsensitive(module.platform.task_definition["identity"].container_definitions))[0].image, ":latest")
    error_message = "the image URI must carry var.image_tag — that is how make deploy pins a git SHA."
  }
}

run "only_the_edge_and_the_front_sit_behind_the_balancer" {
  command = plan

  assert {
    condition     = !module.platform.service_wiring["identity"].behind_balancer && module.platform.service_wiring["front"].behind_balancer && module.platform.service_wiring["api-gateway"].behind_balancer
    error_message = "internal services are reached through Cloud Map; only front and gateway take public traffic."
  }

  assert {
    condition     = !module.platform.service_wiring["front"].in_cloud_map && module.platform.service_wiring["identity"].in_cloud_map
    error_message = "nothing dials the front, so nothing registers it; every backend does."
  }

  assert {
    condition     = module.platform.service_wiring["front"].container_port == 3000 && module.platform.service_wiring["api-gateway"].container_port == 3000
    error_message = "both target groups point at container port 3000 — the front's server and the gateway's compiled default."
  }

  assert {
    condition     = module.platform.cloud_map_namespace == "dev.auth.internal"
    error_message = "the private namespace is <env>.auth.internal — the second half of every peer address above."
  }
}

run "discovery_can_be_switched_off_for_an_emulator" {
  command = plan

  variables {
    enable_service_discovery = false
  }

  assert {
    condition     = module.platform.cloud_map_namespace == null
    error_message = "the escape hatch must cost a flag: no namespace to resolve peers through."
  }

  assert {
    condition = alltrue([
      for name, wiring in module.platform.service_wiring :
      !wiring.in_cloud_map if name != "front"
    ])
    error_message = "a task must not wait on a registration the namespace will never accept."
  }
}

run "flipping_the_event_bus_on_reaches_every_backend" {
  command = plan

  variables {
    kafka_enabled = true
  }

  assert {
    condition = alltrue([
      for name, env in nonsensitive(module.platform.container_env) :
      env["KAFKA_ENABLED"] == "true" if name != "front"
    ])
    error_message = "KAFKA_ENABLED is read from process.env by every backend; the flag must reach all of them."
  }

  assert {
    condition     = nonsensitive(module.platform.container_env)["front"] == { GATEWAY_URL = "http://api-gateway.dev.auth.internal:3000" }
    error_message = "the front's env is GATEWAY_URL and nothing else — no bus, no database, no peers."
  }
}
