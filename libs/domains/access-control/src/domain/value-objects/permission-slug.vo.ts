/**
 * @fileoverview The `resource:action` permission slug.
 *
 * @remarks Why one string and not two fields: a permission travels inside an access token
 * (`permissions: string[]`) and is compared on the hot path of every authenticated request.
 * Keeping it a single opaque string means the wire format, the token claim and the database
 * column all agree, and a malformed value is rejected once — at construction — rather than at
 * every comparison site that forgets to normalise.
 *
 * @remarks The format is validated here rather than in the DTO because the value object is
 * what the aggregate stores: a rule enforced at the edge can always be bypassed by a caller
 * that reaches the domain directly, and the domain is reached by gRPC, Kafka and tests.
 */

import { Result, ValueObject } from '@auth/ddd-core';

/** `users:write`, `billing:invoice.read`. Lower snake case, exactly one colon. */
export const PERMISSION_SLUG_PATTERN =
  /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export const MAX_PERMISSION_SLUG_LENGTH = 64;

export interface PermissionSlugProps {
  resource: string;
  action: string;
}

export class PermissionSlug extends ValueObject<PermissionSlugProps> {
  private constructor(props: PermissionSlugProps) {
    super(props);
  }

  /**
   * Validates and splits a raw slug.
   *
   * @remarks Returns a `Result` rather than throwing because the value arrives from an
   * untrusted transport: a malformed permission is a caller mistake to be reported as a 400,
   * not an internal error.
   */
  static create(raw: string): Result<PermissionSlug, string> {
    if (typeof raw !== 'string') {
      return Result.fail('permission must be a string');
    }

    const normalised = raw.trim().toLowerCase();

    if (normalised.length === 0 || normalised.length > MAX_PERMISSION_SLUG_LENGTH) {
      return Result.fail('permission length is out of range');
    }

    const separator = normalised.indexOf(':');
    if (separator < 1 || separator === normalised.length - 1) {
      return Result.fail('permission must be formatted as "resource:action"');
    }

    if (normalised.indexOf(':', separator + 1) >= 0) {
      return Result.fail('permission must contain exactly one ":"');
    }

    if (!PERMISSION_SLUG_PATTERN.test(normalised)) {
      return Result.fail('permission has an invalid format');
    }

    return Result.ok(
      new PermissionSlug({
        resource: normalised.slice(0, separator),
        action: normalised.slice(separator + 1),
      }),
    );
  }

  /** For trusted paths where a malformed value is a programming error, not user input. */
  static fromTrusted(raw: string): PermissionSlug {
    return PermissionSlug.create(raw).unwrapOrThrow();
  }

  static isValid(raw: unknown): boolean {
    return typeof raw === 'string' && PermissionSlug.create(raw).isSuccess;
  }

  /** Canonical wire form. Round-trips through {@link create}. */
  get value(): string {
    return `${this.props.resource}:${this.props.action}`;
  }

  get resource(): string {
    return this.props.resource;
  }

  get action(): string {
    return this.props.action;
  }

  /** Canonical form for logs, error messages and comparison. */
  override toString(): string {
    return this.value;
  }
}