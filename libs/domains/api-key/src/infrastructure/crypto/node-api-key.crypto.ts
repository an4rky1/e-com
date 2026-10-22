/**
 * @fileoverview The one place `node:crypto` is allowed to turn into key material.
 *
 * @remarks Three decisions live here and nowhere else:
 *
 * 1. **CSPRNG, never `Math.random`.** `Math.random` is a seeded PRNG whose output is
 *    reproducible from a handful of observations. For key material that means an attacker can
 *    enumerate every key this service has ever issued.
 * 2. **SHA-256, not bcrypt.** A password is low-entropy and must be slow to guess; a key body
 *    is 256 bits of CSPRNG output with no dictionary to attack, and the digest is computed on
 *    every single machine-authenticated request.
 * 3. **Rejection sampling, not modulo.** Mapping a random byte with `% 62` makes the first 8
 *    characters of the alphabet measurably more likely, which quietly removes entropy from a
 *    value whose only job is to be unguessable.
 */
import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ApiKeyCryptoPort } from '../../domain/ports/api-key-crypto.port';
import {
  composePrefix,
  KEY_SEPARATOR,
  PREFIX_SUFFIX_LENGTH,
  SECRET_BODY_LENGTH,
  type ApiKeyPrefix,
} from '../../domain/value-objects/api-key-prefix.vo';
import {
  ApiKeySecret,
  type IssuedApiKeyMaterial,
} from '../../domain/value-objects/api-key-secret.vo';

/** Named so a future algorithm change is a one-line edit plus a re-issue of every key. */
export const DIGEST_ALGORITHM = 'sha256';

/** Hex-encoded SHA-256: 32 bytes, two characters each. */
export const DIGEST_LENGTH = 64;

/** Cryptographically comfortable: alphanumerics only, no separator, no case ambiguity. */
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Largest multiple of 62 that fits in a byte (62 × 4 = 248).
 *
 * @remarks Bytes at or above it are discarded rather than folded in, so every one of the 62
 * symbols is equally likely.
 */
const REJECTION_LIMIT = 248;

/** Over-draw per round: rejection sampling needs slack to converge. */
const ENTROPY_OVERDRAW = 8;

@Injectable()
export class NodeApiKeyCrypto implements ApiKeyCryptoPort {
  /** Named so a future algorithm change is a one-line edit plus a re-issue of every key. */
  static readonly ALGORITHM = DIGEST_ALGORITHM;

  issueMaterial(family: ApiKeyPrefix): IssuedApiKeyMaterial {
    const prefix = composePrefix(family, this.randomBase62(PREFIX_SUFFIX_LENGTH));
    const secret = ApiKeySecret.create(
      `${prefix}${KEY_SEPARATOR}${this.randomBase62(SECRET_BODY_LENGTH)}`,
    );

    return { prefix, family, secret, digest: this.digest(secret.value) };
  }

  digest(candidate: string): string {
    return createHash(DIGEST_ALGORITHM).update(candidate, 'utf8').digest('hex');
  }

  /**
   * Constant-time comparison of a presented key against a stored digest.
   *
   * @remarks `timingSafeEqual` *throws* when the two buffers differ in length, so the length
   * check is here rather than in a `try`. A truncated or empty `secret_hash` — a column that
   * was never written, a row left by a half-finished migration — has to fail closed, not turn
   * a 500 into the answer to "is this key valid?".
   */
  verifyKey(candidate: string, digest: string): boolean {
    if (typeof candidate !== 'string' || typeof digest !== 'string') return false;

    const expected = Buffer.from(digest, 'utf8');
    const actual = Buffer.from(this.digest(candidate), 'utf8');

    if (expected.length !== actual.length) return false;

    return timingSafeEqual(expected, actual);
  }

  /** Uniform base62, from rejection-sampled CSPRNG bytes. */
  private randomBase62(length: number): string {
    let out = '';

    while (out.length < length) {
      const remaining = length - out.length;
      // Over-drawing keeps the expected number of rounds at ~1: each usable byte is worth
      // exactly one character, and ~4% of them are rejected.
      for (const byte of randomBytes(remaining + ENTROPY_OVERDRAW)) {
        if (byte >= REJECTION_LIMIT) continue;
        out += BASE62[byte % BASE62.length];
        if (out.length === length) break;
      }
    }

    return out;
  }
}