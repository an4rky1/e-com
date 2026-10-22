/**
 * @fileoverview The cryptography the aggregate needs, expressed as a port.
 *
 * @remarks The aggregate must be able to mint and check a credential, but hashing and random
 * generation are Node's job, not the domain's. Naming them here keeps `node:crypto` out of
 * `domain/` — which is what lets the domain be tested with a plain object, and what stops a
 * future "just use `Math.random` here" edit from reaching production code without passing the
 * lint rule that forbids it in this layer.
 */
import type { ApiKeyPrefix } from '../value-objects/api-key-prefix.vo';
import type { IssuedApiKeyMaterial } from '../value-objects/api-key-secret.vo';

export const API_KEY_CRYPTO = Symbol('API_KEY_CRYPTO');

/** Hex-encoded SHA-256: 32 bytes, two characters each. */
export const DIGEST_LENGTH = 64;

export interface ApiKeyCryptoPort {
  /**
   * Mints one key: prefix, plaintext and digest, all consistent with each other.
   *
   * @remarks Randomness must come from a CSPRNG. `Math.random` is a seeded PRNG whose output
   * is reproducible from a handful of observations, which for key material means an attacker
   * can enumerate every key the service has ever issued.
   */
  issueMaterial(family: ApiKeyPrefix): IssuedApiKeyMaterial;

  /** One-way: the plaintext becomes something storable. */
  digest(candidate: string): string;

  /**
   * Constant-time digest comparison.
   *
   * @remarks A byte-by-byte comparison short-circuits on the first mismatch, and the time it
   * takes leaks how much of a guess was correct. `timingSafeEqual` compares the whole buffer
   * regardless — but it *throws* on a length mismatch, so a truncated or empty `secret_hash`
   * column has to be rejected before the call, not caught by it.
   */
  verifyKey(candidate: string, digest: string): boolean;
}