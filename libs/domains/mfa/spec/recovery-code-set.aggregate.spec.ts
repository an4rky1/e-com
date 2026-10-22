/**
 * @fileoverview Backup codes: generation, single use, and what regeneration destroys.
 *
 * @remarks Single-use is the whole security property of a recovery code — a code that can be
 * replayed is a permanent bypass of the second factor, however short its storage. Every test
 * here is a variation on "the second attempt fails", including after a round trip through
 * persistence.
 */

import { RecoveryCodeSet } from '../src/domain/recovery-code-set.aggregate';
import { MfaErrorReason, isMfaDomainError } from '../src/domain/errors/mfa-domain.error';
import { USER_ID, T0, makeCodes, recoverySetRowOf } from './support/fakes';

const codes = makeCodes();

const reasonOf = (error: unknown): string | undefined =>
  isMfaDomainError(error) ? error.reason : undefined;

const attempt = (fn: () => void): unknown => {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
};

/** A set of `count` fresh codes, with plaintext kept beside the aggregate for assertions. */
function issued(count = 5) {
  const salt = codes.newSalt();
  const plaintext = codes.generate(count);
  const set = RecoveryCodeSet.issue({
    userId: USER_ID,
    salt,
    entries: plaintext.map((code) => ({
      code,
      digest: codes.digest(code, salt),
      consumedAt: null,
    })),
    now: T0,
  });
  return { set, plaintext, salt };
}

describe('issuing a set', () => {
  it('stores digests only', () => {
    const { set, plaintext } = issued();

    expect(set.codeCount).toBe(5);
    expect(set.remaining).toBe(5);
    for (const code of plaintext) {
      expect(set.entries().some((entry) => entry.digest === code)).toBe(false);
      expect(JSON.stringify(set)).not.toContain(code);
    }
  });

  it('exposes no plaintext from a rehydrated set', () => {
    const { set, plaintext } = issued();
    const reloaded = RecoveryCodeSet.fromRow(recoverySetRowOf(set));

    expect(reloaded.codeCount).toBe(5);
    for (const code of plaintext) {
      expect(JSON.stringify(reloaded)).not.toContain(code);
    }
  });

  it('refuses an empty set', () => {
    expect(() =>
      RecoveryCodeSet.issue({ userId: USER_ID, salt: codes.newSalt(), entries: [] }),
    ).toThrow();
  });
});

describe('single use', () => {
  it('spends a code once', () => {
    const { set } = issued();

    set.consumeAt(0, T0);

    expect(set.remaining).toBe(4);
    expect(reasonOf(attempt(() => set.consumeAt(0, T0)))).toBe(MfaErrorReason.CODE_INVALID);
  });

  it('refuses an index that never existed', () => {
    const { set } = issued();

    expect(reasonOf(attempt(() => set.consumeAt(99, T0)))).toBe(MfaErrorReason.CODE_INVALID);
  });

  it('keeps the last code spendable', () => {
    // A user with zero codes and a disabled factor can never authenticate again, and the only
    // remedy — an operator action — is far more disruptive than one spare code.
    const { set } = issued(1);

    expect(reasonOf(attempt(() => set.consumeAt(0, T0)))).toBe(
      MfaErrorReason.RECOVERY_CODES_EXHAUSTED,
    );
    expect(set.remaining).toBe(1);
  });

  it('reports a code spent before this call as unusable', () => {
    const { set } = issued();
    set.consumeAt(2, T0);
    const reloaded = RecoveryCodeSet.fromRow(recoverySetRowOf(set));

    expect(reloaded.unconsumedIndexes()).toEqual([0, 1, 3, 4]);
    expect(reasonOf(attempt(() => reloaded.consumeAt(2, T0)))).toBe(MfaErrorReason.CODE_INVALID);
  });

  it('emits mfa.verified without naming the code', () => {
    const { set, plaintext } = issued();
    set.clearDomainEvents();

    set.consumeAt(1, T0);

    const [event] = set.clearDomainEvents();
    expect(event?.eventType).toBe('mfa.verified');
    expect((event as unknown as { payload: unknown } | undefined)?.payload).toEqual({
      userId: USER_ID,
      method: 'backup_code',
    });
    expect(JSON.stringify(event)).not.toContain(plaintext[1] as string);
  });
});

describe('regeneration', () => {
  it('invalidates every code from the previous set', () => {
    const { set, plaintext } = issued();
    const previousSalt = set.salt;
    set.consumeAt(0, T0);

    const nextSalt = codes.newSalt();
    const replacement = codes.generate(5);
    set.rotate({
      salt: nextSalt,
      entries: replacement.map((code) => ({
        code,
        digest: codes.digest(code, nextSalt),
        consumedAt: null,
      })),
      now: T0,
    });

    expect(set.salt).not.toBe(previousSalt);
    expect(set.remaining).toBe(5);

    // Not one of the old codes can be redeemed against the new digests — including the ones
    // that were never spent, which is the whole point of rotating after a suspected compromise.
    for (const code of plaintext) {
      expect(set.entries().some((entry) => entry.digest === codes.digest(code, set.salt))).toBe(
        false,
      );
    }
    expect(set.entries().some((entry) => entry.digest === codes.digest(replacement[0] as string, set.salt))).toBe(true);
  });

  it('restores the unspent count and stamps the rotation', () => {
    const { set } = issued(3);
    set.consumeAt(0, T0);
    set.consumeAt(1, T0);
    expect(set.remaining).toBe(1);

    const salt = codes.newSalt();
    set.rotate({
      salt,
      entries: codes.generate(4).map((code) => ({
        code,
        digest: codes.digest(code, salt),
        consumedAt: null,
      })),
      now: T0,
    });

    expect(set.remaining).toBe(4);
    expect(set.regeneratedAt).toEqual(T0);
    expect(set.issuedAt).toEqual(T0);
  });

  it('emits mfa.recovery_codes_regenerated, not a per-code event', () => {
    const { set } = issued();
    set.clearDomainEvents();

    const salt = codes.newSalt();
    set.rotate({
      salt,
      entries: codes.generate(2).map((code) => ({
        code,
        digest: codes.digest(code, salt),
        consumedAt: null,
      })),
      now: T0,
    });

    expect(set.clearDomainEvents().map((event) => event.eventType)).toEqual([
      'mfa.recovery_codes_regenerated',
    ]);
  });

  it('refuses a rotation to nothing', () => {
    const { set } = issued();

    expect(() => set.rotate({ salt: codes.newSalt(), entries: [], now: T0 })).toThrow();
    expect(() => set.rotate({ salt: '', entries: issued(1).plaintext.map((code) => ({
      code,
      digest: codes.digest(code, 'salt'),
      consumedAt: null,
    })), now: T0 })).toThrow();
  });
});