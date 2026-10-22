/**
 * @fileoverview Role names.
 *
 * @remarks The name is the primary key of `roles` and the value referenced by
 * `role_assignments.role` and `policies.role`. That is a deliberate choice over a surrogate
 * uuid: a role is configuration, not a fact with a history, and a readable key means an
 * `outbox_events` row, a Kafka message and an audit line can all be read by a human without a
 * lookup. It also means a rename is a delete plus a create — which is why the aggregate does
 * not offer one.
 */

import { Result, ValueObject } from '@auth/ddd-core';

/** Lower snake case, 2-64 characters. Starts with a letter so it can never be a keyword. */
export const ROLE_NAME_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export const MIN_ROLE_NAME_LENGTH = 2;
export const MAX_ROLE_NAME_LENGTH = 64;

export class RoleName extends ValueObject<{ value: string }> {
  private constructor(props: { value: string }) {
    super(props);
  }

  static create(raw: string): Result<RoleName, string> {
    if (typeof raw !== 'string') {
      return Result.fail('role name must be a string');
    }

    // Lower-cased on the way in: `Admin` and `admin` must not be two roles with two
    // permission sets that operators believe are the same one.
    const normalised = raw.trim().toLowerCase();

    if (
      normalised.length < MIN_ROLE_NAME_LENGTH ||
      normalised.length > MAX_ROLE_NAME_LENGTH
    ) {
      return Result.fail('role name length is out of range');
    }

    if (!ROLE_NAME_PATTERN.test(normalised)) {
      return Result.fail('role name has an invalid format');
    }

    return Result.ok(new RoleName({ value: normalised }));
  }

  static fromTrusted(raw: string): RoleName {
    return RoleName.create(raw).unwrapOrThrow();
  }

  static isValid(raw: unknown): boolean {
    return typeof raw === 'string' && RoleName.create(raw).isSuccess;
  }

  get value(): string {
    return this.props.value;
  }

  /** Canonical form for logs, error messages and comparison. */
  override toString(): string {
    return this.value;
  }
}