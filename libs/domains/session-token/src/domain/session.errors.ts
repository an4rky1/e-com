/**
 * @fileoverview Why a session operation was refused, in domain terms.
 *
 * @remarks These are deliberately *not* transport codes. `TokenExpiredException` and friends
 * extend `HttpException`, and a domain that throws them has learned that HTTP exists — which
 * is exactly the coupling the kernel's `DomainError` was introduced to prevent. The
 * application layer maps a {@link SessionRuleViolation} onto the right exception at the
 * boundary (see `application/commands/session-error-mapping.ts`), so the refusal keeps its
 * meaning while gaining a status code on the way out.
 */
import { DomainError, type DomainErrorCode } from '@auth/ddd-core';

export const SessionRefusal = {
  /** The session is revoked, expired, or otherwise not in a state that allows the operation. */
  SESSION_NOT_ACTIVE: 'session_not_active',
  /** The session's own lifetime has run out. */
  SESSION_EXPIRED: 'session_expired',
  /** The refresh window (`refresh_expires_at`) has closed. */
  REFRESH_TOKEN_EXPIRED: 'refresh_token_expired',
  /** No token with that id or digest has ever been issued. */
  REFRESH_TOKEN_UNKNOWN: 'refresh_token_unknown',
  /** The token exists but has already been rotated or revoked. */
  REFRESH_TOKEN_REPLAYED: 'refresh_token_replayed',
  /** Refused an operation on a token that is still active — a programming error, not a reuse. */
  REFRESH_TOKEN_NOT_REPLAYED: 'refresh_token_not_replayed',
} as const;

export type SessionRefusal = (typeof SessionRefusal)[keyof typeof SessionRefusal];

/**
 * How each refusal reads at the kernel level.
 *
 * @remarks The split matters to callers that only catch `DomainError`: a replayed token is a
 * conflicting *state* (the request is well-formed, the world is not), while an unknown one is
 * an invalid *value*.
 */
const CODE_BY_REFUSAL: Record<SessionRefusal, DomainErrorCode> = {
  [SessionRefusal.SESSION_NOT_ACTIVE]: 'CONFLICTING_STATE',
  [SessionRefusal.SESSION_EXPIRED]: 'CONFLICTING_STATE',
  [SessionRefusal.REFRESH_TOKEN_EXPIRED]: 'OUT_OF_RANGE',
  [SessionRefusal.REFRESH_TOKEN_UNKNOWN]: 'INVALID_VALUE',
  [SessionRefusal.REFRESH_TOKEN_REPLAYED]: 'CONFLICTING_STATE',
  [SessionRefusal.REFRESH_TOKEN_NOT_REPLAYED]: 'CONFLICTING_STATE',
};

export class SessionRuleViolation extends DomainError {
  constructor(
    readonly refusal: SessionRefusal,
    message: string,
    context: Record<string, unknown> = {},
  ) {
    super(CODE_BY_REFUSAL[refusal], message, { refusal, ...context });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Narrows an unknown thrown value to a session refusal. */
export function isSessionRuleViolation(
  error: unknown,
): error is SessionRuleViolation {
  return error instanceof SessionRuleViolation;
}