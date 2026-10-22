/**
 * @fileoverview The factor state machine, driven from a fixed clock.
 *
 * @remarks No Nest bootstrap and no database: the aggregate takes a clock, a TOTP engine and a
 * policy as arguments precisely so that "is a replay accepted?" and "does a code from forty
 * seconds ago work?" can be *decided* rather than approximated. Every timestamp here is
 * derived from {@link T0}, and every code is generated for a known step.
 */

import { MfaFactor } from '../src/domain/mfa-factor.aggregate';
import { MfaErrorReason, isMfaDomainError } from '../src/domain/errors/mfa-domain.error';
import { DEFAULT_POLICY, type MfaPolicy } from '../src/domain/mfa-policy';
import {
  MfaStatus,
  VERIFIABLE_STATUSES,
  canTransition,
} from '../src/domain/value-objects/mfa-status.vo';
import { TOTP_CODE_PATTERN } from '../src/domain/value-objects/mfa-method.vo';
import {
  RFC_TEST_SECRET,
  T0,
  USER_ID,
  factorRowOf,
  makeTotp,
  makeVault,
} from './support/fakes';

const totp = makeTotp();
const vault = makeVault();
const policy: MfaPolicy = { ...DEFAULT_POLICY };

const at = (offsetSeconds = 0): Date => new Date(T0.getTime() + offsetSeconds * 1000);
const codeFor = (offsetSeconds: number): string =>
  totp.currentCode(RFC_TEST_SECRET, at(offsetSeconds));

/** Enrolls and confirms a factor, returning it in `active` with its step already spent. */
async function activeFactor(confirmAtSeconds = 0): Promise<MfaFactor> {
  const factor = await enroll();
  factor.confirmEnrollment({
    code: codeFor(confirmAtSeconds),
    secret: RFC_TEST_SECRET,
    now: at(confirmAtSeconds),
    totp,
    policy,
  });
  return factor;
}

async function enroll(now: Date = T0): Promise<MfaFactor> {
  return MfaFactor.beginEnrollment({
    userId: USER_ID,
    secretCiphertext: await vault.encrypt(RFC_TEST_SECRET),
    enrollmentTtlMs: 600_000,
    now,
  });
}

const reasonOf = (error: unknown): string | undefined =>
  isMfaDomainError(error) ? error.reason : undefined;

describe('enrollment state machine', () => {
  it('starts unverified and moves to pending, never anywhere else', async () => {
    const factor = await enroll();

    expect(factor.status).toBe(MfaStatus.PENDING);
    // `unverified` exists only as the initial row state: the constructor sets it and the
    // factory immediately makes the one legal move out of it.
    expect(canTransition(MfaStatus.UNVERIFIED, MfaStatus.PENDING)).toBe(true);
    expect(canTransition(MfaStatus.UNVERIFIED, MfaStatus.ACTIVE)).toBe(false);

    // Draining is destructive, so the buffer is captured once and then inspected.
    const events = factor.clearDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('mfa.enrollment_started');
    expect(events[0]?.aggregateType).toBe('MfaFactor');
  });

  it('is pending, not active, until a code proves possession', async () => {
    const factor = await enroll();

    expect(factor.canSatisfyVerification).toBe(false);
    expect(VERIFIABLE_STATUSES.has(factor.status)).toBe(false);
    expect(factor.secretCiphertext).toBeNull();
    // The candidate envelope is stored, so the confirmation has something to check against.
    expect(factor.pendingSecretValue).not.toBeNull();
  });

  it('refuses to become active without a valid code', async () => {
    const factor = await enroll();

    expect(() =>
      factor.confirmEnrollment({
        code: '000000',
        secret: RFC_TEST_SECRET,
        now: at(),
        totp,
        policy,
      }),
    ).toThrow();

    expect(factor.status).toBe(MfaStatus.PENDING);
    expect(factor.canSatisfyVerification).toBe(false);
    expect(factor.secretCiphertext).toBeNull();
  });

  it('refuses a code for another secret', async () => {
    const factor = await enroll();

    expect(() =>
      factor.confirmEnrollment({
        code: totp.currentCode('JBSWY3DPEHPK3PXP', at()),
        secret: RFC_TEST_SECRET,
        now: at(),
        totp,
        policy,
      }),
    ).toThrow();
  });

  it('promotes to active on a valid code and destroys the pending envelope', async () => {
    const factor = await activeFactor();

    expect(factor.status).toBe(MfaStatus.ACTIVE);
    expect(factor.canSatisfyVerification).toBe(true);
    expect(factor.activatedAt).toEqual(at());
    expect(factor.pendingSecretValue).toBeNull();
    expect(factor.pendingSecretExpiresAt).toBeNull();
    expect(factor.secretCiphertext).not.toBeNull();
  });

  it('refuses confirmation once the enrollment window has closed', async () => {
    const factor = await enroll();

    expect(reasonOf(
      (() => {
        try {
          factor.confirmEnrollment({
            code: codeFor(0),
            secret: RFC_TEST_SECRET,
            now: at(601),
            totp,
            policy,
          });
          return null;
        } catch (error) {
          return error;
        }
      })(),
    )).toBe(MfaErrorReason.ENROLLMENT_EXPIRED);

    expect(factor.status).toBe(MfaStatus.PENDING);
  });

  it('refuses a second confirmation', async () => {
    const factor = await activeFactor();

    expect(() =>
      factor.confirmEnrollment({
        code: codeFor(30),
        secret: RFC_TEST_SECRET,
        now: at(30),
        totp,
        policy,
      }),
    ).toThrow();
    expect(factor.status).toBe(MfaStatus.ACTIVE);
  });
});

describe('a pending factor can never satisfy a verification', () => {
  it('rejects a correct code against a factor that was never confirmed', async () => {
    const factor = await enroll();

    // The code is genuinely right for the stored secret — and it still must not authenticate
    // anybody, because nobody has yet proved the client can compute codes from it.
    const error = (() => {
      try {
        factor.verifyTotp({
          code: codeFor(0),
          secret: RFC_TEST_SECRET,
          now: at(),
          totp,
          policy,
        });
        return null;
      } catch (caught) {
        return caught;
      }
    })();

    expect(reasonOf(error)).toBe(MfaErrorReason.FACTOR_NOT_ACTIVE);
    expect(factor.lastVerifiedAt).toBeNull();
  });

  it('rejects a disabled factor too', async () => {
    const factor = await activeFactor();
    factor.disable({
      code: codeFor(30),
      secret: RFC_TEST_SECRET,
      now: at(30),
      totp,
      policy,
    });

    expect(factor.canSatisfyVerification).toBe(false);
    expect(() =>
      factor.verifyTotp({
        code: codeFor(60),
        secret: RFC_TEST_SECRET,
        now: at(60),
        totp,
        policy,
      }),
    ).toThrow();
  });
});

describe('the skew window', () => {
  it('accepts a code one step old', async () => {
    // Confirmed at T0 (step N), verified at T0+60s (step N+2) with the code from step N+1:
    // the user is 30 seconds ahead of the server's window, which RFC 6238's `window=1`
    // exists to tolerate.
    const factor = await activeFactor();
    const counter = factor.verifyTotp({
      code: codeFor(30),
      secret: RFC_TEST_SECRET,
      now: at(60),
      totp,
      policy,
    });

    expect(counter).toBe(BigInt(Math.floor(at(30).getTime() / 30_000)));
    expect(factor.lastVerifiedAt).toEqual(at(60));
  });

  it('accepts a code one step ahead', async () => {
    const factor = await activeFactor();

    expect(
      factor.verifyTotp({
        code: codeFor(30),
        secret: RFC_TEST_SECRET,
        now: at(),
        totp,
        policy,
      }),
    ).toBe(BigInt(Math.floor(at(30).getTime() / 30_000)));
  });

  it('refuses a code two steps out', async () => {
    const factor = await activeFactor();
    const error = (() => {
      try {
        factor.verifyTotp({
          code: codeFor(0),
          secret: RFC_TEST_SECRET,
          now: at(60),
          totp,
          policy,
        });
        return null;
      } catch (caught) {
        return caught;
      }
    })();

    expect(reasonOf(error)).toBe(MfaErrorReason.CODE_INVALID);
    expect(factor.lastVerifiedAt).toBeNull();
    // Nothing was spent by a failed attempt.
    expect(factor.lastUsedCounter).toBe(BigInt(Math.floor(at(0).getTime() / 30_000)));
  });

  it('refuses every code when the policy window is zero', async () => {
    const factor = await activeFactor();
    const strict: MfaPolicy = { ...policy, window: 0 };

    expect(() =>
      factor.verifyTotp({
        code: codeFor(30),
        secret: RFC_TEST_SECRET,
        now: at(),
        totp,
        policy: strict,
      }),
    ).toThrow();
  });

  it('refuses a code that is not six digits without computing an HMAC', async () => {
    const factor = await activeFactor();

    for (const code of ['', '12345', '1234567', 'abcdef', ' 123456']) {
      expect(TOTP_CODE_PATTERN.test(code)).toBe(false);
      expect(() =>
        factor.verifyTotp({ code, secret: RFC_TEST_SECRET, now: at(30), totp, policy }),
      ).toThrow();
    }
  });
});

describe('replay protection', () => {
  it('refuses the same code twice', async () => {
    const factor = await activeFactor();
    const code = codeFor(30);
    const spent = factor.verifyTotp({
      code,
      secret: RFC_TEST_SECRET,
      now: at(30),
      totp,
      policy,
    });

    expect(spent).toBe(factor.lastUsedCounter);

    const error = (() => {
      try {
        factor.verifyTotp({ code, secret: RFC_TEST_SECRET, now: at(30), totp, policy });
        return null;
      } catch (caught) {
        return caught;
      }
    })();

    expect(reasonOf(error)).toBe(MfaErrorReason.CODE_ALREADY_USED);
    // The marker did not move: a replay must not be able to rewind it either.
    expect(factor.lastUsedCounter).toBe(spent);
  });

  it('refuses the same code replayed from a rehydrated factor', async () => {
    // The real scenario: two HTTP requests, two separate loads from the database. The marker
    // has to survive the round trip, or the second request starts from `null` and succeeds.
    const factor = await activeFactor();
    const code = codeFor(30);
    factor.verifyTotp({ code, secret: RFC_TEST_SECRET, now: at(30), totp, policy });

    const reloaded = MfaFactor.fromRow(factorRowOf(factor));
    expect(reloaded.lastUsedCounter).toBe(factor.lastUsedCounter);

    expect(() =>
      reloaded.verifyTotp({ code, secret: RFC_TEST_SECRET, now: at(30), totp, policy }),
    ).toThrow();
  });

  it('refuses the confirmation code being reused for a verification', async () => {
    const factor = await activeFactor();

    // The confirmation is itself a possession proof, so it spends its step. An observer who
    // read the code off the enrolment screen must not still have a working credential.
    expect(() =>
      factor.verifyTotp({
        code: codeFor(0),
        secret: RFC_TEST_SECRET,
        now: at(30),
        totp,
        policy,
      }),
    ).toThrow();
  });

  it('refuses an earlier step, but accepts a later one', async () => {
    const factor = await activeFactor();
    factor.verifyTotp({ code: codeFor(30), secret: RFC_TEST_SECRET, now: at(30), totp, policy });

    // Step N is still inside the window at T0+30s, and it was already spent at enrolment.
    expect(() =>
      factor.verifyTotp({ code: codeFor(0), secret: RFC_TEST_SECRET, now: at(30), totp, policy }),
    ).toThrow();

    expect(() =>
      factor.verifyTotp({ code: codeFor(60), secret: RFC_TEST_SECRET, now: at(60), totp, policy }),
    ).not.toThrow();
  });

  it('clears the marker on disable, because a re-enrolment is a new factor', async () => {
    const factor = await activeFactor();
    factor.verifyTotp({ code: codeFor(30), secret: RFC_TEST_SECRET, now: at(30), totp, policy });

    factor.disable({ code: codeFor(60), secret: RFC_TEST_SECRET, now: at(60), totp, policy });

    expect(factor.lastUsedCounter).toBeNull();
  });
});

describe('lockout', () => {
  it('locks the factor once the attempt budget is spent, and stays locked', async () => {
    const factor = await activeFactor();
    const shortLived: MfaPolicy = { window: 1, maxFailedAttempts: 3, lockoutMs: 300_000 };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      factor.registerFailure(MfaErrorReason.CODE_INVALID, at(30), shortLived);
    }

    expect(factor.failedAttempts).toBe(3);
    expect(factor.isLocked(at(30))).toBe(true);
    expect(reasonOf(
      (() => {
        try {
          factor.verifyTotp({
            code: codeFor(30),
            secret: RFC_TEST_SECRET,
            now: at(30),
            totp,
            policy: shortLived,
          });
          return null;
        } catch (caught) {
          return caught;
        }
      })(),
    )).toBe(MfaErrorReason.FACTOR_LOCKED);

    // ...and releases on its own, without an operator.
    expect(factor.isLocked(at(30 + 301))).toBe(false);
  });

  it('resets the budget on a success', async () => {
    const factor = await activeFactor();
    factor.registerFailure(MfaErrorReason.CODE_INVALID, at(30), policy);
    expect(factor.failedAttempts).toBe(1);

    factor.verifyTotp({ code: codeFor(30), secret: RFC_TEST_SECRET, now: at(30), totp, policy });

    expect(factor.failedAttempts).toBe(0);
    expect(factor.lockedUntil).toBeNull();
  });
});

describe('disabling', () => {
  it('requires a valid code', async () => {
    const factor = await activeFactor();

    expect(() =>
      factor.disable({ code: '000000', secret: RFC_TEST_SECRET, now: at(30), totp, policy }),
    ).toThrow();
    expect(factor.status).toBe(MfaStatus.ACTIVE);
    expect(factor.secretCiphertext).not.toBeNull();
  });

  it('destroys the secret rather than flagging it', async () => {
    const factor = await activeFactor();
    const envelope = factor.secretCiphertext;

    factor.disable({ code: codeFor(30), secret: RFC_TEST_SECRET, now: at(30), totp, policy });

    expect(factor.status).toBe(MfaStatus.DISABLED);
    expect(factor.secretCiphertext).toBeNull();
    expect(factor.pendingSecretValue).toBeNull();

    // The captured envelope is still a ciphertext, and it is no longer on the row: any code
    // an attacker had verified against the old factor has nothing left to verify against.
    expect(await vault.decrypt(envelope as string)).toBe(RFC_TEST_SECRET);
    expect(factorRowOf(factor).secret_ciphertext).toBeNull();
    expect(factorRowOf(factor).totp_used_counters).toBeNull();
  });

  it('allows the code just used to sign in, because this ends in revocation', async () => {
    // Requiring a fresh step here would mean a user who signed in with the current code
    // could not turn MFA off at all until the next one arrived.
    const factor = await activeFactor();
    const code = codeFor(30);
    factor.verifyTotp({ code, secret: RFC_TEST_SECRET, now: at(30), totp, policy });

    expect(() =>
      factor.disable({ code, secret: RFC_TEST_SECRET, now: at(30), totp, policy }),
    ).not.toThrow();
  });

  it('emits mfa.disabled exactly once', async () => {
    const factor = await activeFactor();
    factor.clearDomainEvents();

    factor.disable({ code: codeFor(30), secret: RFC_TEST_SECRET, now: at(30), totp, policy });

    expect(factor.clearDomainEvents().map((event) => event.eventType)).toEqual(['mfa.disabled']);
  });
});

describe('secret handling', () => {
  it('holds an envelope, never the secret', async () => {
    const factor = await activeFactor();

    expect(factor.secretCiphertext).not.toBe(RFC_TEST_SECRET);
    expect(await vault.decrypt(factor.secretCiphertext as string)).toBe(RFC_TEST_SECRET);
    // Nothing the aggregate exposes, or anything that serialises it, carries the plaintext.
    // The replacer only exists because `last_used_counter` is a `bigint` and `JSON.stringify`
    // refuses one; the question asked is "is the secret anywhere in the graph".
    const replacer = (_key: string, value: unknown): unknown =>
      typeof value === 'bigint' ? value.toString() : value;

    expect(JSON.stringify(factor, replacer)).not.toContain(RFC_TEST_SECRET);
    expect(JSON.stringify(factorRowOf(factor), replacer)).not.toContain(RFC_TEST_SECRET);
  });

  it('never puts the secret on a domain event', async () => {
    const factor = await enroll();
    const confirmation = factor.clearDomainEvents();
    factor.confirmEnrollment({
      code: codeFor(0),
      secret: RFC_TEST_SECRET,
      now: at(),
      totp,
      policy,
    });

    for (const event of [...confirmation, ...factor.clearDomainEvents()]) {
      expect(JSON.stringify(event)).not.toContain(RFC_TEST_SECRET);
    }
  });
});