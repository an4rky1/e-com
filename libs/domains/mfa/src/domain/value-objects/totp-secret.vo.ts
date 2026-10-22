/**
 * @fileoverview The shared secret half of a TOTP factor.
 *
 * @remarks Wrapped in a type of its own for one reason: the raw secret must not be able to
 * wander. It is the second factor itself — a leaked one defeats MFA completely, silently and
 * permanently, because nobody is notified and nothing is rotated. Two things follow from
 * wrapping it, and both are load-bearing:
 *
 * 1. {@link TotpSecret.toJSON} returns a mask. A secret sitting on a domain event payload, a
 *    log line or a `JSON.stringify` of a whole object is the most common way one leaks, and a
 *    type that cannot be serialised without asking for it makes that a deliberate act.
 * 2. {@link TotpSecret.redacted} exists so log messages can still say *which* secret was in
 *    play without carrying it.
 *
 * @remarks The value is base32 (RFC 4648), because that is what authenticator apps accept in
 * an `otpauth://` URI. Encoding is a public, reversible transform and lives in
 * infrastructure; this object only validates and guards.
 */

import { Ensure } from '@auth/ddd-core';

/**
 * RFC 4648 base32, no padding, upper case.
 *
 * @remarks The alphabet excludes `0`, `1`, `8` and `9`: an authenticator app renders this one
 * in a cramped box, and a `0`/`O` or `1`/`l` pair is a support ticket at best and a failed
 * enrollment at worst.
 */
export const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 20 bytes is the RFC 4226 recommendation and fits a 160-bit HMAC-SHA1 key exactly. */
export const TOTP_SECRET_BYTES = 20;

/** What {@link TotpSecret.toJSON} hands back. */
export const REDACTED_SECRET = '[redacted]';

const BASE32_PATTERN = new RegExp(`^[${BASE32_ALPHABET}]+$`);
const BASE32_LENGTH = Math.ceil((TOTP_SECRET_BYTES * 8) / 5);

/** A base32 secret of exactly the expected length. */
export const TOTP_SECRET_PATTERN = new RegExp(
  `^[${BASE32_ALPHABET}]{${BASE32_LENGTH}}$`,
);

export class TotpSecret {
  private constructor(readonly value: string) {}

  static create(raw: string): TotpSecret {
    Ensure.matches(raw, TOTP_SECRET_PATTERN, 'totp secret');
    return new TotpSecret(raw.toUpperCase());
  }

  /** Skips re-validation for a value that came out of this service's own storage. */
  static fromTrusted(raw: string): TotpSecret {
    return new TotpSecret(raw);
  }

  static isValid(raw: unknown): raw is string {
    return typeof raw === 'string' && BASE32_PATTERN.test(raw);
  }

  equals(other: TotpSecret): boolean {
    return other instanceof TotpSecret && other.value === this.value;
  }

  toString(): string {
    return this.value;
  }

  /**
   * Never serialises the secret.
   *
   * @remarks Overridden on purpose: the base representation would otherwise be picked up by
   * `JSON.stringify`, by every error serialiser and by every audit hook that walks an object
   * graph. A secret must reach the user exactly once, through the enrollment response, and
   * nowhere else.
   */
  toJSON(): string {
    return REDACTED_SECRET;
  }

  /** Human-readable stand-in for logs: the tail is enough to correlate, not to use. */
  get redacted(): string {
    return `${REDACTED_SECRET}:…${this.value.slice(-4)}`;
  }
}