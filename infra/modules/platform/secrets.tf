/**
 * @fileoverview One secret, one JSON document, one per-service key list.
 *
 * @remarks Every value the platform treats as secret lives in a single Secrets Manager
 * document, and each task is handed only the keys it reads — `valueFrom` with a JSON key
 * means the credential never appears in the task definition at all, only its path does.
 * The key list is built from the catalog (does this service have a database? is this the
 * edge?), so a new service cannot accidentally receive the vault pepper.
 *
 * @remarks Generated values (null in the variables) are produced by `random_password` with
 * `special = false`: a database password that lands inside a connection URL must not need
 * percent-encoding to connect. They live in Terraform state — that is the trade of an
 * automatically provisioned credential, and the alternative is a literal in git.
 *
 * @remarks Every key gets a `random_password` whether or not the operator supplied a value,
 * and the provided one wins at resolution time. That is not wasted work: a `count` or
 * `for_each` condition that reads a sensitive variable is rejected outright by Terraform
 * ("could be exposed as a resource instance key"), so the generation step must depend only
 * on the non-sensitive key list. The random provider has no API, so an unused generated
 * value costs one state entry.
 *
 * @remarks DATABASE_URLs are assembled here rather than in the data module: this module
 * owns the catalog that maps service -> database name, and the data module only owns the
 * server. The password travels as a sensitive variable and comes out as a URL only in this
 * document.
 */

locals {
  static_secret_provided = {
    GRPC_SERVICE_TOKEN               = var.grpc_service_token
    SESSION_ACCESS_TOKEN_SIGNING_KEY = var.session_access_token_signing_key
    SESSION_REFRESH_TOKEN_PEPPER     = var.session_refresh_token_pepper
    VAULT_PEPPER                     = var.vault_pepper
    MFA_SECRET_ENCRYPTION_KEY        = var.mfa_secret_encryption_key
    GATEWAY_JWT_SECRET               = var.gateway_jwt_secret
  }

  static_secret_keys = [
    "GRPC_SERVICE_TOKEN",
    "SESSION_ACCESS_TOKEN_SIGNING_KEY",
    "SESSION_REFRESH_TOKEN_PEPPER",
    "VAULT_PEPPER",
    "MFA_SECRET_ENCRYPTION_KEY",
    "GATEWAY_JWT_SECRET",
  ]
}

resource "random_password" "generated" {
  # The key list, not the map: the map's values are sensitive variables, and a sensitive
  # for_each is refused. See the file header.
  for_each = toset(local.static_secret_keys)

  length  = 40
  special = false
}

resource "random_password" "oauth_state" {
  # No `count`: the same sensitive-condition rule. Generated unconditionally, used only
  # when the operator supplied no state secret.
  length  = 32
  special = false
}

locals {
  static_secrets = {
    for k, provided in local.static_secret_provided :
    k => (provided != null ? provided : random_password.generated[k].result)
  }
  # Keys handed to the edge. The state secret always exists (generated when the operator
  # supplies none); provider pairs only exist when configured, and ECS fails a task that
  # asks for a JSON key the document does not have — so the list follows the config.
  oauth_secret_keys = concat(
    ["GATEWAY_OAUTH_STATE_SECRET"],
    var.oauth.google != null ? ["GATEWAY_OAUTH_GOOGLE_CLIENT_ID", "GATEWAY_OAUTH_GOOGLE_CLIENT_SECRET"] : [],
    var.oauth.github != null ? ["GATEWAY_OAUTH_GITHUB_CLIENT_ID", "GATEWAY_OAUTH_GITHUB_CLIENT_SECRET"] : [],
    var.oauth.telegram != null ? ["GATEWAY_OAUTH_TELEGRAM_BOT_TOKEN", "GATEWAY_OAUTH_TELEGRAM_BOT_USERNAME"] : []
  )

  oauth_secrets = merge(
    {
      GATEWAY_OAUTH_STATE_SECRET = (
        var.oauth.state_secret != null ? var.oauth.state_secret : random_password.oauth_state.result
      )
    },
    var.oauth.google != null ? {
      GATEWAY_OAUTH_GOOGLE_CLIENT_ID     = var.oauth.google.client_id
      GATEWAY_OAUTH_GOOGLE_CLIENT_SECRET = var.oauth.google.client_secret
    } : {},
    var.oauth.github != null ? {
      GATEWAY_OAUTH_GITHUB_CLIENT_ID     = var.oauth.github.client_id
      GATEWAY_OAUTH_GITHUB_CLIENT_SECRET = var.oauth.github.client_secret
    } : {},
    var.oauth.telegram != null ? {
      GATEWAY_OAUTH_TELEGRAM_BOT_TOKEN    = var.oauth.telegram.bot_token
      GATEWAY_OAUTH_TELEGRAM_BOT_USERNAME = var.oauth.telegram.bot_username
    } : {}
  )

  # One connection URL per database, keyed the way the tasks read them:
  # DATABASE_URL_SESSION_ENGINE for session's `session_engine` database, and so on.
  database_urls = {
    for name, s in local.services :
    "DATABASE_URL_${upper(s.database)}" => "postgresql://postgres:${var.db.password}@${var.db.address}:${var.db.port}/${s.database}"
    if s.database != null
  }

  secret_values = merge(
    local.static_secrets,
    local.oauth_secrets,
    local.database_urls,
    { REDIS_URL = var.redis_url }
  )

  # What each task is allowed to pull out of the document, as `container env name` =>
  # `JSON key`. The two differ for the connection URL only: Prisma reads plain
  # DATABASE_URL (every schema's datasource says `env("DATABASE_URL")`), while the shared
  # document must key the URLs per database — so the container sees DATABASE_URL, sourced
  # from the document's DATABASE_URL_SESSION_ENGINE and friends. `null`-database services
  # and the front get no entry at all, which is the whole point of building the list from
  # the catalog instead of handing every task the whole document.
  container_secrets = {
    for name, s in local.services :
    name => (
      s.is_front ? {} : merge(
        { for k in local.static_secret_keys : k => k },
        { REDIS_URL = "REDIS_URL" },
        s.database != null ? { DATABASE_URL = "DATABASE_URL_${upper(s.database)}" } : {},
        name == "api-gateway" ? { for k in local.oauth_secret_keys : k => k } : {}
      )
    )
  }
}

resource "aws_secretsmanager_secret" "app" {
  name = "${var.name_prefix}/app"

  tags = {
    Name        = "${var.name_prefix}-app"
    ManagedBy   = "terraform"
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id     = aws_secretsmanager_secret.app.id
  secret_string = jsonencode(local.secret_values)
}
