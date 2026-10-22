/**
 * The command handlers, and the wiring around them.
 *
 * @remarks Built over the in-memory ports, with no container: the handlers are classes with
 * constructor dependencies, so `new` *is* the wiring. What these tests pin is the behaviour that
 * lives outside the aggregate — what gets persisted, in how many transactions, what is written
 * to the counters, and what leaves the service on the wire.
 */
import { ValidationException } from '@auth/platform/error-handling';
import {
  LockAccountHandler,
  RecordLoginAttemptHandler,
  RevokeDeviceHandler,
  UnlockAccountHandler,
} from '../src/application/commands/login-attempt.handlers';
import {
  LockAccountCommand,
  RecordLoginAttemptCommand,
  RevokeDeviceCommand,
  UnlockAccountCommand,
} from '../src/application/commands/login-attempt.commands';
import { RiskScoringService } from '../src/domain/services/risk-scoring.service';
import { DeviceFingerprint } from '../src/domain/value-objects/device-fingerprint.vo';
import { RiskLevel, RiskScore } from '../src/domain/value-objects/risk-score.vo';
import { SecuritySignalType } from '../src/domain/value-objects/security-signal-type.vo';
import { EMPTY_COUNTERS } from '../src/domain/value-objects/failure-counters.vo';
import {
  InMemoryDeviceRegistry,
  InMemoryFailureTracker,
  InMemorySecurityRepository,
  testConfig,
} from './testing/fakes';
import { payloadFor, rejection } from './testing/helpers';

const USER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const IP = '203.0.113.9';
const FINGERPRINT = DeviceFingerprint.compute({ platform: 'linux', userAgent: 'curl/8' }).value;
const OTHER_FINGERPRINT = DeviceFingerprint.compute({ platform: 'macos' }).value;

/** London, and Sydney. Enough to make a login impossible to travel to. */
const LONDON = { country: 'GB', latitude: 51.5074, longitude: -0.1278 };
const SYDNEY = { country: 'AU', latitude: -33.8688, longitude: 151.2093 };

/**
 * A wired-up set of handlers over in-memory ports.
 *
 * @remarks `overrides.repository` exists so a scenario can hand in a repository that already
 * holds history. Everything about "did it notice the travel" depends on there being a previous
 * login to compare against, and building that fixture inline in five tests is how four of them
 * end up asserting `low` for a Sydney login and calling it a pass.
 */
const CONTEXT = (overrides: { repository?: InMemorySecurityRepository } = {}) => {
  const repository = overrides.repository ?? new InMemorySecurityRepository();
  const registry = new InMemoryDeviceRegistry();
  const tracker = new InMemoryFailureTracker();
  const config = testConfig();

  return {
    repository,
    registry,
    tracker,
    config,
    record: new RecordLoginAttemptHandler(
      repository,
      registry,
      tracker,
      new RiskScoringService(config.riskScoring),
      config,
    ),
    lock: new LockAccountHandler(repository, tracker, config),
    unlock: new UnlockAccountHandler(repository, tracker),
    revoke: new RevokeDeviceHandler(repository, registry),
  };
};

/**
 * Gives the account a London login so there is somewhere for a later one to have been.
 *
 * @remarks Every "did it notice the travel" scenario needs a *previous* location: with no
 * history the scorer deliberately sees nothing to compare against, so a Sydney login scores
 * `low` and the test would be asserting the wrong thing entirely.
 */
const withLondonHistory = (): { repository: InMemorySecurityRepository } => {
  const repository = new InMemorySecurityRepository();

  // Stamped at the hour the test is running rather than at a fixed one. The handler reads the
  // real clock, and a fixture at 09:00 would make the "unusual hour" factor fire in every
  // scenario that meant to isolate the travel one — a flaky-looking failure that is really the
  // fixture being wrong.
  const occurredAt = new Date(Date.now() - 86_400_000);

  repository.seedLogin({
    userId: USER_ID,
    // Deliberately *not* the fingerprint under test. `lastSeenElsewhere` excludes the device
    // being assessed — comparing a login against the previous login from the same laptop would
    // produce a travel distance of zero every time and the factor would never fire for the
    // device a user actually travels with.
    fingerprint: OTHER_FINGERPRINT,
    occurredAt,
    country: 'GB',
    latitude: 51.5074,
    longitude: -0.1278,
  });
  return { repository };
};

const attempt = (
  succeeded: boolean,
  overrides: Partial<ConstructorParameters<typeof RecordLoginAttemptCommand>[1]> = {},
): RecordLoginAttemptCommand =>
  new RecordLoginAttemptCommand(succeeded, {
    userId: USER_ID,
    ipAddress: IP,
    deviceFingerprint: FINGERPRINT,
    sessionId: null,
    ...LONDON,
    ...overrides,
  });

describe('RecordLoginAttemptCommand — validation', () => {
  it('counts an attempt that carries only an address', async () => {
    // The caller may have resolved nothing at all: an address guessed at for the first time
    // has no account behind it, and that is precisely the traffic the per-address limit is
    // there to count. Refusing it would leave the limit blind to credential stuffing.
    const { record, tracker } = CONTEXT();

    await record.execute(attempt(false, { userId: null, email: null }));

    expect(await tracker.load({ ipAddress: IP })).toMatchObject({ ipFailures: 1 });
  });

  it('accepts an attempt identified only by an email', async () => {
    // The gateway resolves an address to an id before calling, but an unresolved one is exactly
    // the credential-stuffing traffic this service exists to count.
    const { record, tracker } = CONTEXT();

    await record.execute(attempt(true, { userId: null, email: 'someone@example.com' }));

    expect(await tracker.load({ ipAddress: IP })).toMatchObject({ ipFailures: 0 });
  });

  it('refuses an attempt with no address to count it against', async () => {
    const { record } = CONTEXT();

    const error = await rejection(record.execute(attempt(true, { ipAddress: null })));

    expect(error).toBeInstanceOf(ValidationException);
  });

  it('trims an address that arrived padded', async () => {
    const { record } = CONTEXT();

    const outcome = await record.execute(attempt(true, { ipAddress: `  ${IP}  ` }));

    expect(outcome.succeeded).toBe(true);
  });
});

describe('RecordLoginAttemptCommand — a successful login', () => {
  it('writes the login row and no signals for a known device at a known hour', async () => {
    const { record, repository, registry } = CONTEXT();
    registry.markKnown(USER_ID, FINGERPRINT);

    const outcome = await record.execute(attempt(true));

    expect(repository.writes).toHaveLength(1);
    expect(repository.writes[0].row?.user_id).toBe(USER_ID);
    expect(outcome.loginId).toBe(repository.writes[0].row?.login_id);
    expect(repository.signals).toEqual([]);
    expect(outcome.riskScore).toBe(0);
    expect(outcome.riskLevel).toBe(RiskLevel.LOW);
  });

  it('answers with the login row id when nothing was wrong with the login', async () => {
    // `security_event_id` is always populated, but a clean sign-in has no signal to point at.
    const { record, registry } = CONTEXT();
    registry.markKnown(USER_ID, FINGERPRINT);

    const outcome = await record.execute(attempt(true));

    expect(outcome.signalIds).toEqual([]);
    expect(outcome.securityEventId).toBe(outcome.loginId);
  });

  it('raises new_device_detected the first time a fingerprint is seen', async () => {
    const { record, repository } = CONTEXT();

    const outcome = await record.execute(attempt(true));

    expect(repository.signals.map((signal) => signal.signal_type)).toEqual([
      SecuritySignalType.NEW_DEVICE_DETECTED,
    ]);
    expect(outcome.securityEventId).toBe(outcome.signalIds[0]);
  });

  it('remembers the device only after the login is durable', async () => {
    // Remembering first would suppress `new_device_detected` for the real owner if the write
    // then failed — the device would be "known" from a login that never happened.
    const { record, registry, repository } = CONTEXT();

    await record.execute(attempt(true));

    await expect(registry.isKnown(USER_ID, FINGERPRINT)).resolves.toBe(true);
    expect(repository.writes).toHaveLength(1);
  });

  it('does not remember a device from a *failed* login', async () => {
    const { record, registry } = CONTEXT();

    await record.execute(attempt(false));

    await expect(registry.isKnown(USER_ID, FINGERPRINT)).resolves.toBe(false);
  });

  it('writes the row and the signal in a single transaction', async () => {
    const { record, repository } = CONTEXT();

    await record.execute(attempt(true));

    const [write] = repository.writes;
    expect(write.row).not.toBeNull();
    expect(write.signals).toHaveLength(1);
    expect(write.attempt?.domainEvents).toEqual([]);
  });

  it('resets the consecutive-failure counter', async () => {
    const { record, tracker } = CONTEXT();
    tracker.seedUser(USER_ID, { userFailures: 4, ipFailures: 4 });

    const outcome = await record.execute(attempt(true));

    expect(outcome.failedAttempts).toBe(0);
    expect(tracker.countersFor(USER_ID).userFailures).toBe(0);
  });

  it('stays silent at `medium`, and leaves the decision to the recommendation', async () => {
    // Sydney from London is travel (30) + a new country (15) = 45. A second factor, not a
    // stored signal: `medium` is a thing the caller acts on, not a thing a human reads later.
    const { repository } = withLondonHistory();
    const { record, registry } = CONTEXT({ repository });
    registry.markKnown(USER_ID, FINGERPRINT);

    const outcome = await record.execute(attempt(true, { ...SYDNEY }));

    expect(outcome.riskScore).toBe(45);
    expect(outcome.riskLevel).toBe(RiskLevel.MEDIUM);
    expect(repository.signals).toEqual([]);
  });

  it('raises suspicious_login_detected at `high` and above', async () => {
    const { repository } = withLondonHistory();
    const { record, registry, tracker } = CONTEXT({ repository });
    registry.markKnown(USER_ID, FINGERPRINT);
    tracker.seedUser(USER_ID, { userFailures: 3 });

    // travel (30) + new country (15) + a run of failures (35) = 80.
    const outcome = await record.execute(attempt(true, { ...SYDNEY }));

    expect(outcome.riskLevel).toBe(RiskLevel.CRITICAL);
    expect(repository.signals.map((signal) => signal.signal_type)).toContain(
      SecuritySignalType.SUSPICIOUS_LOGIN_DETECTED,
    );
  });
});

describe('RecordLoginAttemptCommand — a failed login', () => {
  it('writes a signal and no login row', async () => {
    const { record, repository } = CONTEXT();

    const outcome = await record.execute(attempt(false));

    expect(repository.writes[0].row).toBeNull();
    expect(outcome.loginId).toBeNull();
    expect(repository.signals).toHaveLength(1);
    expect(repository.signals[0].signal_type).toBe(SecuritySignalType.ANOMALY_DETECTED);
  });

  it('increments both counters and reports them', async () => {
    const { record, tracker } = CONTEXT();

    const outcome = await record.execute(attempt(false));

    expect(outcome.failedAttempts).toBe(1);
    expect(outcome.ipFailedAttempts).toBe(1);
    expect(tracker.countersFor(USER_ID)).toMatchObject({ userFailures: 1, ipFailures: 1 });
  });

  it('locks at exactly the configured threshold and reports the expiry', async () => {
    const { record, tracker, config } = CONTEXT();
    tracker.seedUser(USER_ID, {
      userFailures: config.maxFailedAttempts - 1,
      ipFailures: config.maxFailedAttempts - 1,
    });

    const outcome = await record.execute(attempt(false));

    expect(outcome.failedAttempts).toBe(config.maxFailedAttempts);
    expect(outcome.locked).toBe(true);
    expect(outcome.lockedUntil).not.toBeNull();
    expect(outcome.retryAfterSeconds).toBe(config.lockoutSec);
  });

  it('does not lock one attempt early', async () => {
    const { record, tracker, config } = CONTEXT();
    tracker.seedUser(USER_ID, {
      userFailures: config.maxFailedAttempts - 2,
      ipFailures: config.maxFailedAttempts - 2,
    });

    const outcome = await record.execute(attempt(false));

    expect(outcome.locked).toBe(false);
    expect(outcome.lockedUntil).toBeNull();
  });

  it('carries the counter and the lock into the signal\'s details', async () => {
    const { record, repository, tracker, config } = CONTEXT();
    tracker.seedUser(USER_ID, { userFailures: config.maxFailedAttempts, ipFailures: 3 });

    await record.execute(attempt(false));

    expect(repository.signals[0].details).toMatchObject({
      outcome: 'failed',
      failedAttempts: config.maxFailedAttempts + 1,
      ipFailedAttempts: 4,
      locked: true,
    });
  });

  it('counts per ip and locks nothing when the user is unknown', async () => {
    const { record, tracker, repository } = CONTEXT();

    // An address and no account: the only shape in which "we do not know who this is" arrives.
    const outcome = await record.execute(
      attempt(false, { userId: null, email: 'victim@example.com' }),
    );

    expect(outcome.locked).toBe(false);
    expect(outcome.failedAttempts).toBe(0);
    expect(outcome.ipFailedAttempts).toBe(1);
    expect(repository.writes).toEqual([]);
    expect(repository.signals).toEqual([]);
    expect((await tracker.load({ ipAddress: IP })).ipFailures).toBe(1);
  });
});

describe('LockAccountCommand', () => {
  it('locks and reports when the lock lifts', async () => {
    const { lock, config } = CONTEXT();
    const before = Date.now();

    const result = await lock.execute(new LockAccountCommand(USER_ID, 'support_ticket_4821'));

    expect(result.reason).toBe('support_ticket_4821');
    const deltaSec = (result.lockedUntil.getTime() - before) / 1000;
    expect(deltaSec).toBeGreaterThanOrEqual(config.lockoutSec);
    expect(deltaSec).toBeLessThanOrEqual(config.lockoutSec + 5);
  });

  it('stores the lock so the next attempt sees it', async () => {
    const { lock, tracker } = CONTEXT();

    await lock.execute(new LockAccountCommand(USER_ID, 'manual'));

    expect((await tracker.load({ userId: USER_ID })).lockedUntil).not.toBeNull();
  });

  it('writes exactly one anomaly signal with the lock in it', async () => {
    const { lock, repository } = CONTEXT();

    await lock.execute(new LockAccountCommand(USER_ID, 'manual'));

    expect(repository.writes).toHaveLength(1);
    expect(repository.signals).toHaveLength(1);
    expect(repository.signals[0]).toMatchObject({
      signal_type: SecuritySignalType.ANOMALY_DETECTED,
      risk_score: RiskScore.create(100).value,
    });
    expect(repository.signals[0].details).toMatchObject({ action: 'account_locked', reason: 'manual' });
  });

  it('writes the signal and the announcement in one transaction', async () => {
    const { lock, repository } = CONTEXT();

    await lock.execute(new LockAccountCommand(USER_ID, 'manual'));

    const [write] = repository.writes;
    expect(write.signals).toHaveLength(1);
    // `saveSignals` rather than `saveAttempt`: there is no login here, and pretending there is
    // one would mean writing a `login_history` row for an account that never signed in.
    expect(write.attempt).toBeNull();
  });
});

describe('UnlockAccountCommand', () => {
  it('clears the lock and both counters', async () => {
    const { lock, unlock, tracker } = CONTEXT();
    await lock.execute(new LockAccountCommand(USER_ID, 'manual'));

    tracker.seedUser(USER_ID, { userFailures: 9, ipFailures: 9 });
    const result = await unlock.execute(new UnlockAccountCommand(USER_ID, 'resolved'));

    expect(result.unlocked).toBe(true);
    expect(tracker.countersFor(USER_ID)).toEqual(EMPTY_COUNTERS);
  });

  it('clears the ip counter too, so the next typo does not re-lock', async () => {
    const { lock, unlock, tracker } = CONTEXT();
    await lock.execute(new LockAccountCommand(USER_ID, 'manual', IP));

    tracker.seedIp(IP, { userFailures: 0, ipFailures: 19 });
    await unlock.execute(new UnlockAccountCommand(USER_ID, 'resolved', IP));

    expect(tracker.ips.size).toBe(0);
    expect(tracker.countersFor(USER_ID)).toEqual(EMPTY_COUNTERS);
  });

  it('clears only the user counter when the caller named no address', async () => {
    // There is no address to clear, and inventing one — say, the operator's own — would clear a
    // counter that has nothing to do with the account being unlocked.
    const { unlock, tracker } = CONTEXT();
    tracker.seedUser(USER_ID, { userFailures: 4 });
    tracker.seedIp(IP, { userFailures: 0, ipFailures: 19 });

    await unlock.execute(new UnlockAccountCommand(USER_ID, 'resolved'));

    expect(tracker.countersFor(USER_ID)).toEqual(EMPTY_COUNTERS);
    expect(tracker.ips.get(IP)?.ipFailures).toBe(19);
  });

  it('is idempotent, and says what it found', async () => {
    const { unlock, repository } = CONTEXT();

    const result = await unlock.execute(new UnlockAccountCommand(USER_ID, 'no lock to clear'));

    expect(result.unlocked).toBe(true);
    expect(repository.signals[0].details).toMatchObject({
      action: 'account_unlocked',
      wasLocked: false,
    });
  });

  it('writes exactly one signal', async () => {
    const { unlock, repository } = CONTEXT();

    await unlock.execute(new UnlockAccountCommand(USER_ID));

    expect(repository.writes).toHaveLength(1);
    expect(repository.signals).toHaveLength(1);
  });
});

describe('RevokeDeviceCommand', () => {
  const seeded = async () => {
    const context = CONTEXT();
    await context.record.execute(attempt(true));
    return context;
  };

  it('refuses a fingerprint this account has never used', async () => {
    const { revoke } = CONTEXT();

    await expect(
      revoke.execute(new RevokeDeviceCommand(USER_ID, OTHER_FINGERPRINT)),
    ).rejects.toThrow(/no such device/);
  });

  it('retires a device and says so', async () => {
    const { revoke, registry } = await seeded();

    const result = await revoke.execute(new RevokeDeviceCommand(USER_ID, FINGERPRINT));

    expect(result.ok).toBe(true);
    await expect(registry.isRevoked(USER_ID, FINGERPRINT)).resolves.toBe(true);
  });

  it('raises a signal, because a retraction nobody saw is not a retraction', async () => {
    const { revoke, repository } = await seeded();

    const result = await revoke.execute(new RevokeDeviceCommand(USER_ID, FINGERPRINT));

    const revocation = repository.signals.find(
      (signal) => signal.details.action === 'device_revoked',
    );
    expect(result.signalId).toBe(revocation?.signal_id);
    expect(revocation?.details).toMatchObject({
      action: 'device_revoked',
      deviceFingerprint: FINGERPRINT,
    });
  });

  it('deletes nothing — the history is the evidence', async () => {
    const { revoke, repository } = await seeded();

    await revoke.execute(new RevokeDeviceCommand(USER_ID, FINGERPRINT));

    expect(repository.history).toHaveLength(1);
    expect(repository.devices.size).toBe(1);
  });

  it('makes the next login from that device read as new', async () => {
    const { revoke, record, registry } = await seeded();
    await revoke.execute(new RevokeDeviceCommand(USER_ID, FINGERPRINT));

    // The registry still *knows* the fingerprint; it has stopped trusting it.
    await expect(registry.isKnown(USER_ID, FINGERPRINT)).resolves.toBe(true);
    await expect(registry.isRevoked(USER_ID, FINGERPRINT)).resolves.toBe(true);

    const outcome = await record.execute(attempt(true, { deviceFingerprint: OTHER_FINGERPRINT }));
    expect(outcome.signalIds).toHaveLength(1);
  });
});

describe('RecordLoginAttemptCommand — what leaves the service', () => {
  it('reports the score, its band and the factors behind it', async () => {
    const { repository } = withLondonHistory();
    const { record, registry } = CONTEXT({ repository });
    registry.markKnown(USER_ID, FINGERPRINT);

    const outcome = await record.execute(attempt(true, { ...SYDNEY }));

    expect(outcome.riskFactors).toEqual(['unusual_location', 'new_country']);
    expect(outcome.riskScore).toBe(45);
    expect(outcome.riskLevel).toBe(RiskLevel.MEDIUM);
  });

  it('writes where the account was before into the new-device signal', async () => {
    const { repository } = withLondonHistory();
    const { record } = CONTEXT({ repository });

    await record.execute(attempt(true, { ...SYDNEY }));

    expect(repository.signals[0].details).toMatchObject({
      country: 'AU',
      previousCountry: 'GB',
      firstSeenAt: expect.any(String),
    });
  });

  it('stores the travelled distance on the suspicious-login signal', async () => {
    const { repository } = withLondonHistory();
    const { record, tracker } = CONTEXT({ repository });
    tracker.seedUser(USER_ID, { userFailures: 3 });

    await record.execute(attempt(true, { ...SYDNEY }));

    const suspicious = repository.signals.find(
      (signal) => signal.signal_type === SecuritySignalType.SUSPICIOUS_LOGIN_DETECTED,
    );
    // 16,994 km: the number a human reads first when triaging an impossible-travel signal,
    // so it is stored rather than left to be recomputed from two other tables.
    expect(suspicious?.details).toMatchObject({ distanceKm: 16_994, riskLevel: RiskLevel.CRITICAL });
  });

  it('keeps the raw device signals on the one row that records them', async () => {
    const { record, repository } = CONTEXT();

    await record.execute(
      attempt(true, { deviceFingerprint: null, device: { platform: 'iOS', timezone: 'Europe/London' } }),
    );

    expect(repository.signals[0].details).toMatchObject({
      platform: 'iOS',
      timezone: 'Europe/London',
    });
  });

  it('carries the buffered account events into the same write', async () => {
    const { record, repository, tracker, config } = CONTEXT();
    tracker.seedUser(USER_ID, { userFailures: config.maxFailedAttempts - 1, ipFailures: 0 });

    await record.execute(attempt(false));

    const [write] = repository.writes;
    const events = write.attempt?.domainEvents ?? [];
    expect(events.map((event) => event.eventType)).toEqual(['account.locked']);
    expect(payloadFor(events, 'account.locked')).toMatchObject({
      userId: USER_ID,
      reason: 'failed_attempts:user',
    });
  });
});