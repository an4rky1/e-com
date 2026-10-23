/**
 * @fileoverview The plaintext api key, and the one-time material an issue produces.
 *
 * @remarks This is the only representation of an api key that can authenticate anybody, and
 * it exists in memory for exactly as long as the request that issued it takes. It is never
 * persisted: storage keeps the SHA-256 digest, so a database dump hands an attacker ids and
 * prefixes and nothing they can present.
 *
 * @remarks SHA-256 rather than bcrypt or argon2 is deliberate and is *not* a weakness here.
 * A password is low-entropy and must be slow to guess; a key body is 256 bits of CSPRNG
 * output, so there is no dictionary to attack and a fast digest is exactly what is wanted —
 * it runs on every single machine-authenticated request.
 */
import { Result } from '@auth/core';
import {
  API_KEY_MIN_LENGTH,
  API_KEY_PATTERN,
  parseApiKey,
  type ApiKeyPrefix,
} from './api-key-prefix.vo';

export class ApiKeySecret {
  /**
   * The secret, held behind a getter rather than an own property.
   *
   * @remarks `JSON.stringify(key)` is the leak this prevents: an own `value` property is
   * enumerable, so any logger or telemetry payload that serialises the credential would emit
   * a live key. A prototype getter is invisible to serialisation.
   */
  private constructor(private readonly plaintext: string) {}

  get value(): string {
    return this.plaintext;
  }

  /** The stored `prefix` column value, i.e. everything before the last `_`. */
  get prefix(): string {
    return parseApiKey(this.plaintext)?.prefix ?? '';
  }

  /** Validating constructor. Throws; see {@link tryCreate} for the `Result` form. */
  static create(value: string): ApiKeySecret {
    return ApiKeySecret.tryCreate(value).unwrapOrThrow();
  }

  static tryCreate(value: unknown): Result<ApiKeySecret, string> {
    if (typeof value !== 'string') {
      return Result.fail('api key must be a string');
    }
    // Not trimmed: a key is compared byte-for-byte, and silently accepting a padded variant
    // would mean two different strings authenticate the same machine.
    if (value.length < API_KEY_MIN_LENGTH) {
      return Result.fail('api key is too short to have been issued by this service');
    }
    if (!API_KEY_PATTERN.test(value)) {
      return Result.fail('api key is not in the expected format');
    }
    return Result.ok(new ApiKeySecret(value));
  }

  /**
   * Safe to log.
   *
   * @remarks Every `AppException` context is redacted by field name, but a key that reached a
   * log through a non-standard path would still leak, so it has no printable form of its own
   * and `toString` yields nothing usable.
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

/**
 * What issuing a key produces: the plaintext to hand back exactly once, the non-secret
 * prefix to store and display, and the digest to store in its place.
 *
 * @remarks The three travel together because they must agree: storing a digest of something
 * other than the key the caller was given produces a credential that authenticates nobody,
 * and it fails at the first request rather than at issue time.
 */
export interface IssuedApiKeyMaterial {
  /** `<family>_<random>` — unique, non-secret, and the lookup key. */
  readonly prefix: string;
  /** The family this key belongs to. */
  readonly family: ApiKeyPrefix;
  /** The only copy of the credential that will ever exist. */
  readonly secret: ApiKeySecret;
  /** Hex SHA-256 of the plaintext. This is what the database keeps. */
  readonly digest: string;
}