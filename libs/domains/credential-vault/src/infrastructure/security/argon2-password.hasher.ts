/**
 * @fileoverview Argon2id password hashing, with an optional pepper.
 *
 * @remarks `argon2` lives here and nowhere else. The domain decides *whether* to rehash and
 * the port says *what* the cost parameters are; the native addon is an infrastructure detail
 * that must not reach the aggregate.
 */
import { createHmac, randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import {
  ARGON2_VERSION,
  type HashParameters,
  type PasswordHash,
  type PasswordHasherPort,
} from '../../domain/ports/password-hasher.port';

export { ARGON2_VERSION };

/**
 * The pepper is mixed in as an HMAC, not concatenated.
 *
 * @remarks `hmac(password, pepper)` is fixed-width, so it cannot lengthen the input, and it
 * is a one-way function of the password *keyed by* the pepper. Concatenation would also work
 * but leaves the password sitting in the argon2 input buffer in the clear; the HMAC collapses
 * it first, so an attacker who obtains the hash but not `VAULT_PEPPER` is left with exactly
 * the problem argon2 is designed to make expensive.
 *
 * @remarks A missing pepper is supported, and reported through {@link peppered} rather than
 * being fatal: the hashing itself is unchanged, it is only the extra factor that is gone.
 */
export function applyPepper(password: string, pepper: string | null): string {
  if (!pepper) return password;
  return createHmac('sha256', pepper).update(password, 'utf8').digest('hex');
}

export interface Argon2Options {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
  hashLength: number;
  version: number;
  pepper?: string | null;
}

export class Argon2PasswordHasher implements PasswordHasherPort {
  private readonly pepper: string | null;

  /**
   * A digest no password can match, built on first use at *this* instance's cost parameters.
   *
   * @remarks Lazy because hashing is expensive and most processes verify a real credential
   * first. Generated from random bytes rather than committed to source: a checked-in "dummy
   * hash" is a well-known string that some future code path could end up accepting.
   */
  private dummyDigest: Promise<string> | null = null;

  readonly currentParameters: HashParameters;

  constructor(options: Argon2Options) {
    this.pepper = options.pepper?.trim() || null;
    this.currentParameters = {
      algorithm: 'argon2id',
      memoryCost: options.memoryCost,
      timeCost: options.timeCost,
      parallelism: options.parallelism,
      hashLength: options.hashLength,
      version: options.version,
    };
  }

  get peppered(): boolean {
    return this.pepper !== null;
  }

  async hash(password: string): Promise<PasswordHash> {
    const digest = await argon2.hash(applyPepper(password, this.pepper), {
      type: argon2.argon2id,
      memoryCost: this.currentParameters.memoryCost,
      timeCost: this.currentParameters.timeCost,
      parallelism: this.currentParameters.parallelism,
      hashLength: this.currentParameters.hashLength,
      version: this.currentParameters.version,
    });

    return { digest, parameters: { ...this.currentParameters } };
  }

  /**
   * Verifies against a stored digest.
   *
   * @remarks A malformed digest answers `false` rather than raising: `secret_hash` is a text
   * column an operator can put anything in, and a `VerificationError` escaping from here would
   * turn a bad row into a 500 on the sign-in path.
   */
  async verify(digest: string, password: string): Promise<boolean> {
    if (typeof digest !== 'string' || digest.length === 0) return false;

    try {
      return await argon2.verify(digest, applyPepper(password, this.pepper));
    } catch {
      // Either the digest is not an Argon2 string, or its parameters exceed this process's
      // limits. Both are "this password did not match", not "this request failed".
      return false;
    }
  }

  /**
   * Whether stored parameters are weaker than the current ones.
   *
   * @remarks Strictly below on every term. A hash stored with *more* memory or time than we
   * use today is stronger, not weaker, and downgrading it would be a security regression
   * dressed up as an upgrade — which is exactly what a `>=` comparison would do the first
   * time an operator lowered a setting.
   */
  needsRehash(parameters: HashParameters): boolean {
    return (
      parameters.memoryCost < this.currentParameters.memoryCost ||
      parameters.timeCost < this.currentParameters.timeCost ||
      parameters.parallelism < this.currentParameters.parallelism ||
      parameters.hashLength < this.currentParameters.hashLength ||
      parameters.version < this.currentParameters.version
    );
  }

  /**
   * Burns roughly one verification's worth of CPU on a password that has no credential.
   *
   * @remarks Argon2id is constant-time in the digest but not in the *absence* of one: a request
   * for an unknown user returns in microseconds while a real one takes tens of milliseconds,
   * and the difference is a free account-enumeration oracle over a long enough window. The
   * only way to close it is to actually do the work.
   */
  async equaliseTiming(password: string): Promise<void> {
    this.dummyDigest ??= argon2.hash(randomBytes(32).toString('hex'), {
      type: argon2.argon2id,
      memoryCost: this.currentParameters.memoryCost,
      timeCost: this.currentParameters.timeCost,
      parallelism: this.currentParameters.parallelism,
      hashLength: this.currentParameters.hashLength,
      version: this.currentParameters.version,
    });

    await this.verify(await this.dummyDigest, password);
  }
}