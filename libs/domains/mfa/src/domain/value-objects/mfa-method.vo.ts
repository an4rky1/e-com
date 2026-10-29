/**
 * @fileoverview The proofs this service can check.
 *
 * @remarks Deliberately short. mfa answers "prove possession of a second factor" and nothing
 * else — it never decides *whether* a second factor is required. That decision belongs to
 * auth-flow, which knows the risk of the request; if this service could require MFA on its
 * own it would be making a policy call with no view of the request at all.
 *
 * @remarks A string union rather than a TypeScript `enum`, for the same reason as
 * {@link MfaStatus}: the enum emits runtime code and the storage and wire formats are text.
 */

/** Methods a factor can be enrolled with, and the proofs it can be verified by. */
export const MfaMethod = {
  /** RFC 6238 time-based one-time password. */
  TOTP: 'totp',
  /** A single-use code drawn from the user's recovery-code set. */
  BACKUP_CODE: 'backup_code',
} as const;

export type MfaMethod = (typeof MfaMethod)[keyof typeof MfaMethod];

export const MFA_METHODS: readonly MfaMethod[] = Object.values(MfaMethod);

/**
 * Methods that enrol a *factor* of their own.
 *
 * @remarks `backup_code` is excluded: recovery codes are not a factor. They hang off the user
 * in `mfa_recovery_code_sets`, which the schema enforces with a unique `user_id` — one set per
 * person, no matter how many factors they hold.
 */
export const ENROLLABLE_METHODS: readonly MfaMethod[] = [MfaMethod.TOTP];

export function isMfaMethod(value: unknown): value is MfaMethod {
  return (
    typeof value === 'string' &&
    (Object.values(MfaMethod) as string[]).includes(value)
  );
}

/** RFC 6238 defaults. Named so the tests and the docs cite the same numbers. */
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SEC = 30;
/**
 * Steps of clock skew tolerated either side of the current step.
 *
 * @remarks 1 means a code stays usable for 30s before and 30s after its nominal window — 90s
 * of tolerance in total. Wider would multiply the guessable space an attacker can try inside
 * one lockout window; narrower locks out honest users whose phones drift.
 */
export const TOTP_WINDOW = 1;

/** The only shape a submitted TOTP code may have. Six digits, leading zeroes kept. */
export const TOTP_CODE_PATTERN = /^[0-9]{6}$/;

/** Recovery codes are `XXXXX-XXXXX` over an alphabet with no ambiguous glyphs. */
export const RECOVERY_CODE_PATTERN = /^[A-Z2-7]{5}-[A-Z2-7]{5}$/;

/** The user-facing secret bundle is only meaningful for a TOTP factor. */
export const TOTP_OTP_LABEL = 'totp';
export const TOTP_ALGORITHM = 'SHA1';