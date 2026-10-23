/**
 * @fileoverview The `LoginAttempt` aggregate: one sign-in, and what it does to the failure state.
 *
 * @remarks This service answers "does this login look like an attack" and it *signals*. It does
 * not block, and it does not decide — a false positive here locks a real person out of their own
 * account, which is a worse outcome for the person than the attack this protects against is for
 * the business. Everything below therefore ends in evidence (a signal, a counter, an event) and
 * nothing ends in a refusal.
 */
import { AggregateRoot, DomainEvent, Ensure } from '@auth/core';
import { DeviceFingerprint } from './value-objects/device-fingerprint.vo';
import { GeoLocation } from './value-objects/geo-location.vo';
import { EMPTY_COUNTERS, type FailureCounters } from './value-objects/failure-counters.vo';

export const LOGIN_ATTEMPT_AGGREGATE = 'LoginAttempt';

/** Why a lock was applied when no caller supplied a reason of its own. */
export const FAILED_ATTEMPTS_LOCK_REASON = 'failed_attempts';

/**
 * How many failures are tolerated, and for how long the refusal lasts.
 *
 * @remarks The ip threshold is separate and higher because the two attacks have different
 * shapes. A per-user limit catches one account being guessed at; a per-ip limit catches a
 * script spraying many accounts. Sharing one number between them lets an attacker pick the
 * lower of the two and lock every account in the system by failing three times each.
 */
export interface LockoutPolicy {
  maxFailedAttempts: number;
  maxIpFailedAttempts: number;
  lockoutSec: number;
}

/** An account was locked. The only fact this service publishes about itself. */
export class AccountLocked extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: {
      readonly userId: string;
      readonly reason: string;
      readonly failedAttempts: number;
      readonly lockedUntil: string;
    },
    version = 1,
  ) {
    super(aggregateId, LOGIN_ATTEMPT_AGGREGATE, 'account.locked', version);
  }
}

/** A lock was lifted — by an unlock command, or by a successful sign-in after expiry. */
export class AccountUnlocked extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: {
      readonly userId: string;
      readonly reason: string;
    },
    version = 1,
  ) {
    super(aggregateId, LOGIN_ATTEMPT_AGGREGATE, 'account.unlocked', version);
  }
}

export interface LoginAttemptProps {
  /**
   * Null when the caller could not resolve who the attempt was for.
   *
   * @remarks The proto accepts an email and no `user_id`, and the requests in that state are
   * exactly the ones worth counting: an attacker spraying a password list at addresses that
   * may not exist. So an unidentified attempt still moves the per-ip counter and still produces
   * a rate, but it cannot write a row — both `login_history.user_id` and
   * `security_signals.user_id` are non-null foreign keys, and hashing the email to fill one
   * would let an attacker lock whichever account they chose to address.
   */
  readonly userId: string | null;
  readonly ipAddress: string | null;
  readonly fingerprint: DeviceFingerprint;
  readonly location: GeoLocation | null;
  readonly sessionId: string | null;
  /** The id this attempt writes, so a caller can correlate its response with the row. */
  readonly attemptId: string;
  occurredAt: Date;
  succeeded: boolean;
  userFailures: number;
  ipFailures: number;
  lockedUntil: Date | null;
  lockReason: string | null;
}

/** The row shape of `login_history`. */
export interface LoginHistoryRow {
  login_id: string;
  user_id: string;
  session_id: string | null;
  fingerprint: string;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  occurred_at: Date;
}

/**
 * One sign-in attempt, and the consecutive-failure state it inherits.
 *
 * @remarks Mutable, and applied to one attempt at a time. The constructor takes the counters as
 * they were *before* this attempt, so the aggregate is a pure function of "state + outcome" and
 * a test can drive ten failures through it without a database. The store behind
 * `FailureTrackerPort` persists whatever the aggregate decides; it never decides.
 *
 * @remarks The attempt itself emits nothing. A successful login is the row it writes, and a
 * failure is the counter movement plus a `SecuritySignal` raised by the caller that scored it —
 * neither is an integration event, and the topic catalogue gives this service nothing to say
 * about "a login happened". Only the two account-lifecycle facts, which *are* consumable
 * elsewhere, emit.
 */
export class LoginAttempt extends AggregateRoot<string> {
  private constructor(private readonly props: LoginAttemptProps, createdAt: Date) {
    super(props.attemptId, createdAt, createdAt, null);
  }

  /**
   * Builds an attempt around the failure state that already exists.
   *
   * @remarks `counters` defaults to empty so a test or a first-ever login needs no fixture. It
   * is passed in rather than read from a store because the aggregate must be constructible
   * without one — that is the whole difference between a domain model and a script.
   */
  static create(input: {
    userId: string | null;
    ipAddress: string;
    fingerprint: DeviceFingerprint;
    location?: GeoLocation | null;
    sessionId?: string | null;
    counters?: FailureCounters;
    id?: string;
    now?: Date;
  }): LoginAttempt {
    Ensure.notEmpty(input.ipAddress, 'ipAddress');
    // The user id is *not* asserted: an attempt that arrives with no resolvable account is
    // still counted. What it may not do is lock, which `recordFailure` enforces.

    const counters = input.counters ?? EMPTY_COUNTERS;
    const now = input.now ?? new Date();

    return new LoginAttempt(
      {
        userId: input.userId?.trim() || null,
        ipAddress: input.ipAddress.trim(),
        fingerprint: input.fingerprint,
        location: input.location ?? null,
        sessionId: input.sessionId ?? null,
        attemptId: input.id ?? crypto.randomUUID(),
        occurredAt: now,
        succeeded: false,
        userFailures: Math.max(0, counters.userFailures),
        ipFailures: Math.max(0, counters.ipFailures),
        lockedUntil: counters.lockedUntil,
        lockReason: counters.lockedUntil ? FAILED_ATTEMPTS_LOCK_REASON : null,
      },
      now,
    );
  }

  /** Rehydration from `login_history`. Emits nothing — the write already happened. */
  static fromRow(row: LoginHistoryRow, counters: FailureCounters = EMPTY_COUNTERS): LoginAttempt {
    const location =
      row.latitude !== null && row.longitude !== null
        ? GeoLocation.fromRow(row.latitude, row.longitude, row.country)
        : null;

    const attempt = new LoginAttempt(
      {
        userId: row.user_id,
        ipAddress: null,
        fingerprint: DeviceFingerprint.fromStored(row.fingerprint),
        location,
        sessionId: row.session_id,
        attemptId: row.login_id,
        occurredAt: row.occurred_at,
        succeeded: true,
        userFailures: counters.userFailures,
        ipFailures: counters.ipFailures,
        lockedUntil: counters.lockedUntil,
        lockReason: counters.lockedUntil ? FAILED_ATTEMPTS_LOCK_REASON : null,
      },
      row.occurred_at,
    );

    return attempt;
  }

  // ---- state -------------------------------------------------------------------

  get userId(): string | null {
    return this.props.userId;
  }

  /** Null only on a rehydrated row: `login_history` has no ip column. */
  get ipAddress(): string | null {
    return this.props.ipAddress;
  }

  get fingerprint(): DeviceFingerprint {
    return this.props.fingerprint;
  }

  get location(): GeoLocation | null {
    return this.props.location;
  }

  get sessionId(): string | null {
    return this.props.sessionId;
  }

  get succeeded(): boolean {
    return this.props.succeeded;
  }

  get occurredAt(): Date {
    return this.props.occurredAt;
  }

  get lockedUntil(): Date | null {
    return this.props.lockedUntil;
  }

  get lockReason(): string | null {
    return this.props.lockReason;
  }

  /** The counters as they stand *after* this attempt has been applied. */
  get counters(): FailureCounters {
    return {
      userFailures: this.props.userFailures,
      ipFailures: this.props.ipFailures,
      lockedUntil: this.props.lockedUntil,
    };
  }

  /**
   * The stored attempt counter, not the event stream's.
   *
   * @remarks `login_history` has no version column, so this is derived from the events this
   * attempt produced. It exists for the outbox `dedup_key`, which has to be stable across a
   * redelivered command: two different attempts are two different `login_id`s already, so the
   * version only has to order the events *within* one attempt.
   */
  override get version(): number {
    return this.domainEvents.length + 1;
  }

  // ---- decisions ---------------------------------------------------------------

  /**
   * Whether this attempt's account refuses logins right now.
   *
   * @remarks A lock with an expiry stops being a lock on its own. Waiting for a sweeper to
   * clear a timestamp would mean a user who mistyped five passwords cannot sign in until some
   * background job happens to run, which is a self-inflicted outage.
   */
  isLocked(now: Date = new Date()): boolean {
    if (this.props.lockedUntil === null) return false;
    return this.props.lockedUntil > now;
  }

  /** Seconds until the lock lifts. Zero when it is not locked. */
  retryAfterSeconds(now: Date = new Date()): number {
    if (!this.isLocked(now) || this.props.lockedUntil === null) return 0;
    return Math.ceil((this.props.lockedUntil.getTime() - now.getTime()) / 1000);
  }

  /** Whether the failures that have accumulated would lock this account. */
  wouldLock(policy: LockoutPolicy): boolean {
    return (
      this.props.userFailures >= policy.maxFailedAttempts ||
      this.props.ipFailures >= policy.maxIpFailedAttempts
    );
  }

  // ---- transitions -------------------------------------------------------------

  /**
   * Records a login that worked, and clears what the last run of failures left behind.
   *
   * @remarks Resets the *user* counter only. The ip counter is shared by every account behind
   * that address, and one of them signing in successfully is not evidence that the address is
   * clean — letting it reset would mean an attacker with one valid account silences the
   * counter for the rest of the run. The ip counter decays on its own window instead.
   *
   * @remarks Clears an expired lock on the way past, because a user coming back after their
   * lockout is exactly the moment the rest of the system needs to hear that they are fine.
   */
  recordSuccess(now: Date = new Date()): void {
    const userId = this.props.userId;

    this.props.succeeded = true;
    this.props.occurredAt = now;
    this.props.userFailures = 0;

    if (this.props.lockedUntil !== null) {
      this.props.lockedUntil = null;
      this.props.lockReason = null;
      this.touch(now);
      this.addDomainEvent(
        new AccountUnlocked(
          this.props.attemptId,
          { userId: userId ?? '', reason: 'successful_login' },
          this.version,
        ),
      );
    }
  }

  /**
   * Records a login that failed, and locks once the budget is spent.
   *
   * @remarks Always increments, including while already locked: an attacker who keeps
   * guessing through a lockout must not be able to make the next correct guess count as their
   * first attempt, and a counter that stops moving is a counter they can probe.
   *
   * @remarks An already-locked attempt is *not* re-locked. Extending the expiry on every guess
   * turns a fifteen-minute lockout into an indefinite one, which is a denial of service
   * delivered to the account's owner rather than to the attacker.
   */
  recordFailure(policy: LockoutPolicy, now: Date = new Date()): void {
    this.props.succeeded = false;
    this.props.occurredAt = now;
    if (this.props.userId !== null) this.props.userFailures += 1;
    this.props.ipFailures += 1;

    // An unidentified attempt stops at the ip counter. A lock is a property of an *account*,
    // and there is none to lock here — and an attacker who could provoke one would hold the
    // denial-of-service lever against every account they guessed a username for.
    if (this.props.userId === null) return;
    if (this.isLocked(now)) return;
    if (!this.wouldLock(policy)) return;

    this.applyLock(
      this.props.userFailures >= policy.maxFailedAttempts ? 'user' : 'ip',
      policy,
      now,
    );
  }

  /**
   * Locks the account on an operator's say-so.
   *
   * @remarks A manual lock replaces whatever the counters implied, including an existing
   * expiry. A support agent who locks an account under investigation means *now*, and leaving
   * a shorter automatic expiry in place would unlock it out from under them.
   */
  lock(reason: string, policy: LockoutPolicy, now: Date = new Date()): void {
    Ensure.notEmpty(reason, 'reason');
    Ensure.notNull(this.props.userId, 'userId: an account lock needs an account');
    this.applyLock('manual', policy, now, reason);
  }

  /**
   * Lifts the lock and clears the run of failures behind it.
   *
   * @remarks Clears the ip counter too, unlike {@link recordSuccess}. An unlock is a human
   * deciding this account is fine, and leaving the address's counter at its threshold would
   * re-lock the account on the very next mistake.
   *
   * @remarks A no-op on an account that is not locked. Unlocking something twice must not
   * publish two `account.unlocked` facts, or a consumer keeping a device count would see two.
   */
  unlock(now: Date = new Date(), reason = 'manual_unlock'): void {
    const userId = this.props.userId;
    Ensure.notNull(userId, 'userId: an account unlock needs an account');
    if (this.props.lockedUntil === null && this.props.userFailures === 0) return;

    this.props.lockedUntil = null;
    this.props.lockReason = null;
    this.props.userFailures = 0;
    this.touch(now);

    this.addDomainEvent(
      new AccountUnlocked(
        this.props.attemptId,
        { userId, reason },
        this.version,
      ),
    );
  }

  /**
   * Applies the lock itself. Private because every route into it has to bump the version and
   * emit the event, and there is exactly one such place.
   */
  private applyLock(
    scope: 'user' | 'ip' | 'manual',
    policy: LockoutPolicy,
    now: Date,
    reason?: string,
  ): void {
    const userId = this.props.userId;
    Ensure.notNull(userId, 'userId: an account lock needs an account');

    this.props.lockedUntil = new Date(now.getTime() + policy.lockoutSec * 1000);
    this.props.lockReason = reason ?? `${FAILED_ATTEMPTS_LOCK_REASON}:${scope}`;
    this.touch(now);

    this.addDomainEvent(
      new AccountLocked(
        this.props.attemptId,
        {
          userId,
          reason: this.props.lockReason,
          failedAttempts: this.props.userFailures,
          lockedUntil: this.props.lockedUntil.toISOString(),
        },
        this.version,
      ),
    );
  }

  /**
   * The `login_history` row for this attempt.
   *
   * @remarks `null` for a failed attempt. The table has no outcome column, and inventing one
   * would mean packing a discriminator into `fingerprint` — which is indexed on
   * `(user_id, fingerprint)` and is how a device is recognised, so overloading it would corrupt
   * device identity to store a fact that belongs in `security_signals`. A failed attempt is
   * therefore the signal the caller raises plus the counter movement, and the history stays a
   * history of logins that happened.
   */
  toRow(): LoginHistoryRow | null {
    if (!this.props.succeeded) return null;
    if (this.props.userId === null) return null;

    return {
      login_id: this.id,
      user_id: this.props.userId,
      session_id: this.props.sessionId,
      fingerprint: this.props.fingerprint.value,
      country: this.props.location?.country ?? null,
      latitude: this.props.location?.latitude ?? null,
      longitude: this.props.location?.longitude ?? null,
      occurred_at: this.props.occurredAt,
    };
  }
}