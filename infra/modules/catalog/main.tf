/**
 * @fileoverview The service catalog: one map, three consumers.
 *
 * @remarks This is the single source of truth for what runs in the deployment. Bootstrap
 * reads its keys to know which ECR repositories must exist before `make push`; the platform
 * module reads every field to build task definitions, discovery names and database URLs.
 * Keeping the list here — rather than in both places — is what stops a thirteenth service
 * from shipping an image to a repository nobody created.
 *
 * @remarks Ports and database names are the same values `tools/e2e-*.sh` and
 * `tools/migrate.sh` use locally: HTTP on 3001-3010, gRPC on HTTP+10000, and the ten
 * per-service databases (session's is `session_engine`, notification's is `notify`
 * — directory names and database names deliberately differ, and only this map says so).
 */

locals {
  services = {
    identity = {
      http_port = 3001
      grpc_port = 13001
      database  = "identity"
      is_front  = false
    }
    access-control = {
      http_port = 3002
      grpc_port = 13002
      database  = "access_control"
      is_front  = false
    }
    credential-vault = {
      http_port = 3003
      grpc_port = 13003
      database  = "credential_vault"
      is_front  = false
    }
    session = {
      http_port = 3004
      grpc_port = 13004
      database  = "session_engine"
      is_front  = false
    }
    auth-flow = {
      http_port = 3005
      grpc_port = 13005
      database  = "auth_flow"
      is_front  = false
    }
    mfa = {
      http_port = 3006
      grpc_port = null # Serves HTTP only; see the peer map in the platform module.
      database  = "mfa"
      is_front  = false
    }
    api-key = {
      http_port = 3007
      grpc_port = null
      database  = "api_key"
      is_front  = false
    }
    account-security = {
      http_port = 3008
      grpc_port = 13008
      database  = "account_security"
      is_front  = false
    }
    notification = {
      http_port = 3009
      grpc_port = null
      database  = "notify"
      is_front  = false
    }
    audit-log = {
      http_port = 3010
      grpc_port = null
      database  = "audit_log"
      is_front  = false
    }
    # The edge: stateless, no database, no gRPC server — the only service that talks to
    # its peers exclusively as a client. Its container port matches the compiled default
    # in `apps/api-gateway/src/main.ts` (3000), which is what the Makefile's stub and
    # Cloud Map URL assume.
    api-gateway = {
      http_port = 3000
      grpc_port = null
      database  = null
      is_front  = false
    }
    front = {
      http_port = 3000
      grpc_port = null
      database  = null
      is_front  = true
    }
  }
}

output "services" {
  description = "Service catalog keyed by service name."
  value       = local.services
}
