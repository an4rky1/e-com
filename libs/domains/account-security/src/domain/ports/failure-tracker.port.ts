/**
 * @fileoverview The rate store for failed logins.
 *
 * @remarks Declared in the domain and implemented in infrastructure with Redis, so the
 * lockout rules stay testable without a server. The split follows the one rule that matters
 * here: the *policy* — when N failures means a lock, and how long it lasts — belongs to the
 * aggregate, and the store only has to remember a number.
 */
import type { FailureCounters, FailureScope } from '../value-objects/failure-counters.vo';

export const FAILURE_TRACKER = Symbol('FAILURE_TRACKER');

/**
 * What a counter store has to be able to do.
 *
 * @remarks `load`/`save` rather than `recordFailure`: an `INCR`-and-lock-it-all implementation
 * would put the lockout policy inside a Redis adapter, where it could not be unit-tested
 * without a Redis server and could not be changed without a deploy.
 */
export interface FailureTrackerPort {
  /**
   * The counters for the user and/or the ip in `scope`.
   *
   * @remarks Counters for an absent scope are zero, never an error. A login attempt can arrive
   * with an email and no `user_id`, and "we do not know who this is" is the normal case for
   * the very requests a credential-stuffing run generates.
   */
  load(scope: FailureScope): Promise<FailureCounters>;

  /** Overwrites the counters. Called after the aggregate has decided what they become. */
  save(scope: FailureScope, counters: FailureCounters): Promise<void>;

  /**
   * Forgets the counters and any lock for this scope.
   *
   * @remarks Explicit because clearing must be a deliberate act, not a side effect of writing
   * a zero, and because a `DEL` for a key that was never set has to be a no-op rather than an
   * error that turns a valid sign-in into a 500.
   */
  clear(scope: FailureScope): Promise<void>;
}