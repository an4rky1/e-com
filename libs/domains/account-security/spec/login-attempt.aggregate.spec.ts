/**
 * The `LoginAttempt` aggregate.
 *
 * @remarks The lockout rules, and nothing else. No container, no store, no clock that reads the
 * wall: `now` is a parameter everywhere, so "five failures then a lock" is five lines of
 * arithmetic rather than a test that sleeps fifteen minutes.
 *
 * @remarks Two properties are asserted that a lockout implementation usually gets wrong, and
 * both are about who is affected. A *successful* login must not clear the ip counter, because one
 * legitimate user on a shared address would otherwise silence an attack against everyone else
 * behind it. And a run of failures from an address must never lock an account whose failures
 * were not its own.
 */
import {
  FAILED_ATTEMPTS_LOCK_REASON,
  LOGIN_ATTEMPT_AGGREGATE,
  AccountLocked,
  AccountUnlocked,
  LoginAttempt,
  type LockoutPolicy,
} from '../src/domain/login-attempt.aggregate';
import { DeviceFingerprint } from '../src/domain/value-objects/device-fingerprint.vo';
import { GeoLocation } from '../src/domain/value-objects/geo-location.vo';
import type { LoginHistoryRow } from '../src/domain/login-attempt.aggregate';
import { EMPTY_COUNTERS, type FailureCounters } from '../src/domain/value-objects/failure-counters.vo';
import { payloadFor } from './testing/helpers';

const USER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const OTHER_USER = '1b4e28ba-2fa1-4d1e-883f-6f9f1b2c3d4e';
const IP = '203.0.113.9';
const FINGERPRINT = DeviceFingerprint.compute({ platform: 'linux', userAgent: 'curl/8' });
const LONDON = GeoLocation.of(51.5074, -0.1278, 'GB');

const POLICY: LockoutPolicy = {
  maxFailedAttempts: 5,
  maxIpFailedAttempts: 20,
  lockoutSec: 900,
};

const T0 = new Date('2026-03-01T12:00:00.000Z');
const later = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

/** A fresh attempt that inherits the given counters — the state a rehydrated one would have. */
const attempt = (
  counters: FailureCounters = EMPTY_COUNTERS,
  overrides: { userId?: string | null; ipAddress?: string } = {},
): LoginAttempt =>
  LoginAttempt.create({
    userId: overrides.userId === undefined ? USER_ID : overrides.userId,
    ipAddress: overrides.ipAddress ?? IP,
    fingerprint: FINGERPRINT,
    location: LONDON,
    counters,
    now: T0,
  });

/**
 * Replays `count` failures, carrying the aggregate's counters forward the way the store does.
 *
 * @remarks Each call builds a *new* aggregate from the previous one's counters rather than
 * mutating one instance, because that is what the handler actually does: load, apply, save. A
 * test that reused a single object would pass even if the counters were never read back.
 *
 * @returns the counters after the run *and* the aggregate that produced them, because "was it
 * this attempt that locked?" is a question about an object and not about a number.
 */
const fail = (
  times: number,
  from: FailureCounters = EMPTY_COUNTERS,
): { counters: FailureCounters; last: LoginAttempt } => {
  let counters = from;
  let last = attempt(counters);

  for (let index = 0; index < times; index += 1) {
    last = attempt(counters);
    last.recordFailure(POLICY, T0);
    counters = last.counters;
  }

  return { counters, last };
};

/** The counters after a run of failures, for the assertions that only care about the number. */
const failed = (times: number, from: FailureCounters = EMPTY_COUNTERS): FailureCounters =>
  fail(times, from).counters;

describe('LoginAttempt — a successful login', () => {
  it('writes a login_history row', () => {
    const record = attempt();

    expect(record.recordSuccess(T0)).toBeUndefined();
    expect(record.succeeded).toBe(true);
    expect(record.toRow()).toEqual({
      login_id: record.id,
      user_id: USER_ID,
      session_id: null,
      fingerprint: FINGERPRINT.value,
      country: 'GB',
      latitude: 51.5074,
      longitude: -0.1278,
      occurred_at: T0,
    });
  });

  it('carries the session id when the caller knows one', () => {
    const record = LoginAttempt.create({
      userId: USER_ID,
      ipAddress: IP,
      fingerprint: FINGERPRINT,
      sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      now: T0,
    });
    record.recordSuccess(T0);

    expect(record.toRow()?.session_id).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });

  it('resets the consecutive-failure counter', () => {
    const record = attempt(failed(4));

    record.recordSuccess(T0);

    expect(record.counters.userFailures).toBe(0);
    expect(record.succeeded).toBe(true);
  });

  it('resets to zero however deep the run was', () => {
    const record = attempt({ userFailures: 99, ipFailures: 99, lockedUntil: null });

    record.recordSuccess(T0);

    expect(record.counters.userFailures).toBe(0);
  });

  it('resets after a run that actually reached the threshold', () => {
    const record = attempt(failed(POLICY.maxFailedAttempts + 3));

    record.recordSuccess(T0);

    expect(record.counters.userFailures).toBe(0);
  });

  it('does not clear the ip counter, because one success is not evidence about an address', () => {
    // The counter is shared by every account behind the address. If a legitimate user signing
    // in reset it, an attacker with one valid account could silence the alarm for the whole run.
    const record = attempt({ userFailures: 4, ipFailures: 17, lockedUntil: null });

    record.recordSuccess(T0);

    expect(record.counters.ipFailures).toBe(17);
  });

  it('lifts an expired lock and says so', () => {
    const lockedUntil = later(-1);
    const record = attempt({ userFailures: 5, ipFailures: 5, lockedUntil });

    record.recordSuccess(later(1));

    expect(record.lockedUntil).toBeNull();
    expect(record.isLocked(later(1))).toBe(false);
    expect(record.domainEvents).toHaveLength(1);
    expect(record.domainEvents[0]).toBeInstanceOf(AccountUnlocked);
    expect(payloadFor(record.domainEvents, 'account.unlocked')).toEqual({
      userId: USER_ID,
      reason: 'successful_login',
    });
  });
});

describe('LoginAttempt — lockout at exactly N failures', () => {
  /**
   * The boundary table.
   *
   * @remarks Locking one attempt early locks a real person out for fifteen minutes over a typo,
   * and locking one late gives an attacker a free guess after every burst. `>= N` is the only
   * defensible reading, and it is asserted on both sides of every row.
   */
  const cases: ReadonlyArray<readonly [number, boolean]> = [
    [0, false],
    [1, false],
    [2, false],
    [3, false],
    [4, false],
    [5, true],
    [6, true],
    [7, true],
  ];

  it.each(cases)('%i failures -> locked=%s', (failures, locked) => {
    const { counters } = fail(failures);
    const record = attempt(counters);

    expect(record.counters.userFailures).toBe(failures);
    expect(record.isLocked(T0)).toBe(locked);
  });

  it('does not lock on the attempt before the threshold', () => {
    const record = attempt(failed(POLICY.maxFailedAttempts - 1));

    expect(record.wouldLock(POLICY)).toBe(false);
    expect(record.lockedUntil).toBeNull();
    expect(record.domainEvents).toHaveLength(0);
  });

  it('locks on the attempt that reaches the threshold', () => {
    const { last } = fail(POLICY.maxFailedAttempts);

    expect(last.wouldLock(POLICY)).toBe(true);
    expect(last.lockedUntil).toEqual(later(POLICY.lockoutSec));
    expect(last.lockReason).toBe(`${FAILED_ATTEMPTS_LOCK_REASON}:user`);
  });

  it('counts both the user and the ip on every failure', () => {
    const counters = failed(3);

    expect(counters.userFailures).toBe(3);
    expect(counters.ipFailures).toBe(3);
  });

  it('announces the lock on the attempt that caused it, and only that one', () => {
    const { last } = fail(POLICY.maxFailedAttempts);

    expect(last.domainEvents.filter((event) => event.eventType === 'account.locked')).toHaveLength(1);
    expect(payloadFor(last.domainEvents, 'account.locked')).toMatchObject({
      userId: USER_ID,
      failedAttempts: POLICY.maxFailedAttempts,
    });
  });

  it('does not re-announce or extend when guessing continues through the lock', () => {
    const locked = failed(POLICY.maxFailedAttempts);

    const through = fail(2, locked).last;

    expect(through.domainEvents).toHaveLength(0);
    expect(through.lockedUntil).toEqual(locked.lockedUntil);
    expect(through.counters.userFailures).toBe(POLICY.maxFailedAttempts + 2);
  });

  it('never extends a live lock, so a run cannot become a permanent denial of service', () => {
    const locked = failed(POLICY.maxFailedAttempts);

    const next = attempt(locked);
    next.recordFailure(POLICY, later(60));

    expect(next.lockedUntil).toEqual(locked.lockedUntil);
  });
});

describe('LoginAttempt — a lock expires on its own', () => {
  // An attempt that *inherits* an active lock, which is what the handler loads on every call.
  const locked = attempt(failed(POLICY.maxFailedAttempts));

  it('is locked one second before the expiry', () => {
    expect(locked.isLocked(later(POLICY.lockoutSec - 1))).toBe(true);
    expect(locked.retryAfterSeconds(later(POLICY.lockoutSec - 1))).toBe(1);
  });

  it('is locked at the moment before it, and not at it', () => {
    expect(locked.isLocked(later(POLICY.lockoutSec - 0.001))).toBe(true);
    expect(locked.isLocked(later(POLICY.lockoutSec))).toBe(false);
  });

  it('reports no retry time once it has expired', () => {
    expect(locked.retryAfterSeconds(later(POLICY.lockoutSec))).toBe(0);
  });

  it('is not locked after it', () => {
    const after = attempt(locked.counters);

    expect(after.isLocked(later(POLICY.lockoutSec + 1))).toBe(false);
    expect(after.lockedUntil).not.toBeNull();
  });

  it('does not need a sweeper — the column is read, never flipped', () => {
    // A background job clearing the expiry would mean a user who mistyped five passwords
    // cannot sign in until it happens to run. That is a self-inflicted outage.
    const sixtyDays = attempt(locked.counters);

    expect(sixtyDays.isLocked(later(POLICY.lockoutSec * 1_000))).toBe(false);
  });
});

describe('LoginAttempt — unlocking', () => {
  const locked = attempt(failed(POLICY.maxFailedAttempts));

  it('clears the lock and the run of failures behind it', () => {
    const record = attempt(locked.counters);

    record.unlock(T0);

    expect(record.lockedUntil).toBeNull();
    expect(record.lockReason).toBeNull();
    expect(record.counters.userFailures).toBe(0);
    expect(record.isLocked(T0)).toBe(false);
  });

  it('announces it, on the attempt aggregate', () => {
    const record = attempt(locked.counters);
    record.unlock(T0);

    const event = record.domainEvents[0];
    expect(event).toBeInstanceOf(AccountUnlocked);
    expect(event.aggregateType).toBe(LOGIN_ATTEMPT_AGGREGATE);
    expect(payloadFor(record.domainEvents, 'account.unlocked')).toEqual({
      userId: USER_ID,
      reason: 'manual_unlock',
    });
  });

  it('carries the caller\'s reason through', () => {
    const record = attempt(locked.counters);
    record.unlock(T0, 'support_ticket_4821');

    expect(payloadFor(record.domainEvents, 'account.unlocked')).toMatchObject({
      reason: 'support_ticket_4821',
    });
  });

  it('is a no-op on an account that was never locked', () => {
    const record = attempt();

    record.unlock(T0);

    expect(record.domainEvents).toHaveLength(0);
  });

  it('does not announce twice when it is repeated', () => {
    const record = attempt(locked.counters);
    record.unlock(T0);
    record.unlock(T0);

    expect(record.domainEvents).toHaveLength(1);
  });

  it('unlocks an account whose lock has already expired', () => {
    const record = attempt(locked.counters);

    record.unlock(later(POLICY.lockoutSec + 1));

    expect(record.lockedUntil).toBeNull();
    expect(record.domainEvents).toHaveLength(1);
  });

  it('refuses to unlock an account that does not exist', () => {
    const record = attempt(EMPTY_COUNTERS, { userId: null });

    expect(() => record.unlock(T0)).toThrow(/account unlock needs an account/);
  });
});

describe('LoginAttempt — locking by hand', () => {
  it('locks from a clean state', () => {
    const record = attempt();
    record.lock('suspicious_activity', POLICY, T0);

    expect(record.isLocked(T0)).toBe(true);
    expect(record.lockReason).toBe('suspicious_activity');
    expect(record.domainEvents[0]).toBeInstanceOf(AccountLocked);
  });

  it('replaces an existing automatic expiry rather than honouring the shorter one', () => {
    // An agent who locks an account under investigation means "not until I have looked".
    const record = attempt(failed(POLICY.maxFailedAttempts));
    const automatic = record.lockedUntil?.getTime() ?? 0;

    record.lock('investigation', POLICY, later(60));

    // `?? 0` rather than `!` on both sides: a test that reached this line with no lock would
    // otherwise fail on the *second* assertion and say nothing about the first.
    expect(automatic).toBeGreaterThan(0);
    expect(record.lockedUntil?.getTime() ?? 0).toBeGreaterThan(automatic);
  });

  it('clears the counter so the next failure is counted from zero', () => {
    const record = attempt(failed(4));
    record.lock('manual', POLICY, T0);
    record.unlock(T0);

    expect(record.counters.userFailures).toBe(0);
  });

  it('publishes the reason and the expiry', () => {
    const record = attempt();
    record.lock('suspicious_activity', POLICY, T0);

    expect(payloadFor(record.domainEvents, 'account.locked')).toEqual({
      userId: USER_ID,
      reason: 'suspicious_activity',
      failedAttempts: 0,
      lockedUntil: later(POLICY.lockoutSec).toISOString(),
    });
  });
});

describe('LoginAttempt — counting per ip when the user is unknown', () => {
  /**
   * The credential-stuffing case.
   *
   * @remarks An attempt that names an address but no account still moves the ip counter, because
   * that is the only counter available and the attack is real. It must not lock anything: there
   * is no account to lock, and an attacker who could provoke one would hold the
   * denial-of-service lever against every account they guessed a username for.
   */
  it('counts a failure against the ip with no user in sight', () => {
    const record = attempt(EMPTY_COUNTERS, { userId: null });

    record.recordFailure(POLICY, T0);

    expect(record.counters.ipFailures).toBe(1);
    expect(record.counters.userFailures).toBe(0);
    expect(record.isLocked(T0)).toBe(false);
    expect(record.lockedUntil).toBeNull();
  });

  it('keeps counting past the per-user threshold', () => {
    const record = attempt({ userFailures: 0, ipFailures: 999, lockedUntil: null }, { userId: null });

    record.recordFailure(POLICY, T0);

    expect(record.counters.ipFailures).toBe(1_000);
    expect(record.isLocked(T0)).toBe(false);
  });

  it('never locks, however many failures arrive', () => {
    let counters: FailureCounters = EMPTY_COUNTERS;

    for (let index = 0; index < 50; index += 1) {
      const record = attempt(counters, { userId: null });
      record.recordFailure(POLICY, T0);
      counters = record.counters;
    }

    expect(counters.ipFailures).toBe(50);
    expect(counters.lockedUntil).toBeNull();
  });

  it('writes no login_history row, because there is no user to own one', () => {
    const record = attempt(EMPTY_COUNTERS, { userId: null });
    record.recordSuccess(T0);

    expect(record.toRow()).toBeNull();
  });

  it('lets the ip counter drive the lock for a *known* user on the same address', () => {
    const record = attempt({ userFailures: 0, ipFailures: 20, lockedUntil: null });

    record.recordFailure(POLICY, T0);

    expect(record.isLocked(T0)).toBe(true);
    expect(record.lockReason).toBe(`${FAILED_ATTEMPTS_LOCK_REASON}:ip`);
  });

  it('counts the two scopes independently', () => {
    const anonymous = attempt(EMPTY_COUNTERS, { userId: null, ipAddress: IP });
    anonymous.recordFailure(POLICY, T0);

    const named = attempt(EMPTY_COUNTERS, { userId: USER_ID, ipAddress: IP });
    named.recordFailure(POLICY, T0);

    expect(anonymous.counters.ipFailures).toBe(1);
    expect(anonymous.counters.userFailures).toBe(0);
    expect(named.counters.ipFailures).toBe(1);
    expect(named.counters.userFailures).toBe(1);
  });

  it('does not carry one account\'s failures into another\'s', () => {
    const first = attempt(EMPTY_COUNTERS, { userId: USER_ID });
    first.recordFailure(POLICY, T0);

    const second = attempt(EMPTY_COUNTERS, { userId: OTHER_USER });
    second.recordFailure(POLICY, T0);

    expect(second.counters.userFailures).toBe(1);
    expect(second.lockedUntil).toBeNull();
  });
});

describe('LoginAttempt — version and identity', () => {
  it('numbers its events in order, from one', () => {
    const record = fail(POLICY.maxFailedAttempts).last;

    expect(record.domainEvents.map((event) => event.version)).toEqual([1]);
  });

  it('keeps the id it was handed, so a redelivered command reproduces it', () => {
    const id = crypto.randomUUID();
    const record = LoginAttempt.create({
      userId: USER_ID,
      ipAddress: IP,
      fingerprint: FINGERPRINT,
      id,
      now: T0,
    });
    record.recordSuccess(T0);

    expect(record.id).toBe(id);
    expect(record.toRow()?.login_id).toBe(id);
  });

  it('rehydrates a stored row without emitting anything', () => {
    const stored = attempt();
    stored.recordSuccess(T0);
    const row = stored.toRow();
    if (row === null) throw new Error('a successful attempt must produce a row');

    const rehydrated = LoginAttempt.fromRow(row, EMPTY_COUNTERS);

    expect(rehydrated.domainEvents).toHaveLength(0);
    expect(rehydrated.userId).toBe(USER_ID);
    expect(rehydrated.fingerprint.value).toBe(FINGERPRINT.value);
    expect(rehydrated.succeeded).toBe(true);
    expect(rehydrated.occurredAt).toEqual(T0);
  });

  it('has no location when the row carries no coordinates', () => {
    const stored = attempt();
    stored.recordSuccess(T0);
    const row = stored.toRow();
    if (row === null) throw new Error('a successful attempt must produce a row');

    const unplaced: LoginHistoryRow = {
      ...row,
      latitude: null,
      longitude: null,
      country: null,
    };

    expect(LoginAttempt.fromRow(unplaced).location).toBeNull();
  });
});