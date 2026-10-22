/**
 * @fileoverview The password policy, as a pure domain service.
 *
 * @remarks Pure on purpose: no clock, no database, no configuration lookup. Every rule below
 * is a total function of its input, so the whole policy is unit-testable without a Nest
 * container — and a policy that cannot be tested in isolation is a policy that gets weaker
 * every time someone "just relaxes a rule in the handler".
 *
 * @remarks This service never *stores* a policy. It decides whether a candidate password is
 * acceptable; where the thresholds come from is the caller's business.
 */
import { Result, type DomainError } from '@auth/ddd-core';

/**
 * The reasons a candidate password can be refused.
 *
 * @remarks A closed set rather than free-form messages: the handler turns each violation into
 * a `ValidationException` context entry, and a caller that can enumerate the reasons can also
 * enumerate the policy.
 */
export const PasswordPolicyViolation = {
  NOT_A_STRING: 'not_a_string',
  TOO_SHORT: 'too_short',
  TOO_LONG: 'too_long',
  MISSING_UPPERCASE: 'missing_uppercase',
  MISSING_LOWERCASE: 'missing_lowercase',
  MISSING_DIGIT: 'missing_digit',
  MISSING_SYMBOL: 'missing_symbol',
  TOO_COMMON: 'too_common',
} as const;

export type PasswordPolicyViolation =
  (typeof PasswordPolicyViolation)[keyof typeof PasswordPolicyViolation];

/**
 * The smallest length this service will ever accept.
 *
 * @remarks A floor, not a default: `minLength` may be raised by configuration, but a caller
 * that lowers it below twelve characters is not making a different decision, they are making
 * a worse one.
 */
export const PASSWORD_MIN_LENGTH_FLOOR = 12;

/**
 * Upper bound on a stored password.
 *
 * @remarks Argon2 hashes a password of any length, so this is not about the hash — it is
 * about the 32 KiB `UNLOGGED` value nobody will ever look at. A megabyte-long "password" is
 * a denial-of-service request with extra steps.
 */
export const PASSWORD_MAX_LENGTH = 256;

/**
 * The passwords an attacker tries first.
 *
 * @remarks A short list on purpose. This is not a breach-corpus check — it catches the
 * `Password1!`-class password that satisfies every structural rule above and is still the
 * first hundred guesses in any credential-stuffing run. A full corpus is the *hash's* job to
 * defeat, not a policy's.
 */
export const COMMON_PASSWORDS: readonly string[] = [
  'password',
  'password1',
  'password123',
  'passw0rd',
  'qwerty',
  'qwerty123',
  'letmein',
  'welcome',
  'welcome1',
  'admin',
  'admin123',
  'administrator',
  'iloveyou',
  'sunshine',
  'princess',
  'football',
  'baseball',
  'monkey',
  'dragon',
  'master',
  'login',
  'abc123',
  'starwars',
  'changeme',
  'trustno1',
  'superman',
  'hello',
  'freedom',
  'whatever',
  'shadow',
  '123456',
  '12345678',
  '123456789',
  '1234567890',
  'qwertyuiop',
  'zaq12wsx',
] as const;

const UPPERCASE = /[A-Z]/;
const LOWERCASE = /[a-z]/;
/** Bracketed deliberately: an unbracketed `/0-9/` matches the literal text "0-9", and would
 *  report every password as digit-less — which is exactly what it did until it was tested. */
const DIGIT = /[0-9]/;
/** Anything that is not a letter or a digit. */
const SYMBOL = /[^A-Za-z0-9]/;

export interface PasswordPolicyRules {
  minLength: number;
  maxLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
  rejectCommon: boolean;
  commonPasswords: readonly string[];
}

/**
 * Evaluates candidate passwords against one set of rules.
 *
 * @remarks Stateless and immutable: two instances built from the same rules are
 * interchangeable, so a test can hold its own policy without touching the configured one.
 */
export class PasswordPolicy {
  /** Thresholds applied when configuration does not override them. */
  static readonly DEFAULTS = {
    minLength: PASSWORD_MIN_LENGTH_FLOOR,
    maxLength: PASSWORD_MAX_LENGTH,
    requireUppercase: true,
    requireLowercase: true,
    requireDigit: true,
    requireSymbol: true,
    rejectCommon: true,
  } as const;

  private constructor(readonly rules: PasswordPolicyRules) {}

  /**
   * Builds a policy.
   *
   * @remarks `minLength` is clamped up to {@link PASSWORD_MIN_LENGTH_FLOOR} rather than
   * validated: a caller asking for a shorter policy is a misconfiguration, and silently
   * honouring it would ship the weaker password policy nobody reviewed.
   */
  static of(overrides: Partial<PasswordPolicyRules> = {}): PasswordPolicy {
    const defaults = PasswordPolicy.DEFAULTS;
    return new PasswordPolicy({
      minLength: Math.max(
        overrides.minLength ?? defaults.minLength,
        PASSWORD_MIN_LENGTH_FLOOR,
      ),
      maxLength: overrides.maxLength ?? defaults.maxLength,
      requireUppercase: overrides.requireUppercase ?? defaults.requireUppercase,
      requireLowercase: overrides.requireLowercase ?? defaults.requireLowercase,
      requireDigit: overrides.requireDigit ?? defaults.requireDigit,
      requireSymbol: overrides.requireSymbol ?? defaults.requireSymbol,
      rejectCommon: overrides.rejectCommon ?? defaults.rejectCommon,
      commonPasswords: overrides.commonPasswords ?? COMMON_PASSWORDS,
    });
  }

  /** The policy this service ships with. */
  static standard(): PasswordPolicy {
    return PasswordPolicy.of();
  }

  /**
   * Every rule the candidate breaks, in a fixed order.
   *
   * @remarks All violations are reported rather than the first one: a user being told
   * "add a symbol" and then "add a digit" on the next attempt has learned nothing, and a
   * policy that reveals its rules one at a time is a policy being reverse-engineered.
   *
   * @returns an empty array when the password is acceptable.
   */
  evaluate(password: unknown): readonly PasswordPolicyViolation[] {
    if (typeof password !== 'string') {
      return [PasswordPolicyViolation.NOT_A_STRING];
    }

    const { rules } = this;
    const violations: PasswordPolicyViolation[] = [];

    if (password.length < rules.minLength) {
      violations.push(PasswordPolicyViolation.TOO_SHORT);
    }
    if (password.length > rules.maxLength) {
      violations.push(PasswordPolicyViolation.TOO_LONG);
    }
    if (rules.requireUppercase && !UPPERCASE.test(password)) {
      violations.push(PasswordPolicyViolation.MISSING_UPPERCASE);
    }
    if (rules.requireLowercase && !LOWERCASE.test(password)) {
      violations.push(PasswordPolicyViolation.MISSING_LOWERCASE);
    }
    if (rules.requireDigit && !DIGIT.test(password)) {
      violations.push(PasswordPolicyViolation.MISSING_DIGIT);
    }
    if (rules.requireSymbol && !SYMBOL.test(password)) {
      violations.push(PasswordPolicyViolation.MISSING_SYMBOL);
    }
    if (rules.rejectCommon && this.isCommon(password)) {
      violations.push(PasswordPolicyViolation.TOO_COMMON);
    }

    return violations;
  }

  isAcceptable(password: unknown): boolean {
    return this.evaluate(password).length === 0;
  }

  /**
   * `Result`-shaped view of {@link evaluate}.
   *
   * @remarks For the callers that would otherwise write `if (violations.length > 0)` for the
   * fourth time.
   *
   * @remarks The failure is a `DomainError` rather than a bare array: `Result`'s error type is
   * constrained to `string | DomainError`, and `readonly PasswordPolicyViolation[]` is
   * neither. Every violation rides in `context.violations`, so nothing is lost by the
   * wrapping — the caller reads `.error.context.violations` rather than `.error`.
   */
  check(password: unknown): Result<string, DomainError> {
    const violations = this.evaluate(password);
    return violations.length === 0
      ? Result.ok(PASSWORD_ACCEPTED)
      : Result.invalid('INVARIANT_VIOLATION', PASSWORD_REJECTED_MESSAGE, {
          violations,
        });
  }

  /**
   * Common-password check, case- and separator-insensitive.
   *
   * @remarks `P@ssw0rd!` and `password` are the same guess to any attacker worth the name, so
   * the comparison drops every non-alphanumeric character and case before looking the value
   * up. Without that, the whole check would only catch passwords nobody types.
   */
  private isCommon(password: string): boolean {
    const canonical = password.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (canonical.length === 0) return false;
    return this.rules.commonPasswords.includes(canonical);
  }
}

/** Marker value carried by a successful {@link PasswordPolicy.check}. */
export const PASSWORD_ACCEPTED = 'accepted';

/** Message carried by a failing {@link PasswordPolicy.check}. */
export const PASSWORD_REJECTED_MESSAGE = 'password does not satisfy the password policy';