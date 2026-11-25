/**
 * @fileoverview RFC 6238, over RFC 4226's HMAC-based one-time password.
 *
 * @remarks Implemented here rather than pulled from a package on purpose. The whole algorithm
 * is an HMAC-SHA1 over a counter and a dynamic truncation — a few dozen lines — and vendoring
 * it buys control over the two properties the service actually depends on: which *step* a code
 * belongs to is returned to the caller, and a fresh secret comes from the CSPRNG. A dependency
 * that exposes only `verify(secret, code) -> boolean` would leave the replay rule with nothing
 * to key on and force the counter to be recomputed, duplicated, and eventually to disagree
 * with what was verified.
 *
 * @remarks SHA-1 and six digits are not a choice, they are the interoperability requirement:
 * every authenticator app in existence implements exactly this profile. The security of the
 * scheme rests on the HMAC key, not on the digest's collision resistance — and the key is a
 * CSPRNG 160-bit secret that never leaves an encrypted envelope.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { type TotpEnginePort, type TotpMatch } from '../../domain/ports/totp.port';
import { TOTP_WINDOW } from '../../domain/value-objects/mfa-method.vo';
import {
  BASE32_ALPHABET,
  TOTP_SECRET_BYTES,
} from '../../domain/value-objects/totp-secret.vo';
import { MFA_TOTP_DIGITS, MFA_TOTP_PERIOD_SEC } from '../../mfa.config';

/**
 * Decodes an RFC 4648 base32 string to bytes.
 *
 * @remarks No padding is produced or accepted: the alphabet is fixed-width here and the
 * encoded length is a multiple of 8 for a 160-bit secret, so there is nothing to pad. Anything
 * unrecognised throws rather than being skipped — a secret that decodes "mostly" is a key that
 * differs from the one the authenticator app holds, and every code would simply fail with no
 * explanation.
 */
export function base32Decode(input: string): Buffer {
  const normalised = input.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const character of normalised) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) {
      throw new Error(`"${character}" is not a base32 character`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((value >>> bits) & 0xff);
    }
  }

  return Buffer.from(output);
}

/** Encodes bytes as unpadded RFC 4648 base32 — the form an `otpauth://` URI carries. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }

  return output;
}

/** The 8-byte big-endian counter RFC 4226 hashes. */
const counterBuffer = (counter: bigint): Buffer => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt.asUintN(64, counter));
  return buffer;
};

/**
 * Dynamic truncation, RFC 4226 §5.4.
 *
 * @remarks The low nibble of the last byte chooses the four-byte window; bit 7 of that window's
 * first byte is cleared so the result stays positive in a signed 32-bit read, and the modulo
 * then produces the digits. Both steps are the specification, not an implementation detail —
 * skipping either yields codes no authenticator app will produce.
 */
export const hotp = (
  secret: string,
  counter: bigint,
  digits: number,
): string => {
  const digest = createHmac('sha1', base32Decode(secret))
    .update(counterBuffer(counter))
    .digest();

  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, '0');
};

/**
 * The counter for a moment in time.
 *
 * @remarks T0 is 0, so the counter is simply elapsed whole periods since the Unix epoch. It is
 * a `bigint`: at 30-second steps the counter passes 2^31 in 2038-adjacent timeframes and a JS
 * number would start losing steps, which would mean silently accepting the wrong codes.
 */
export const counterAt = (at: Date, periodSec: number): bigint =>
  BigInt(Math.floor(at.getTime() / 1_000 / periodSec));

/** Constant-time over equal-length buffers; length differences short-circuit. */
const equalOtp = (left: string, right: string): boolean => {
  const expected = Buffer.from(left, 'utf8');
  const actual = Buffer.from(right, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

@Injectable()
export class NodeTotpService implements TotpEnginePort {
  private readonly logger = new Logger(NodeTotpService.name);

  constructor(
    @Inject(MFA_TOTP_PERIOD_SEC)
    private readonly periodSec: number,
    @Inject(MFA_TOTP_DIGITS)
    private readonly digits: number,
  ) {}

  generateSecret(): string {
    return base32Encode(randomBytes(TOTP_SECRET_BYTES));
  }

  currentCode(secret: string, at: Date): string {
    return hotp(secret, counterAt(at, this.periodSec), this.digits);
  }

  /**
   * Tries the current step, then `window` steps either side.
   *
   * @remarks The current step is tried first so the reported {@link TotpMatch.drift} is `0`
   * for a code typed on time, which is what makes the `last_counter` marker meaningful rather
   * than arbitrary: it records the furthest step the user has actually reached, so a stale
   * code from an earlier step inside the window is refused instead of rolling the marker
   * backwards.
   *
   * @remarks A malformed secret is treated as a non-match rather than a throw. A corrupt
   * envelope is a storage problem, and refusing the request is the safe way to fail — the
   * caller gets the same answer as for a wrong code and no oracle tells them which it was.
   */
  verify(input: {
    readonly secret: string;
    readonly code: string;
    readonly at: Date;
    readonly window: number;
  }): TotpMatch | null {
    try {
      const current = counterAt(input.at, this.periodSec);
      const window = Math.max(0, Math.floor(input.window ?? TOTP_WINDOW));

      for (let drift = 0; drift <= window; drift += 1) {
        for (const candidate of drift === 0 ? [0n] : [BigInt(drift), BigInt(-drift)]) {
          const counter = current + candidate;
          // Negative counters cannot occur in practice, but a clock set before 1970 would
          // produce one, and BigInt would then wrap into an enormous positive step that could
          // match an unrelated code.
          if (counter < 0n) continue;
          if (equalOtp(hotp(input.secret, counter, this.digits), input.code)) {
            return { counter, drift: Number(candidate) };
          }
        }
      }
    } catch (error) {
      this.logger.warn(
        `TOTP verification could not be evaluated: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return null;
  }
}