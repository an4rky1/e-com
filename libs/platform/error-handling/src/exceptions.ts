import { AppException, type AppExceptionOptions } from './app.exception';

/**
 * Typed exceptions for the auth domain.
 *
 * Why subclasses rather than `new AppException({ code: '...' })` at each call site: the
 * call site reads as the thing that went wrong ("this user is locked"), and a rename of a
 * code becomes a compile error instead of a silent contract break.
 */

export class ValidationException extends AppException {
  constructor(message?: string, context?: Record<string, unknown>, cause?: unknown) {
    super({ code: 'VALIDATION_FAILED', message, context, cause });
  }
}

export class InvalidCredentialsException extends AppException {
  constructor(message?: string, context?: Record<string, unknown>) {
    super({ code: 'INVALID_CREDENTIALS', message, context });
  }
}

export class TokenExpiredException extends AppException {
  constructor(message?: string, context?: Record<string, unknown>) {
    super({ code: 'TOKEN_EXPIRED', message, context });
  }
}

export class TokenInvalidException extends AppException {
  constructor(message?: string, context?: Record<string, unknown>) {
    super({ code: 'TOKEN_INVALID', message, context });
  }
}

export class TokenReuseDetectedException extends AppException {
  constructor(message?: string, context?: Record<string, unknown>) {
    super({ code: 'TOKEN_REUSE_DETECTED', message, context });
  }
}

export class MfaRequiredException extends AppException {
  constructor(message?: string, context?: Record<string, unknown>) {
    super({ code: 'MFA_REQUIRED', message, context });
  }
}

export class MfaInvalidException extends AppException {
  constructor(message?: string, context?: Record<string, unknown>) {
    super({ code: 'MFA_INVALID', message, context });
  }
}

export class AccountLockedException extends AppException {
  constructor(message?: string, context?: Record<string, unknown>) {
    super({ code: 'ACCOUNT_LOCKED', message, context });
  }
}

/**
 * The caller has spent its budget for this window.
 *
 * @remarks Carries the retry delay in `context.retryAfterSec` rather than only in the
 * `Retry-After` header, because a client that reads headers and a client that reads the body
 * are both real, and the body is the one a machine is more likely to parse.
 */
export class TooManyRequestsException extends AppException {
  constructor(message?: string, context?: Record<string, unknown>) {
    super({ code: 'RATE_LIMIT_EXCEEDED', message, context });
  }
}

export class AccountSuspendedException extends AppException {
  constructor(message?: string, context?: Record<string, unknown>) {
    super({ code: 'ACCOUNT_SUSPENDED', message, context });
  }
}

export class PermissionDeniedException extends AppException {
  constructor(message?: string, context?: Record<string, unknown>) {
    super({ code: 'PERMISSION_DENIED', message, context });
  }
}

export class ResourceNotFoundException extends AppException {
  constructor(message?: string, context?: Record<string, unknown>) {
    super({ code: 'RESOURCE_NOT_FOUND', message, context });
  }
}

export class ResourceAlreadyExistsException extends AppException {
  constructor(message?: string, context?: Record<string, unknown>) {
    super({ code: 'RESOURCE_ALREADY_EXISTS', message, context });
  }
}

export class InvalidStateTransitionException extends AppException {
  constructor(message?: string, context?: Record<string, unknown>) {
    super({ code: 'INVALID_STATE_TRANSITION', message, context });
  }
}

export class RateLimitExceededException extends AppException {
  constructor(message?: string, context?: Record<string, unknown>) {
    super({ code: 'RATE_LIMIT_EXCEEDED', message, context });
  }
}

export class DependencyUnavailableException extends AppException {
  constructor(message?: string, context?: Record<string, unknown>, cause?: unknown) {
    super({ code: 'DEPENDENCY_UNAVAILABLE', message, context, cause });
  }
}

export class DependencyTimeoutException extends AppException {
  constructor(message?: string, context?: Record<string, unknown>, cause?: unknown) {
    super({ code: 'DEPENDENCY_TIMEOUT', message, context, cause });
  }
}

export class InternalErrorException extends AppException {
  constructor(cause?: unknown, context?: Record<string, unknown>) {
    super({ code: 'INTERNAL_ERROR', cause, context });
  }
}

/**
 * Maps a domain-layer `DomainError` onto a transport exception.
 *
 * @remarks This is the seam that lets the domain stay framework-free. `INVALID_VALUE`
 * becomes a 400 while `CONFLICTING_STATE` becomes a 409 — both stay plain error codes
 * inside the domain and only acquire HTTP meaning here.
 */
export function fromDomainError(error: {
  code: string;
  message: string;
  context?: Record<string, unknown>;
}): AppException {
  const statusByCode: Record<string, number> = {
    MISSING_REQUIRED: 400,
    INVALID_VALUE: 400,
    OUT_OF_RANGE: 400,
    INVARIANT_VIOLATION: 409,
    CONFLICTING_STATE: 409,
  };

  return new AppException({
    code: 'VALIDATION_FAILED',
    message: error.message,
    context: { domainError: error.code, ...(error.context ?? {}) },
    status: statusByCode[error.code] ?? 400,
    cause: error,
  });
}