/**
 * @fileoverview The tunable limits, expressed as one value object.
 *
 * @remarks Passed *into* the aggregate rather than read from configuration inside it. The
 * domain has no idea a config file exists — which is what keeps the security rules testable —
 * and an operator can tighten `maxFailedAttempts` without a deployment that recompiles the
 * aggregate.
 *
 * @remarks Grouped into one type because they travel together: every code check needs the
 * window and the attempt budget at the same time, and three separate arguments is three ways
 * to pass the wrong one to the wrong method.
 */

/** RFC 6238's fixed parameters for this platform. */
export interface TotpPolicy {
  /** Steps of clock skew tolerated either side of the current step. */
  readonly window: number;
}

/** What repeated wrong codes cost the factor. */
export interface LockoutPolicy {
  /** Wrong codes tolerated before the factor locks. */
  readonly maxFailedAttempts: number;
  /** How long a lock lasts. Zero disables the lockout entirely. */
  readonly lockoutMs: number;
}

export type MfaPolicy = TotpPolicy & LockoutPolicy;

export const DEFAULT_POLICY: MfaPolicy = {
  window: 1,
  maxFailedAttempts: 5,
  lockoutMs: 300_000,
};