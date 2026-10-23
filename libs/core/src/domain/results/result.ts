/**
 * @fileoverview `Result` — an explicit success/failure union.
 *
 * Why: expected business outcomes ("this email is already taken", "the user is suspended")
 * are not exceptional. Throwing for them forces every caller into a try/catch that either
 * swallows the distinction or re-wraps it. `Result` keeps the failure in the type, so the
 * caller is made to look at it.
 */

import { DomainError } from '../errors/domain-error';

export type ResultError = DomainError | string;

export class Result<TValue, TError extends ResultError = string> {
  private constructor(
    private readonly outcome: { ok: true; value: TValue } | { ok: false; error: TError },
  ) {}

  static ok<TValue>(value: TValue): Result<TValue, never> {
    return new Result<TValue, never>({ ok: true, value });
  }

  static fail<TError extends ResultError>(error: TError): Result<never, TError> {
    return new Result<never, TError>({ ok: false, error });
  }

  /** Fails with a `DomainError`, which is what most invariant paths want. */
  static invalid(
    code: DomainError['code'],
    message: string,
    context?: Record<string, unknown>,
  ): Result<never, DomainError> {
    return Result.fail(new DomainError(code, message, context));
  }

  get isSuccess(): boolean {
    return this.outcome.ok;
  }

  get isFailure(): boolean {
    return !this.outcome.ok;
  }

  get value(): TValue {
    if (!this.outcome.ok) {
      throw new Error(
        `Attempted to read the value of a failed Result: ${
          this.outcome.error instanceof DomainError
            ? this.outcome.error.message
            : this.outcome.error
        }`,
      );
    }
    return this.outcome.value;
  }

  get error(): TError {
    if (this.outcome.ok) {
      throw new Error('Attempted to read the error of a successful Result');
    }
    return this.outcome.error;
  }

  getValueOr(fallback: TValue): TValue {
    return this.outcome.ok ? this.outcome.value : fallback;
  }

  getErrorOr(fallback: TError): TError {
    return this.outcome.ok ? fallback : this.outcome.error;
  }

  map<TNext>(fn: (value: TValue) => TNext): Result<TNext, TError> {
    return this.outcome.ok ? Result.ok(fn(this.outcome.value)) : this.failOf();
  }

  mapError<TNext extends ResultError>(
    fn: (error: TError) => TNext,
  ): Result<TValue, TNext> {
    return this.outcome.ok ? Result.ok(this.outcome.value) : Result.fail(fn(this.outcome.error));
  }

  flatMap<TNext>(
    fn: (value: TValue) => Result<TNext, TError>,
  ): Result<TNext, TError> {
    return this.outcome.ok ? fn(this.outcome.value) : this.failOf();
  }

  /** Collapses both branches into one value — useful at the presentation edge. */
  match<TNext>(onOk: (value: TValue) => TNext, onErr: (error: TError) => TNext): TNext {
    return this.outcome.ok ? onOk(this.outcome.value) : onErr(this.outcome.error);
  }

  ifOk(fn: (value: TValue) => void): this {
    if (this.outcome.ok) fn(this.outcome.value);
    return this;
  }

  ifErr(fn: (error: TError) => void): this {
    if (!this.outcome.ok) fn(this.outcome.error);
    return this;
  }

  /** Unwraps or throws — the escape hatch for boundaries that already handle failure. */
  unwrapOrThrow(): TValue {
    if (!this.outcome.ok) {
      if (this.outcome.error instanceof DomainError) throw this.outcome.error;
      throw new Error(this.outcome.error);
    }
    return this.outcome.value;
  }

  private failOf(): Result<never, TError> {
    return Result.fail((this.outcome as { ok: false; error: TError }).error);
  }
}