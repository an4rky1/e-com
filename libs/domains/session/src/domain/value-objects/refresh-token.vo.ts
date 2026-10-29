/**
 * @fileoverview The plaintext refresh token.
 *
 * @remarks This is the only representation of a refresh token that can authenticate anybody,
 * and it exists in memory for exactly as long as the request that minted or presented it
 * takes. It is never persisted: storage keeps {@link TokenDigester}'s SHA-256 digest, so a
 * database dump does not hand an attacker a set of live sessions.
 */
import { Result } from '@auth/core';
import { randomBytes } from 'node:crypto';

/** 32 bytes of entropy — the same order of magnitude as the ids in the table. */
export const REFRESH_TOKEN_BYTES = 32;

/**
 * Shortest value accepted as a refresh token.
 *
 * @remarks A length floor rejects obviously malformed input before it reaches the database.
 * Anything long enough to have been minted by this service passes, and an attacker guessing
 * one simply misses on the digest lookup.
 */
export const REFRESH_TOKEN_MIN_LENGTH = 20;

export class RefreshToken {
  /**
   * The secret, held behind a getter rather than an own property.
   *
   * @remarks `JSON.stringify(token)` is the leak this prevents: an own `value` property is
   * enumerable, so any logger or telemetry payload that serialises the token would emit a
   * live credential. A prototype getter is invisible to serialisation.
   */
  private constructor(private readonly secret: string) {}

  get value(): string {
    return this.secret;
  }

  /** Validating constructor. Throws a `DomainError`; see {@link tryCreate} for a Result. */
  static create(value: string): RefreshToken {
    return RefreshToken.tryCreate(value).unwrapOrThrow();
  }

  static tryCreate(value: unknown): Result<RefreshToken, string> {
    if (typeof value !== 'string') {
      return Result.fail('refresh token must be a string');
    }
    // Not trimmed: a token is compared byte-for-byte, and silently accepting a padded
    // variant would mean two different strings authenticate the same session.
    if (value.length < REFRESH_TOKEN_MIN_LENGTH) {
      return Result.fail('refresh token is too short to have been issued by this service');
    }
    return Result.ok(new RefreshToken(value));
  }

  /** Mints a fresh token. 256 bits of entropy: a guessable token would make rotation moot. */
  static mint(bytes: number = REFRESH_TOKEN_BYTES): RefreshToken {
    return new RefreshToken(randomBytes(bytes).toString('base64url'));
  }

  /**
   * Safe to log.
   *
   * @remarks Every `AppException` context is redacted by field name, but a token that reaches
   * a log through a non-standard path would still leak, so it has no printable form of its
   * own and `toString` yields nothing usable.
   */
  get obfuscated(): string {
    return '[REDACTED]';
  }

  /** Serialised form — the redaction marker, never the secret. */
  toJSON(): string {
    return this.obfuscated;
  }

  toString(): string {
    return this.obfuscated;
  }
}