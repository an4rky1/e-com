/**
 * The password policy.
 *
 * @remarks No Nest container, no `Test.createTestingModule`, no database: the policy is a
 * pure function of its input and its rules, so it is tested by calling it. If a rule ever
 * needs a fixture, a container or a clock to be exercised, it has stopped being a domain
 * service and become a use case.
 */
import {
  COMMON_PASSWORDS,
  PASSWORD_ACCEPTED,
  PASSWORD_MIN_LENGTH_FLOOR,
  PasswordPolicy,
  PasswordPolicyViolation,
} from '../src/domain/value-objects/password-policy.vo';

/** Satisfies every structural rule; only the common-password check can still refuse it. */
const STRONG = 'Saffron-Kestrel-42!';

describe('PasswordPolicy — accepts a strong password', () => {
  it('accepts a long, mixed, punctuated password', () => {
    expect(PasswordPolicy.standard().evaluate(STRONG)).toEqual([]);
    expect(PasswordPolicy.standard().isAcceptable(STRONG)).toBe(true);
  });

  it('accepts it via the Result-shaped API too', () => {
    const result = PasswordPolicy.standard().check(STRONG);
    expect(result.isSuccess).toBe(true);
    expect(result.value).toBe(PASSWORD_ACCEPTED);
  });
});

describe('PasswordPolicy — rejects each weak class', () => {
  const policy = PasswordPolicy.standard();

  const cases: readonly [string, string, PasswordPolicyViolation][] = [
    ['too short', 'Ab1!efghij', PasswordPolicyViolation.TOO_SHORT],
    ['no uppercase', 'saffron-kestrel-42!', PasswordPolicyViolation.MISSING_UPPERCASE],
    ['no lowercase', 'SAFFRON-KESTREL-42!', PasswordPolicyViolation.MISSING_LOWERCASE],
    ['no digit', 'Saffron-Kestrel-!!', PasswordPolicyViolation.MISSING_DIGIT],
    ['no symbol', 'SaffronKestrel421', PasswordPolicyViolation.MISSING_SYMBOL],
    ['too long', `${'A'.repeat(PasswordPolicy.DEFAULTS.maxLength)}a1!`, PasswordPolicyViolation.TOO_LONG],
  ];

  it.each(cases)('%s', (_label, candidate, expected) => {
    expect(policy.evaluate(candidate)).toContain(expected);
    expect(policy.isAcceptable(candidate)).toBe(false);
  });

  it('refuses a non-string without throwing', () => {
    // The candidate arrives from a transport shape the domain does not control, so `undefined`
    // and a number are inputs, not programming errors.
    expect(policy.evaluate(undefined)).toEqual([PasswordPolicyViolation.NOT_A_STRING]);
    expect(policy.evaluate(1234)).toEqual([PasswordPolicyViolation.NOT_A_STRING]);
  });

  it('reports every violation at once rather than the first', () => {
    // A user told "add a symbol" and then "add a digit" on the next attempt has learned
    // nothing, and a policy that reveals rules one at a time is one being reverse-engineered.
    const violations = policy.evaluate('short');

    expect(violations).toEqual(
      expect.arrayContaining([
        PasswordPolicyViolation.TOO_SHORT,
        PasswordPolicyViolation.MISSING_UPPERCASE,
        PasswordPolicyViolation.MISSING_DIGIT,
        PasswordPolicyViolation.MISSING_SYMBOL,
      ]),
    );
  });

  it('carries every violation through check() as well', () => {
    const result = policy.check('short');

    expect(result.isFailure).toBe(true);
    expect(result.error.context.violations).toEqual(policy.evaluate('short'));
  });
});

describe('PasswordPolicy — common passwords', () => {
  const policy = PasswordPolicy.standard();

  it.each(COMMON_PASSWORDS.slice(0, 12))('refuses %s', (candidate) => {
    expect(policy.isAcceptable(candidate)).toBe(false);
  });

  it('refuses a structural pass dressed up with separators and case', () => {
    // `Passw0rd!` satisfies length, case, digit and symbol, and is still one of the first
    // guesses in any credential-stuffing run. Only the canonical comparison catches it.
    expect(policy.evaluate('Passw0rd!')).toContain(PasswordPolicyViolation.TOO_COMMON);
    expect(policy.evaluate('PASS-W0RD!')).toContain(PasswordPolicyViolation.TOO_COMMON);
  });

  it('does not treat leet substitutions as a different password', () => {
    // Worth stating explicitly: the canonical form strips punctuation and case but does *not*
    // undo `a`->`@`, so `P@ssw0rd!` slips through. It is caught by the offline-cracking cost
    // Argon2 imposes, not by this list — which is the honest division of labour.
    expect(policy.evaluate('P@ssw0rd!')).not.toContain(PasswordPolicyViolation.TOO_COMMON);
  });

  it('can be turned off by configuration', () => {
    const relaxed = PasswordPolicy.of({ rejectCommon: false });
    expect(relaxed.evaluate('P@ssw0rd!')).not.toContain(PasswordPolicyViolation.TOO_COMMON);
  });
});

describe('PasswordPolicy.of', () => {
  it('clamps minLength up to the floor rather than honouring a lower request', () => {
    // A caller asking for a shorter policy is a misconfiguration, and silently shipping it
    // would deploy a weaker password policy than anybody reviewed.
    const policy = PasswordPolicy.of({ minLength: 4 });

    expect(policy.rules.minLength).toBe(PASSWORD_MIN_LENGTH_FLOOR);
    expect(policy.isAcceptable('Ab1!efghijkl')).toBe(true);
  });

  it('honours a stricter minLength', () => {
    const policy = PasswordPolicy.of({ minLength: 20 });
    expect(policy.evaluate(STRONG)).toContain(PasswordPolicyViolation.TOO_SHORT);
  });

  it('can relax the structural classes without touching the length floor', () => {
    const policy = PasswordPolicy.of({ requireSymbol: false, requireDigit: false });

    expect(policy.isAcceptable('Saffron-Kestrel')).toBe(true);
  });

  it('is stateless — two instances built from the same rules agree', () => {
    expect(PasswordPolicy.of().rules).toEqual(PasswordPolicy.standard().rules);
  });

  it('accepts a caller-supplied common-password list', () => {
    // The list holds *canonical* forms, so a deployment can extend it without re-deriving
    // every variant itself.
    const policy = PasswordPolicy.of({ commonPasswords: ['adalovelovelace1'] });

    expect(policy.evaluate('Ada-Love-Lovelace-1!')).toContain(PasswordPolicyViolation.TOO_COMMON);
    expect(PasswordPolicy.standard().evaluate('Ada-Love-Lovelace-1!')).toEqual([]);
  });
});