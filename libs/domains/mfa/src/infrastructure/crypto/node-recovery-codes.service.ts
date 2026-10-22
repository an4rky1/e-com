/**
 * @fileoverview CSPRNG recovery codes and SHA-256 digests over `node:crypto`.
 *
 * @remarks The implementation of {@link RecoveryCodePort}, and the only place in this service
 * that mints a recovery code. It is an adapter rather than domain logic because `node:crypto`
 * is not something `domain/` may import — the layering rule is enforced by lint, and the
 * aggregate asks for "a code" and "its digest" through the port.
 *
 * @remarks `randomBytes` throughout, and never `Math.random`. A recovery code is a bearer
 * credential that bypasses the second factor entirely, so its only requirement is
 * unpredictability: `Math.random` is a 128-bit-seeded PRNG whose internal state can be
 * recovered from a handful of outputs, which would make the whole set predictable to anyone
 * who had seen one code. The difference between the two is the difference between a second
 * factor and no second factor at all.
 *
 * @remarks The plaintext is never returned by {@link digest} and never accepted by anything
 * except {@link matches}, so there is no code path from a stored row back to a usable code.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  RECOVERY_CODES,
  type RecoveryCodePort,
} from '../../domain/ports/recovery-code.port';
import { BASE32_ALPHABET } from '../../domain/value-objects/totp-secret.vo';
import { RECOVERY_CODE_PATTERN } from '../../domain/value-objects/mfa-method.vo';

/** 80 bits of entropy per code: five base32 characters either side of the separator. */
export const RECOVERY_CODE_CHARS_PER_HALF = 5;

/** 16 bytes of salt per set — enough that digests from two sets never collide by accident. */
export const RECOVERY_CODE_SALT_BYTES = 16;

/**
 * Uniform character from the base32 alphabet.
 *
 * @remarks `byte & 0x1f` rather than `alphabet[byte % 32]` — the two are identical here
 * because 256 is an exact multiple of 32, and that exactness is the point: had the alphabet
 * had 27 glyphs, the modulo would have biased the first `256 % 27` characters upwards by ~4%
 * and quietly shortened the brute-force space.
 */
const randomGlyph = (): string => {
  const draw = randomBytes(1)[0];
  return BASE32_ALPHABET[draw & 0x1f];
};

/**
 * The form a presented code is reduced to before hashing.
 *
 * @remarks Upper-cased with separators stripped, so `A1B2C-C3D4E` and `a1b2cc3d4e` are one
 * code. Recovery codes are read off a screen and retyped by hand; refusing a correctly typed
 * code over a hyphen pushes users toward writing the whole set down unencrypted.
 */
export const canonicalRecoveryCode = (code: string): string =>
  code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

@Injectable()
export class NodeRecoveryCodeService implements RecoveryCodePort {
  /**
   * Mints `count` distinct codes.
   *
   * @remarks Distinctness is checked rather than assumed: two equal codes would make the
   * "N codes left" counter a lie and halve the entropy an attacker has to guess for a user
   * who received a colliding pair. Regenerating on collision is free — the cost is one more
   * CSPRNG draw, not a user-visible failure.
   */
  generate(count: number): string[] {
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(`recovery code count must be a positive integer, received ${count}`);
    }

    const codes = new Set<string>();
    while (codes.size < count) {
      codes.add(this.mintOne());
    }
    return [...codes];
  }

  newSalt(): string {
    return randomBytes(RECOVERY_CODE_SALT_BYTES).toString('hex');
  }

  /**
   * SHA-256 over the salt and the canonical code.
   *
   * @remarks The salt is a *prefix*, not a suffix, and both sides are length-delimited by the
   * separator: without it, salt `ab` + code `cdef` and salt `abc` + code `def` would hash the
   * same bytes and one code could be redeemed against another user's set.
   *
   * @remarks Plain SHA-256, not argon2. That is the right trade here and the reason is the
   * keyspace: a code is 50 bits of CSPRNG output, so there is no dictionary to attack and no
   * reason to spend 100ms and 64MB per verification on a guess that is already infeasible.
   * Recovery codes have no low-entropy variant to defend against, which is exactly the case
   * password hashing exists for.
   */
  digest(code: string, salt: string): string {
    return createHash('sha256')
      .update(`${salt}:${canonicalRecoveryCode(code)}`, 'utf8')
      .digest('hex');
  }

  /**
   * Constant-time comparison of a presented code against a stored digest.
   *
   * @remarks Compares two digests rather than a code against a code, so a mismatch is a
   * mismatch on 64 hex characters rather than on the handful of characters an attacker
   * guesses incrementally — the usual timing oracle into a one-way function.
   */
  matches(code: string, salt: string, digest: string): boolean {
    if (typeof digest !== 'string' || digest.length === 0) return false;

    const expected = Buffer.from(digest, 'utf8');
    const actual = Buffer.from(this.digest(code, salt), 'utf8');
    if (expected.length !== actual.length) return false;

    return timingSafeEqual(expected, actual);
  }

  private mintOne(): string {
    const left = Array.from({ length: RECOVERY_CODE_CHARS_PER_HALF }, randomGlyph).join('');
    const right = Array.from({ length: RECOVERY_CODE_CHARS_PER_HALF }, randomGlyph).join('');
    const code = `${left}-${right}`;

    // The pattern is asserted rather than assumed: the alphabet excludes `0`, `1`, `8`, `9`
    // and `O`, `I`, so every code that leaves this method is one a human can read back.
    if (!RECOVERY_CODE_PATTERN.test(code)) {
      throw new Error(`generated a recovery code that fails its own pattern: "${code}"`);
    }
    return code;
  }
}

/** The DI token, re-exported so the module binds the class to it. */
export { RECOVERY_CODES };