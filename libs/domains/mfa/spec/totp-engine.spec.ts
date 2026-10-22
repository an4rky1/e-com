/**
 * @fileoverview RFC 4226 and RFC 6238 conformance for the TOTP engine.
 *
 * @remarks These are the *published* test vectors. A suite that only checked "the engine
 * agrees with itself" would pass just as happily with a shifted bit in the dynamic
 * truncation, and the failure would surface as an authenticator app that no longer accepts
 * any code — after every factor in production has been enrolled against it.
 */

import { counterAt, hotp, base32Decode, base32Encode, NodeTotpService } from '../src/infrastructure/crypto/node-totp.service';
import { TOTP_SECRET_PATTERN } from '../src/domain/value-objects/totp-secret.vo';
import { RFC_TEST_SECRET, T0, makeTotp } from './support/fakes';

/** RFC 4226 Appendix D, truncated to the first ten counters. */
const HOTP_VECTORS: ReadonlyArray<readonly [bigint, string]> = [
  [0n, '755224'],
  [1n, '287082'],
  [2n, '359152'],
  [3n, '969429'],
  [4n, '338314'],
  [5n, '254676'],
  [6n, '287922'],
  [7n, '162583'],
  [8n, '399871'],
  [9n, '520489'],
];

/** RFC 6238 Appendix B, SHA-1 row, eight digits. */
const TOTP_VECTORS: ReadonlyArray<readonly [number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('base32', () => {
  it('round-trips the RFC 4226 seed', () => {
    const seed = '12345678901234567890';
    expect(base32Encode(Buffer.from(seed, 'utf8'))).toBe(RFC_TEST_SECRET);
    expect(base32Decode(RFC_TEST_SECRET).toString('utf8')).toBe(seed);
  });

  it('accepts a generated secret and re-encodes it identically', () => {
    const totp = makeTotp();
    const secret = totp.generateSecret();

    expect(secret).toMatch(TOTP_SECRET_PATTERN);
    expect(base32Encode(base32Decode(secret))).toBe(secret);
    // 20 bytes is the RFC 4226 recommendation and exactly one HMAC-SHA1 key.
    expect(base32Decode(secret)).toHaveLength(20);
  });

  it('is case-insensitive and padding-tolerant', () => {
    expect(base32Decode(RFC_TEST_SECRET.toLowerCase()).toString('utf8')).toBe(
      base32Decode(RFC_TEST_SECRET).toString('utf8'),
    );
  });

  it('rejects a character outside the alphabet rather than skipping it', () => {
    // `1` is deliberately absent from RFC 4648 base32; a secret that decodes "mostly" is a
    // key the authenticator app does not hold, and every code would simply fail.
    expect(() => base32Decode('GEZDGNBV1Y3TQOJQ')).toThrow(/base32/);
  });
});

describe('RFC 4226 HOTP', () => {
  it.each(HOTP_VECTORS)('produces %s for counter %s', (counter, expected) => {
    expect(hotp(RFC_TEST_SECRET, counter, 6)).toBe(expected);
  });

  it('keeps the leading zero of a short code', () => {
    // RFC 6238 T=1111111109 is `07081804` at eight digits. Padded to six it must still be six
    // characters; an implementation that returned `708180` would be silently accepted by
    // nothing.
    expect(hotp(RFC_TEST_SECRET, counterAt(new Date(1111111109 * 1000), 30), 8)).toBe('07081804');
  });
});

describe('RFC 6238 TOTP', () => {
  const totp = makeTotp(30, 8);

  it.each(TOTP_VECTORS)('produces %s at T=%s', (seconds, expected) => {
    expect(totp.currentCode(RFC_TEST_SECRET, new Date(seconds * 1000))).toBe(expected);
  });

  it('derives the counter from whole elapsed periods', () => {
    expect(counterAt(new Date(59 * 1000), 30)).toBe(1n);
    expect(counterAt(new Date(60 * 1000), 30)).toBe(2n);
    // T0 is 0: the epoch itself is step zero, never step one.
    expect(counterAt(new Date(0), 30)).toBe(0n);
  });
});

describe('verification window', () => {
  const totp = makeTotp();
  const at = (offsetSeconds: number): Date => new Date(T0.getTime() + offsetSeconds * 1000);

  it('accepts the current step', () => {
    const match = totp.verify({
      secret: RFC_TEST_SECRET,
      code: totp.currentCode(RFC_TEST_SECRET, T0),
      at: T0,
      window: 1,
    });

    expect(match).not.toBeNull();
    expect(match?.drift).toBe(0);
    expect(match?.counter).toBe(counterAt(T0, 30));
  });

  it('accepts one step of skew either side, and reports the step it matched', () => {
    const previous = totp.verify({
      secret: RFC_TEST_SECRET,
      code: totp.currentCode(RFC_TEST_SECRET, at(-30)),
      at: T0,
      window: 1,
    });
    expect(previous?.drift).toBe(-1);

    const next = totp.verify({
      secret: RFC_TEST_SECRET,
      code: totp.currentCode(RFC_TEST_SECRET, at(30)),
      at: T0,
      window: 1,
    });
    expect(next?.drift).toBe(1);
  });

  it('refuses a code two steps old', () => {
    const stale = totp.verify({
      secret: RFC_TEST_SECRET,
      code: totp.currentCode(RFC_TEST_SECRET, at(-60)),
      at: T0,
      window: 1,
    });
    expect(stale).toBeNull();
  });

  it('refuses everything when the window is zero', () => {
    expect(
      totp.verify({
        secret: RFC_TEST_SECRET,
        code: totp.currentCode(RFC_TEST_SECRET, at(-30)),
        at: T0,
        window: 0,
      }),
    ).toBeNull();
  });

  it('refuses a malformed code without treating it as a near miss', () => {
    for (const code of ['12345', '1234567', 'abcdef', '', ' 123456']) {
      expect(
        totp.verify({ secret: RFC_TEST_SECRET, code, at: T0, window: 1 }),
      ).toBeNull();
    }
  });

  it('answers null — not a throw — for a corrupt secret', () => {
    // A corrupt envelope is a storage problem. Refusing the request is the safe way to fail,
    // and the caller must not be handed an oracle that distinguishes it from a wrong code.
    expect(
      totp.verify({ secret: 'not-base32!!', code: '123456', at: T0, window: 1 }),
    ).toBeNull();
  });
});

describe('secret generation', () => {
  it('does not repeat', () => {
    const totp = new NodeTotpService(30, 6);
    const secrets = new Set(Array.from({ length: 50 }, () => totp.generateSecret()));
    expect(secrets.size).toBe(50);
  });
});