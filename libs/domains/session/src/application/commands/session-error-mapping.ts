/**
 * @fileoverview Turns a domain refusal into the exception the caller will see.
 *
 * @remarks The domain states *what* was refused; only this layer knows that HTTP and gRPC
 * exist, so this is where a `SessionRuleViolation` acquires a status code. Anything that is
 * not a refusal passes through untouched — a genuine bug must not be laundered into a 401.
 */
import {
  InvalidStateTransitionException,
  TokenExpiredException,
  TokenInvalidException,
  TokenReuseDetectedException,
} from '@auth/platform/error-handling';
import {
  isSessionRuleViolation,
  SessionRefusal,
  type SessionRuleViolation,
} from '../../domain/session.errors';

export function toAppException(error: unknown): unknown {
  if (!isSessionRuleViolation(error)) return error;

  const { refusal } = error;
  const context = contextOf(error);

  switch (refusal) {
    case SessionRefusal.SESSION_NOT_ACTIVE:
      return new InvalidStateTransitionException('session is no longer active', context);
    case SessionRefusal.SESSION_EXPIRED:
      return new TokenExpiredException('session has expired', context);
    case SessionRefusal.REFRESH_TOKEN_EXPIRED:
      return new TokenExpiredException('refresh token has expired', context);
    case SessionRefusal.REFRESH_TOKEN_UNKNOWN:
      return new TokenInvalidException('refresh token is not recognised', context);
    case SessionRefusal.REFRESH_TOKEN_REPLAYED:
      // The family has already been revoked by the time this is raised, so the caller is
      // told the truth: this is not a recoverable "try again" case.
      return new TokenReuseDetectedException('refresh token has already been used', context);
    case SessionRefusal.REFRESH_TOKEN_NOT_REPLAYED:
      return new InvalidStateTransitionException('refresh token is still active', context);
  }
}

/** The rest of the context is safe to hand back; `refusal` stays internal. */
function contextOf(error: SessionRuleViolation): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(error.context).filter(([key]) => key !== 'refusal'),
  );
}