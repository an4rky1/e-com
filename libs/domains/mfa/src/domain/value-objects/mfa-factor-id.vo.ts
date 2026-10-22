/**
 * @fileoverview Identity of a single enrolled factor.
 *
 * @remarks A branded string rather than a bare `string`, for the reason the rest of the
 * platform brands its ids: passing a `UserId` where an `MfaFactorId` belongs compiles fine and
 * fails at the database, hours later. The brand is erased at runtime, so it costs nothing on
 * the wire.
 *
 * @remarks Validated here rather than with a `ParseUUIDPipe` at the transport edge, because the
 * guard has to hold when the gRPC entry point is used instead of the HTTP one.
 */

import { UUID_PATTERN, type Brand } from '@auth/ddd-core';

/** Compile-time marker distinguishing a factor id from every other identifier. */
export type MfaFactorId = Brand<string, 'MfaFactorId'>;

/** The canonical shape of an id: a v4 UUID, as the `@db.Uuid` column requires. */
export const MFA_FACTOR_ID_PATTERN = UUID_PATTERN;

export class MfaFactorIdOf {
  /**
   * Mints a fresh v4 id, or accepts an explicit one when rehydrating.
   *
   * @remarks The value always arrives *into* the aggregate rather than being generated inside
   * it: replaying an event stream has to reproduce the original id.
   */
  static create(value?: string): MfaFactorId {
    const candidate = value ?? crypto.randomUUID().toLowerCase();
    if (!MfaFactorIdOf.isValid(candidate)) {
      throw new Error(`Invalid factor UUID: "${candidate}"`);
    }
    return candidate;
  }

  static isValid(value: unknown): value is MfaFactorId {
    return typeof value === 'string' && MFA_FACTOR_ID_PATTERN.test(value);
  }

  static unwrap(value: MfaFactorId | string): string {
    return value as string;
  }
}