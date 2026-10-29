/**
 * @fileoverview One-way hashing of refresh tokens.
 *
 * @remarks SHA-256 rather than bcrypt/argon2 is deliberate and is *not* a weakness here. A
 * password is low-entropy and must be slow to guess; a refresh token is 256 bits of CSPRNG
 * output, so there is no dictionary to attack and a fast digest is exactly what is wanted —
 * it runs on every single authenticated request.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { RefreshToken } from './refresh-token.vo';

export class TokenDigester {
  /** Named so a future algorithm change is a one-line edit plus a re-issue of every token. */
  static readonly ALGORITHM = 'sha256';

  /** Hex-encoded SHA-256: 32 bytes, two characters each. */
  static readonly DIGEST_LENGTH = 64;

  private constructor() {
    // Static utility: there is no instance state to make two of them meaningful.
  }

  /** The single place a plaintext token becomes something storable. */
  static digest(token: RefreshToken | string): string {
    const value = typeof token === 'string' ? token : token.value;
    return createHash(TokenDigester.ALGORITHM).update(value, 'utf8').digest('hex');
  }

  /**
   * Constant-time digest comparison.
   *
   * @remarks A byte-by-byte comparison short-circuits on the first mismatch, and the time it
   * takes leaks how much of a guess was correct. `timingSafeEqual` compares the whole
   * buffer regardless.
   */
  static matches(token: RefreshToken | string, digest: string): boolean {
    const expected = Buffer.from(digest, 'utf8');
    const actual = Buffer.from(TokenDigester.digest(token), 'utf8');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  /**
   * The `jti` carried alongside the digest.
   *
   * @remarks Unique per token so a presented token can be located by its public id first,
   * leaving the digest as the *check* rather than the only lookup key. Unique-ness comes
   * from the database constraint, so the value itself only has to be unguessable.
   */
  static mintJti(): string {
    return crypto.randomUUID();
  }
}