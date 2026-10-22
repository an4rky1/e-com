/**
 * @fileoverview The public surface of the api-key domain.
 *
 * @remarks The barrel is deliberately explicit rather than `export *`: a consumer importing
 * from here should be able to see, in one screen, the whole contract this service offers — and
 * a wildcard would quietly widen it every time a helper is added under `src/`.
 *
 * @remarks Three audiences. {@link ApiKeyService} is what an application calls;
 * {@link ApiKeyAuthGuard} and {@link RequireScopes} are what api-gateway reuses; everything
 * else exists so a test in another service can assert against the same rules.
 */

// ---- configuration -------------------------------------------------------------
export {
  API_KEY_CONFIG,
  API_KEY_PRISMA,
  Defaults as ApiKeyDefaults,
  apiKeySchema,
  resolveApiKeyConfig,
  type ApiKeyConfig,
  type ApiKeyEnvConfig,
} from './api-key.config';

// ---- module --------------------------------------------------------------------
export {
  ApiKeyModule,
  createApiKeyModule,
  type ApiKeyModuleOptions,
} from './api-key.module';
export { ApiKeyHealthIndicator } from './api-key.health';

// ---- commands ------------------------------------------------------------------
export {
  CreateApiKeyCommand,
  RevokeApiKeyCommand,
  RotateApiKeyCommand,
  toCreateApiKeyCommand,
  type CreatedApiKey,
  type RevokedApiKey,
  type RotatedApiKey,
} from './application/commands/api-key.command';
export { CreateApiKeyHandler } from './application/commands/create-api-key.handler';
export { RotateApiKeyHandler } from './application/commands/rotate-api-key.handler';
export { RevokeApiKeyHandler } from './application/commands/revoke-api-key.handler';

// ---- queries -------------------------------------------------------------------
export {
  ListUserApiKeysHandler,
  ListUserApiKeysQuery,
  toApiKeySummary,
  type ApiKeySummary,
} from './application/queries/api-key.queries';

// ---- application ---------------------------------------------------------------
export { ApiKeyService, type ApiKeyScope } from './application/facade/api-key.service';
export {
  API_KEY_VERIFIER,
  ApiKeyAuthenticationService,
  INVALID_API_KEY_MESSAGE,
  type ApiKeyVerifier,
  type AuthenticatedApiKey,
} from './application/authentication/api-key-authentication.service';

// ---- domain --------------------------------------------------------------------
export {
  API_KEY_AGGREGATE,
  ApiKey,
  ApiKeyCreated,
  ApiKeyRevoked,
  ApiKeyRotated,
  ROTATED_REVOKE_REASON,
  isApiKeyEvent,
  type ApiKeyCreatedPayload,
  type ApiKeyEvent,
  type ApiKeyProps,
  type ApiKeyRevokedPayload,
  type ApiKeyRotation,
  type ApiKeyRotatedPayload,
} from './domain/api-key.aggregate';
export {
  API_KEY_REPOSITORY,
  ApiKeySpecification,
  ByUser,
  UsableKeys,
  type ApiKeyRepositoryPort,
} from './domain/ports/api-key-repository.port';
export {
  API_KEY_CRYPTO,
  DIGEST_LENGTH,
  type ApiKeyCryptoPort,
} from './domain/ports/api-key-crypto.port';

// ---- value objects -------------------------------------------------------------
export { ApiKeyId } from './domain/value-objects/api-key-id.vo';
export {
  API_KEY_MIN_LENGTH,
  API_KEY_PATTERN,
  ApiKeyPrefix,
  KEY_SEPARATOR,
  PREFIX_SUFFIX_LENGTH,
  SECRET_BODY_LENGTH,
  composePrefix,
  isApiKeyPrefix,
  parseApiKey,
  readPrefixFamily,
  type ParsedApiKey,
} from './domain/value-objects/api-key-prefix.vo';
export {
  API_KEY_SCOPES,
  ApiKeyScope as ApiKeyScopeValue,
  SUPER_SCOPE,
  isApiKeyScope,
  normaliseScopes,
  sanitiseScopes,
  satisfiesScopes,
} from './domain/value-objects/api-key-scope.vo';
export {
  ApiKeySecret,
  type IssuedApiKeyMaterial,
} from './domain/value-objects/api-key-secret.vo';
export {
  ApiKeyStatus,
  TERMINAL_STATUSES,
  USABLE_STATUSES,
  isApiKeyStatus,
} from './domain/value-objects/api-key-status.vo';

// ---- presentation --------------------------------------------------------------
export {
  API_KEY_PRINCIPAL_PROPERTY,
  ApiKeyAuthGuard,
  apiKeyPrincipalOf,
  type ApiKeyAuthenticatedRequest,
  type ApiKeyPrincipal,
} from './presentation/guards/api-key-auth.guard';
export {
  REQUIRED_SCOPES,
  RequireScopes,
} from './presentation/decorators/require-scopes.decorator';

// ---- infrastructure ------------------------------------------------------------
export {
  DIGEST_ALGORITHM,
  NodeApiKeyCrypto,
} from './infrastructure/crypto/node-api-key.crypto';
export { PrismaApiKeyRepository } from './infrastructure/persistence/prisma-api-key.repository';
export {
  enqueueEvents,
  type EnqueueEventsOptions,
} from './infrastructure/persistence/outbox-enqueue';