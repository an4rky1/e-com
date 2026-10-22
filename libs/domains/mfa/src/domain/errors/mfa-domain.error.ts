/**
 * @fileoverview Everything the MFA domain refuses.
 *
 * @remarks The domain raises these, not `MfaInvalidException` or any other Nest type. An
 * invariant breach is a fact about the domain, and an aggregate that had to import
 * `@nestjs/common` to express "this code is wrong" could not be unit-tested without a Nest
 * bootstrap — which is exactly the test suite where the answer to "is a replay accepted?"
 * needs to be obvious.
 *
 * @remarks The application layer performs the one-way translation
 * ({@link MfaErrorTranslation} in `application/errors`), so a transport concern is added at the
 * boundary and never leaks back in.
 *
 * @remarks Every code is deliberately coarse. A caller that is told whether the factor exists,
 * is merely unconfirmed, or is locked out has learned more than it is entitled to know, and
 * that difference is exactly what an attacker probes for. The context carries the detail for
 * logs; the message does not.
 */

import { DomainError, type DomainErrorCode } from '@auth/ddd-core';

/** Why a check failed, in the domain's own vocabulary. */
export const MfaErrorReason = {
  /** The submitted code matched no live credential. */
  CODE_INVALID: 'code_invalid',
  /**
   * The code is still arithmetically valid but its time step has already been spent.
   *
   * @remarks Reported separately from `CODE_INVALID` because it is the only failure that means
   * "stop, this device is replaying captured codes" rather than "the user mistyped".
   */
  CODE_ALREADY_USED: 'code_already_used',
  /** No enrolled factor can satisfy this request. */
  FACTOR_NOT_ACTIVE: 'factor_not_active',
  /** The enrollment window closed before the user confirmed. */
  ENROLLMENT_EXPIRED: 'enrollment_expired',
  /** Too many wrong codes; the factor is temporarily unusable. */
  FACTOR_LOCKED: 'factor_locked',
  /** The user holds no recovery-code set. */
  NO_RECOVERY_CODES: 'no_recovery_codes',
  /** Every code in the set has been spent. */
  RECOVERY_CODES_EXHAUSTED: 'recovery_codes_exhausted',
} as const;

export type MfaErrorReason = (typeof MfaErrorReason)[keyof typeof MfaErrorReason];

/**
 * Kernel codes, mapped per reason.
 *
 * @remarks Keyed by the reason's own value rather than by its constant name, so adding a
 * reason is a compile error here rather than a `undefined` kernel code at runtime.
 */
const KERNEL_CODE: Readonly<Record<MfaErrorReason, DomainErrorCode>> = {
  [MfaErrorReason.CODE_INVALID]: 'INVALID_VALUE',
  [MfaErrorReason.CODE_ALREADY_USED]: 'INVALID_VALUE',
  [MfaErrorReason.FACTOR_NOT_ACTIVE]: 'CONFLICTING_STATE',
  [MfaErrorReason.ENROLLMENT_EXPIRED]: 'CONFLICTING_STATE',
  [MfaErrorReason.FACTOR_LOCKED]: 'CONFLICTING_STATE',
  [MfaErrorReason.NO_RECOVERY_CODES]: 'CONFLICTING_STATE',
  [MfaErrorReason.RECOVERY_CODES_EXHAUSTED]: 'CONFLICTING_STATE',
};

/**
 * Reasons that should be counted against the factor's attempt budget.
 *
 * @remarks Read by the command handlers, not by the aggregate. A rejected code has to leave a
 * trace — a live brute force must cost the attacker a lockout, not just a rejected request —
 * but it cannot leave one *inside* the same transaction, because that transaction rolls back
 * with the exception. So the aggregate refuses without mutating and the handler records the
 * attempt in a transaction of its own.
 */
export const ATTEMPT_FAILURES: ReadonlySet<MfaErrorReason> = new Set([
  MfaErrorReason.CODE_INVALID,
  MfaErrorReason.CODE_ALREADY_USED,
  MfaErrorReason.ENROLLMENT_EXPIRED,
]);

export class MfaDomainError extends DomainError {
  constructor(
    readonly reason: MfaErrorReason,
    message: string,
    context: Record<string, unknown> = {},
  ) {
    super(KERNEL_CODE[reason] ?? 'INVALID_VALUE', message, context);
    // `DomainError.name` is a readonly property, so it is redefined rather than assigned:
    // the name is what `isMfaDomainError` falls back to across a module boundary, and the
    // base name would make every MFA refusal look like a kernel failure in a log.
    Object.defineProperty(this, 'name', {
      value: 'MfaDomainError',
      enumerable: false,
      writable: true,
      configurable: true,
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Whether this refusal should consume one of the factor's attempts. */
  get countsAsAttempt(): boolean {
    return ATTEMPT_FAILURES.has(this.reason);
  }
}

export const isMfaDomainError = (error: unknown): error is MfaDomainError =>
  error instanceof MfaDomainError ||
  (error instanceof Error && error.name === 'MfaDomainError');