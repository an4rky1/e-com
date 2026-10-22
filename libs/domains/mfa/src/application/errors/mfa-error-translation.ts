/**
 * @fileoverview Turns a domain refusal into the exception the caller will see.
 *
 * @remarks The domain states *what* was refused; only this layer knows that HTTP and gRPC
 * exist, so this is where an {@link MfaDomainError} acquires a status code. Anything that is
 * not a refusal passes through untouched — a genuine bug must not be laundered into a 401.
 *
 * @remarks The context is filtered on the way out. The domain puts useful diagnostics in there
 * (`factorId`, `counter`, `lockedUntil`) and must not put a submitted code there, but the
 * filter is the belt to that braces: a context object travels into logs and error responses,
 * and "we already log it so it is safe" is the assumption that eventually prints a secret.
 */

import {
  InvalidStateTransitionException,
  MfaInvalidException,
  MfaRequiredException,
  RateLimitExceededException,
  ResourceNotFoundException,
} from '@auth/platform/error-handling';
import {
  isMfaDomainError,
  MfaErrorReason,
  type MfaDomainError,
} from '../../domain/errors/mfa-domain.error';

/** Never echoed back: a submitted credential has no business in a response or a log line. */
const FORBIDDEN_CONTEXT_KEY = /code|secret|otp|token|password|digest|cipher/i;

export function toAppException(error: unknown): unknown {
  if (!isMfaDomainError(error)) return error;

  const { reason } = error;
  const context = safeContext(error);

  switch (reason) {
    case MfaErrorReason.CODE_INVALID:
      // One message for a wrong code and for a replayed one. Distinguishing them tells an
      // attacker exactly which of the two would be worth capturing again.
      return new MfaInvalidException('the code was not accepted', context);
    case MfaErrorReason.CODE_ALREADY_USED:
      return new MfaInvalidException('the code was not accepted', context);
    case MfaErrorReason.FACTOR_NOT_ACTIVE:
      return new InvalidStateTransitionException('this factor cannot be used', context);
    case MfaErrorReason.ENROLLMENT_EXPIRED:
      return new InvalidStateTransitionException(
        'the enrollment window has closed; start again',
        context,
      );
    case MfaErrorReason.FACTOR_LOCKED:
      return new RateLimitExceededException(
        'too many failed codes; this factor is temporarily locked',
        context,
      );
    case MfaErrorReason.NO_RECOVERY_CODES:
      return new MfaRequiredException('no recovery codes are held for this account', context);
    case MfaErrorReason.RECOVERY_CODES_EXHAUSTED:
      return new MfaInvalidException('the remaining recovery codes are spent', context);
  }
}

/** Raised when a factor id the caller named does not exist, or is not theirs. */
export function toMissingFactorException(factorId: string, userId: string): unknown {
  return new ResourceNotFoundException('no such factor', { factorId, userId });
}

function safeContext(error: MfaDomainError): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(error.context).filter(([key]) => !FORBIDDEN_CONTEXT_KEY.test(key)),
  );
}