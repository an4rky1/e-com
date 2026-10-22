/**
 * The read side.
 *
 * @remarks The three questions a caller can ask without changing anything: what devices does this
 * account have, what has it logged in from, and how risky is this login. Built over the in-memory
 * ports, because none of these should need a database to be reasoned about — a read that only
 * works against real rows is a read whose edge cases have never been met.
 */
import {
  AssessRiskHandler,
  AssessRiskQuery,
  GetLoginHistoryHandler,
  GetLoginHistoryQuery,
  ListDevicesHandler,
  ListDevicesQuery,
} from '../src/application/queries/account-security.queries';
import { RiskScoringService } from '../src/domain/services/risk-scoring.service';
import { DeviceFingerprint } from '../src/domain/value-objects/device-fingerprint.vo';
import { RiskLevel } from '../src/domain/value-objects/risk-score.vo';
import type { LoginAttemptInput } from '../src/application/commands/login-attempt.commands';
import {
  InMemoryDeviceRegistry,
  InMemoryFailureTracker,
  InMemorySecurityRepository,
  testConfig,
} from './testing/fakes';

const USER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const IP = '203.0.113.9';
const LAPTOP = DeviceFingerprint.compute({ platform: 'macOS' }).value;
const PHONE = DeviceFingerprint.compute({ platform: 'iOS' }).value;

const LONDON = { country: 'GB', latitude: 51.5074, longitude: -0.1278 };
const PARIS = { country: 'FR', latitude: 48.8566, longitude: 2.3522 };

const CONTEXT = () => {
  const repository = new InMemorySecurityRepository();
  const registry = new InMemoryDeviceRegistry();
  const tracker = new InMemoryFailureTracker();
  const config = testConfig();

  const scoring = new RiskScoringService(config.riskScoring);

  return {
    repository,
    registry,
    tracker,
    config,
    devices: new ListDevicesHandler(repository, registry),
    history: new GetLoginHistoryHandler(repository, config),
    risk: new AssessRiskHandler(repository, registry, tracker, scoring, config),
  };
};

const day = (n: number): Date => new Date(Date.now() - n * 86_400_000);

describe('ListDevicesQuery', () => {
  it('is empty for an account that has never signed in', async () => {
    const { devices } = CONTEXT();

    await expect(devices.execute(new ListDevicesQuery(USER_ID))).resolves.toEqual([]);
  });

  it('lists one row per fingerprint, newest first', async () => {
    const { repository, devices } = CONTEXT();
    repository.seedLogin({ userId: USER_ID, fingerprint: LAPTOP, occurredAt: day(2), ...LONDON });
    repository.seedLogin({ userId: USER_ID, fingerprint: PHONE, occurredAt: day(1), ...LONDON });

    const listed = await devices.execute(new ListDevicesQuery(USER_ID));

    expect(listed.map((device) => device.id)).toEqual([PHONE, LAPTOP]);
  });

  it('counts the logins behind each device', async () => {
    const { repository, devices } = CONTEXT();
    repository.seedLogin({ userId: USER_ID, fingerprint: LAPTOP, occurredAt: day(3), ...LONDON });
    repository.seedLogin({ userId: USER_ID, fingerprint: LAPTOP, occurredAt: day(2), ...LONDON });
    repository.seedLogin({ userId: USER_ID, fingerprint: PHONE, occurredAt: day(1), ...LONDON });

    const listed = await devices.execute(new ListDevicesQuery(USER_ID));

    expect(listed.find((device) => device.id === LAPTOP)?.loginCount).toBe(2);
  });

  it('keeps a revoked device in the list, marked untrusted', async () => {
    // A user who retires a laptop still wants to see that it is *still trying*. A list that
    // silently loses rows is a list they stop trusting.
    const { repository, registry, devices } = CONTEXT();
    repository.seedLogin({ userId: USER_ID, fingerprint: LAPTOP, occurredAt: day(1), ...LONDON });
    await registry.revoke(USER_ID, LAPTOP);

    const listed = await devices.execute(new ListDevicesQuery(USER_ID));

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: LAPTOP, trusted: false });
  });

  it('never leaks a session id or a coordinate it does not have to', async () => {
    const { repository, devices } = CONTEXT();
    const seenAt = day(1);
    repository.seedLogin({ userId: USER_ID, fingerprint: LAPTOP, occurredAt: seenAt, ...LONDON });

    const [device] = await devices.execute(new ListDevicesQuery(USER_ID));

    expect(device.ipAddress).toBeNull();
    expect(device.country).toBe('GB');
    expect(device.lastSeenAt).toBe(seenAt.toISOString());
  });

  it('shows a device whose attributes were never recorded as unknown', async () => {
    const { repository, devices } = CONTEXT();
    repository.seedLogin({ userId: USER_ID, fingerprint: LAPTOP, occurredAt: day(1) });

    const [device] = await devices.execute(new ListDevicesQuery(USER_ID));

    expect(device).toMatchObject({ name: 'Unknown device', platform: 'unknown', country: null });
  });
});

describe('GetLoginHistoryQuery', () => {
  it('is empty for an account that has never signed in', async () => {
    const { history, config } = CONTEXT();

    await expect(history.execute(new GetLoginHistoryQuery(USER_ID))).resolves.toEqual({
      entries: [],
      limit: config.loginHistoryPageSize,
    });
  });

  it('returns the logins newest first', async () => {
    const { repository, history } = CONTEXT();
    repository.seedLogin({ userId: USER_ID, fingerprint: LAPTOP, occurredAt: day(3), ...LONDON });
    repository.seedLogin({ userId: USER_ID, fingerprint: PHONE, occurredAt: day(1), ...LONDON });

    const page = await history.execute(new GetLoginHistoryQuery(USER_ID));

    expect(page.entries.map((entry) => entry.fingerprint)).toEqual([PHONE, LAPTOP]);
  });

  it('carries the coordinates through as plain numbers', async () => {
    const { repository, history } = CONTEXT();
    repository.seedLogin({ userId: USER_ID, fingerprint: LAPTOP, occurredAt: day(1), ...LONDON });

    const page = await history.execute(new GetLoginHistoryQuery(USER_ID));

    expect(page.entries[0]).toMatchObject({
      country: 'GB',
      latitude: 51.5074,
      longitude: -0.1278,
      sessionId: null,
    });
  });

  it('reports null coordinates rather than zeroes for a login we could not place', async () => {
    const { repository, history } = CONTEXT();
    repository.seedLogin({ userId: USER_ID, fingerprint: LAPTOP, occurredAt: day(1) });

    const page = await history.execute(new GetLoginHistoryQuery(USER_ID));

    expect(page.entries[0]).toMatchObject({ country: null, latitude: null, longitude: null });
  });

  it('clamps a caller-supplied limit instead of trusting it', async () => {
    // The caller is an untrusted gRPC peer, and `take: 100000` against a growing table is a
    // cheap way to take this service down.
    const { history, config } = CONTEXT();

    const page = await history.execute(new GetLoginHistoryQuery(USER_ID, 1_000_000));

    expect(page.limit).toBe(config.maxLoginHistoryPageSize);
  });

  it('refuses a limit of zero or less', async () => {
    const { history } = CONTEXT();

    await expect(history.execute(new GetLoginHistoryQuery(USER_ID, 0))).resolves.toMatchObject({
      limit: 1,
    });
  });

  it('honours a limit inside the bounds', async () => {
    const { history } = CONTEXT();

    await expect(history.execute(new GetLoginHistoryQuery(USER_ID, 5))).resolves.toMatchObject({
      limit: 5,
    });
  });
});

describe('AssessRiskQuery', () => {
  const query = (input: LoginAttemptInput): AssessRiskQuery => new AssessRiskQuery(input);

  it('scores a known, unremarkable login as low', async () => {
    const { repository, registry, risk } = CONTEXT();
    repository.seedLogin({ userId: USER_ID, fingerprint: LAPTOP, occurredAt: day(1), ...LONDON });
    registry.markKnown(USER_ID, LAPTOP);

    const assessment = await risk.execute(
      query({ userId: USER_ID, ipAddress: IP, deviceFingerprint: LAPTOP, ...LONDON }),
    );

    expect(assessment).toMatchObject({ score: 0, level: RiskLevel.LOW });
    expect(assessment.recommendations).toEqual(['allow']);
  });

  it('flags a device the account has never used', async () => {
    const { risk } = CONTEXT();

    const assessment = await risk.execute(
      query({ userId: USER_ID, ipAddress: IP, deviceFingerprint: PHONE, ...LONDON }),
    );

    expect(assessment.factors).toEqual(['new_device']);
    expect(assessment.level).toBe(RiskLevel.MEDIUM);
  });

  it('flags a hop between countries, without firing the travel rule for 344 km', async () => {
    const { repository, registry, risk } = CONTEXT();
    // Seeded on the *other* fingerprint: the previous login has to be somewhere else, because
    // the adapter deliberately excludes the device being assessed from the comparison.
    repository.seedLogin({ userId: USER_ID, fingerprint: PHONE, occurredAt: day(1), ...LONDON });
    registry.markKnown(USER_ID, LAPTOP);

    const assessment = await risk.execute(
      query({ userId: USER_ID, ipAddress: IP, deviceFingerprint: LAPTOP, ...PARIS }),
    );

    expect(assessment.factors).toEqual(['new_country']);
    expect(assessment.score).toBe(15);
  });

  it('reads the counters it scored against', async () => {
    const { risk, registry, tracker } = CONTEXT();
    registry.markKnown(USER_ID, LAPTOP);
    tracker.seedUser(USER_ID, { userFailures: 3 });

    const assessment = await risk.execute(
      query({ userId: USER_ID, ipAddress: IP, deviceFingerprint: LAPTOP }),
    );

    expect(assessment.factors).toEqual(['rapid_failed_attempts']);
  });

  it('computes the fingerprint itself when the caller sent none', async () => {
    const { risk } = CONTEXT();
    const computed = DeviceFingerprint.compute({ platform: 'iOS' }).value;

    const assessment = await risk.execute(
      query({ userId: USER_ID, ipAddress: IP, device: { platform: 'iOS' } }),
    );

    // A device nobody has seen scores `new_device`, which is what "the gateway sent no
    // fingerprint" has to mean; silently treating it as known would score every client that
    // omits the header as safe.
    expect(assessment.factors).toEqual(['new_device']);
    expect(computed).toHaveLength(64);
  });

  it('records nothing: a pre-flight is not an attempt', async () => {
    const { repository, tracker, risk } = CONTEXT();

    await risk.execute(query({ userId: USER_ID, ipAddress: IP, deviceFingerprint: PHONE }));

    expect(repository.writes).toEqual([]);
    expect(repository.signals).toEqual([]);
    expect(tracker.users.size).toBe(0);
    expect(tracker.ips.size).toBe(0);
  });

  it('scores an unidentified attempt without a user rather than refusing', async () => {
    // The credential-stuffing case: an address, no account. It still has to be scoreable, and
    // it must not be treated as a new device belonging to nobody.
    const { risk } = CONTEXT();

    const assessment = await risk.execute(
      query({ ipAddress: IP, deviceFingerprint: PHONE, ...LONDON }),
    );

    expect(assessment.factors).toEqual([]);
    expect(assessment.level).toBe(RiskLevel.LOW);
  });

  it('returns only the four fields the proto carries', async () => {
    const { risk } = CONTEXT();

    const assessment = await risk.execute(
      query({ userId: USER_ID, ipAddress: IP, deviceFingerprint: PHONE }),
    );

    expect(Object.keys(assessment).sort()).toEqual([
      'factors',
      'level',
      'recommendations',
      'score',
    ]);
  });
});
