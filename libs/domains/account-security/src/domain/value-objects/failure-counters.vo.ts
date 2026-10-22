/**
 * @fileoverview The consecutive-failure counters and the lock they imply.
 *
 * @remarks These counters have no column in `login_history` or `security_signals`, and that is
 * deliberate. They are a *rate*, not a fact: "three failures in the last fifteen minutes" is
 * true for fifteen minutes and then is not, whereas a login attempt is a thing that happened and
 * must be kept. Keeping rates in a relational table would mean a sweeper to expire them and a
 * window function to count them; the store behind `FailureTrackerPort` gives both for free, and
 * the rules that *interpret* the numbers stay on the aggregate either way.
 *
 * @remarks An interface rather than a class: it crosses a port boundary and is carried by a
 * Redis round-trip, so it has to be plain data. The rules that read it live on the
 * `LoginAttempt` aggregate, which is the only place that may decide what the numbers mean.
 */

/** Consecutive failures per user, consecutive failures per ip, and the live lock. */
export interface FailureCounters {
  readonly userFailures: number;
  readonly ipFailures: number;
  /** When the lock lifts. `null` when there is no lock. */
  readonly lockedUntil: Date | null;
}

/** What a user who has never failed, from an ip that has never failed, looks like. */
export const EMPTY_COUNTERS: FailureCounters = {
  userFailures: 0,
  ipFailures: 0,
  lockedUntil: null,
};

/** Which counters a store call is about. Both may be present, and either may be absent. */
export interface FailureScope {
  readonly userId?: string | null;
  readonly ipAddress?: string | null;
}

/**
 * Normalises a scope so `{ userId: undefined }` and `{ userId: null }` address one key set.
 *
 * @remarks Trimming as well as nulling, because the scope is built from a gRPC field and the
 * same user arrives as `" <uuid>"` from one caller and `"<uuid>"` from another. Two counters
 * for one account is a lockout nobody can explain.
 */
export function normaliseScope(scope: FailureScope): Required<FailureScope> {
  return {
    userId: scope.userId?.trim() || null,
    ipAddress: scope.ipAddress?.trim() || null,
  };
}