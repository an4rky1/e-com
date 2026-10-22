/**
 * @fileoverview Base class for invariant failures raised by the domain.
 *
 * Why a dedicated type: the domain must not know that HTTP exists. When an invariant is
 * violated the kernel raises this, and the presentation boundary maps it onto a transport
 * status code. Keeping the two apart is what lets the domain be tested without Nest.
 */

export type DomainErrorCode =
  | 'INVARIANT_VIOLATION'
  | 'INVALID_VALUE'
  | 'MISSING_REQUIRED'
  | 'OUT_OF_RANGE'
  | 'CONFLICTING_STATE';

export class DomainError extends Error {
  override readonly name = 'DomainError';

  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Never leak internal aggregates or values into a client-facing message. */
  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, ...this.context };
  }
}