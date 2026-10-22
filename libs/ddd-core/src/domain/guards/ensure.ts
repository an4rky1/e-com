/**
 * @fileoverview Guard clauses used at the top of domain methods.
 *
 * Why: an invariant that lives in three call sites is an invariant that will eventually be
 * missed. Every rule is asserted in exactly one place — the method that owns the transition.
 */

import { DomainError, type DomainErrorCode } from '../errors/domain-error';

/**
 * Declared as an interface so `notNull` keeps its `asserts` signature.
 *
 * @remarks TypeScript only honours an assertion function when the call target carries an
 * explicit type annotation. Inlining the object with `as const` silently degrades
 * `Ensure.notNull(v)` into a plain function and the narrowing stops happening.
 */
export interface EnsureApi {
  notNull<T>(value: T, name: string): asserts value is NonNullable<T>;
  notEmpty(value: string | undefined | null, name: string): void;
  minLength(value: string, min: number, name: string): void;
  maxLength(value: string, max: number, name: string): void;
  positive(value: number, name: string): void;
  nonNegative(value: number, name: string): void;
  inRange(value: number, min: number, max: number, name: string): void;
  isTrue(
    condition: boolean,
    message: string,
    code?: DomainErrorCode,
  ): void;
  matches(value: string, pattern: RegExp, name: string): void;
}

export const Ensure: EnsureApi = {
  notNull(value, name) {
    if (value === null || value === undefined) {
      throw new DomainError('MISSING_REQUIRED', `${name} is required`);
    }
  },

  notEmpty(value, name) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new DomainError('MISSING_REQUIRED', `${name} must be a non-empty string`);
    }
  },

  minLength(value, min, name) {
    if (value.length < min) {
      throw new DomainError(
        'OUT_OF_RANGE',
        `${name} must be at least ${min} characters`,
      );
    }
  },

  maxLength(value, max, name) {
    if (value.length > max) {
      throw new DomainError(
        'OUT_OF_RANGE',
        `${name} must be at most ${max} characters`,
      );
    }
  },

  positive(value, name) {
    if (!(value > 0)) {
      throw new DomainError('OUT_OF_RANGE', `${name} must be greater than zero`);
    }
  },

  nonNegative(value, name) {
    if (value < 0) {
      throw new DomainError('OUT_OF_RANGE', `${name} must not be negative`);
    }
  },

  inRange(value, min, max, name) {
    if (value < min || value > max) {
      throw new DomainError(
        'OUT_OF_RANGE',
        `${name} must be between ${min} and ${max}`,
      );
    }
  },

  isTrue(condition, message, code = 'INVARIANT_VIOLATION') {
    if (!condition) {
      throw new DomainError(code, message);
    }
  },

  matches(value, pattern, name) {
    if (!pattern.test(value)) {
      throw new DomainError('INVALID_VALUE', `${name} has an invalid format`);
    }
  },
};