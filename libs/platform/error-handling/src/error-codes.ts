/**
 * @fileoverview Exception taxonomy shared by every service.
 *
 * Why a registry instead of hard-coded codes: an error code is an API contract. Clients
 * branch on it, alerting rules match on it, and the retry policy of an upstream caller
 * depends on `retryable`. Scattering bare strings through `throw new Error(...)` is how a
 * 500 that is actually a permanent auth failure ends up in a retry loop.
 */

export const ErrorCategories = {
  VALIDATION: 'validation',
  AUTHENTICATION: 'authentication',
  AUTHORIZATION: 'authorization',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  BUSINESS_RULE: 'business_rule',
  RATE_LIMIT: 'rate_limit',
  DEPENDENCY: 'dependency',
  INTERNAL: 'internal',
} as const;

export type ErrorCategory =
  (typeof ErrorCategories)[keyof typeof ErrorCategories];

export const ErrorSeverities = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical',
} as const;

export type ErrorSeverity = (typeof ErrorSeverities)[keyof typeof ErrorSeverities];

export interface ErrorDefinition {
  code: string;
  status: number;
  category: ErrorCategory;
  severity: ErrorSeverity;
  /** Whether a caller may safely try the same request again unchanged. */
  retryable: boolean;
  defaultMessage: string;
}

/**
 * The single source of truth for error codes.
 *
 * @remarks Anything absent falls back to `INTERNAL_ERROR`. That fallback is deliberate:
 * an unmapped code must be loud (5xx, alerting fires) rather than silently presented as a
 * client error the caller can act on.
 */
export const ERROR_DEFINITIONS = {
  // validation
  VALIDATION_FAILED: {
    code: 'VALIDATION_FAILED',
    status: 400,
    category: ErrorCategories.VALIDATION,
    severity: ErrorSeverities.INFO,
    retryable: false,
    defaultMessage: 'Request validation failed',
  },
  INVALID_STATE_TRANSITION: {
    code: 'INVALID_STATE_TRANSITION',
    status: 409,
    category: ErrorCategories.BUSINESS_RULE,
    severity: ErrorSeverities.WARNING,
    retryable: false,
    defaultMessage: 'The requested transition is not allowed from the current state',
  },

  // authentication
  INVALID_CREDENTIALS: {
    code: 'INVALID_CREDENTIALS',
    status: 401,
    category: ErrorCategories.AUTHENTICATION,
    severity: ErrorSeverities.WARNING,
    retryable: false,
    defaultMessage: 'Invalid credentials',
  },
  TOKEN_EXPIRED: {
    code: 'TOKEN_EXPIRED',
    status: 401,
    category: ErrorCategories.AUTHENTICATION,
    severity: ErrorSeverities.INFO,
    retryable: false,
    defaultMessage: 'Token has expired',
  },
  TOKEN_INVALID: {
    code: 'TOKEN_INVALID',
    status: 401,
    category: ErrorCategories.AUTHENTICATION,
    severity: ErrorSeverities.WARNING,
    retryable: false,
    defaultMessage: 'Token is invalid',
  },
  TOKEN_REUSE_DETECTED: {
    code: 'TOKEN_REUSE_DETECTED',
    status: 401,
    category: ErrorCategories.AUTHENTICATION,
    severity: ErrorSeverities.CRITICAL,
    retryable: false,
    defaultMessage: 'Refresh token reuse detected; all sessions were revoked',
  },
  MFA_REQUIRED: {
    code: 'MFA_REQUIRED',
    status: 401,
    category: ErrorCategories.AUTHENTICATION,
    severity: ErrorSeverities.INFO,
    retryable: false,
    defaultMessage: 'A second factor is required to complete this sign-in',
  },
  MFA_INVALID: {
    code: 'MFA_INVALID',
    status: 401,
    category: ErrorCategories.AUTHENTICATION,
    severity: ErrorSeverities.WARNING,
    retryable: false,
    defaultMessage: 'The provided second factor is invalid',
  },
  ACCOUNT_LOCKED: {
    code: 'ACCOUNT_LOCKED',
    status: 423,
    category: ErrorCategories.AUTHENTICATION,
    severity: ErrorSeverities.WARNING,
    retryable: false,
    defaultMessage: 'This account is temporarily locked',
  },
  ACCOUNT_SUSPENDED: {
    code: 'ACCOUNT_SUSPENDED',
    status: 403,
    category: ErrorCategories.AUTHENTICATION,
    severity: ErrorSeverities.WARNING,
    retryable: false,
    defaultMessage: 'This account is suspended',
  },
  PASSWORD_EXPIRED: {
    code: 'PASSWORD_EXPIRED',
    status: 401,
    category: ErrorCategories.AUTHENTICATION,
    severity: ErrorSeverities.WARNING,
    retryable: false,
    defaultMessage: 'The password has expired and must be changed',
  },

  // authorization
  PERMISSION_DENIED: {
    code: 'PERMISSION_DENIED',
    status: 403,
    category: ErrorCategories.AUTHORIZATION,
    severity: ErrorSeverities.WARNING,
    retryable: false,
    defaultMessage: 'Insufficient permissions',
  },
  TENANT_MISMATCH: {
    code: 'TENANT_MISMATCH',
    status: 403,
    category: ErrorCategories.AUTHORIZATION,
    severity: ErrorSeverities.ERROR,
    retryable: false,
    defaultMessage: 'The resource belongs to a different tenant',
  },

  // not found / conflict
  RESOURCE_NOT_FOUND: {
    code: 'RESOURCE_NOT_FOUND',
    status: 404,
    category: ErrorCategories.NOT_FOUND,
    severity: ErrorSeverities.INFO,
    retryable: false,
    defaultMessage: 'Resource not found',
  },
  RESOURCE_ALREADY_EXISTS: {
    code: 'RESOURCE_ALREADY_EXISTS',
    status: 409,
    category: ErrorCategories.CONFLICT,
    severity: ErrorSeverities.INFO,
    retryable: false,
    defaultMessage: 'Resource already exists',
  },

  // idempotency
  IDEMPOTENCY_IN_FLIGHT: {
    code: 'IDEMPOTENCY_IN_FLIGHT',
    status: 409,
    category: ErrorCategories.CONFLICT,
    severity: ErrorSeverities.INFO,
    // Retrying is the correct answer — the first attempt is still running, and the caller
    // is told when to come back (`Retry-After`) rather than left to guess.
    retryable: true,
    defaultMessage: 'A request with this idempotency key is still being processed',
  },
  IDEMPOTENCY_ALREADY_PROCESSED: {
    code: 'IDEMPOTENCY_ALREADY_PROCESSED',
    status: 409,
    category: ErrorCategories.CONFLICT,
    severity: ErrorSeverities.INFO,
    // Not retryable: the request already happened. Telling a caller to retry here is how a
    // duplicate user is created by a client that did exactly what it was told.
    retryable: false,
    defaultMessage:
      'This idempotency key belongs to a request that has already completed',
  },

  // api lifecycle
  API_SUNSET: {
    code: 'API_SUNSET',
    status: 410,
    category: ErrorCategories.NOT_FOUND,
    severity: ErrorSeverities.INFO,
    retryable: false,
    defaultMessage: 'This API version has been sunset; see the Sunset header for its successor',
  },

  // rate limiting
  RATE_LIMIT_EXCEEDED: {
    code: 'RATE_LIMIT_EXCEEDED',
    status: 429,
    category: ErrorCategories.RATE_LIMIT,
    severity: ErrorSeverities.WARNING,
    retryable: true,
    defaultMessage: 'Too many requests',
  },

  // dependency / internal
  DEPENDENCY_UNAVAILABLE: {
    code: 'DEPENDENCY_UNAVAILABLE',
    status: 503,
    category: ErrorCategories.DEPENDENCY,
    severity: ErrorSeverities.ERROR,
    retryable: true,
    defaultMessage: 'A required dependency is unavailable',
  },
  DEPENDENCY_TIMEOUT: {
    code: 'DEPENDENCY_TIMEOUT',
    status: 504,
    category: ErrorCategories.DEPENDENCY,
    severity: ErrorSeverities.ERROR,
    retryable: true,
    defaultMessage: 'A required dependency timed out',
  },
  INTERNAL_ERROR: {
    code: 'INTERNAL_ERROR',
    status: 500,
    category: ErrorCategories.INTERNAL,
    severity: ErrorSeverities.ERROR,
    retryable: false,
    defaultMessage: 'Internal server error',
  },
} as const satisfies Record<string, ErrorDefinition>;

export type ErrorCode = keyof typeof ERROR_DEFINITIONS;

export const FALLBACK_ERROR: ErrorDefinition = ERROR_DEFINITIONS.INTERNAL_ERROR;

const REGISTRY: ReadonlyMap<string, ErrorDefinition> = new Map(
  Object.values(ERROR_DEFINITIONS).map((definition) => [
    definition.code,
    definition as ErrorDefinition,
  ]),
);

export function resolveErrorDefinition(code: string): ErrorDefinition {
  return REGISTRY.get(code) ?? FALLBACK_ERROR;
}

export function isKnownErrorCode(code: string): code is ErrorCode {
  return REGISTRY.has(code);
}