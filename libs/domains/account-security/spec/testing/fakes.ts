/**
 * @fileoverview In-memory stand-ins for the two ports the application layer talks to.
 *
 * @remarks No Nest container, no database and no Redis: the handlers are plain constructors, so
 * a test can build one over these and assert on what was recorded. Everything here is the
 * *shape* of the port rather than a mock framework's idea of it — a method the real adapter
 * implements differently is a method this fake has to be wrong about, and that is the point.
 */
import type {
  DeviceRegistryPort,
  DeviceUsage,
  LoginHistoryEntry,
  SecurityRepositoryPort,
} from '../../src/domain/ports/security-repository.port';
import type { FailureTrackerPort } from '../../src/domain/ports/failure-tracker.port';
import type { LoginAttempt } from '../../src/domain/login-attempt.aggregate';
import type {
  SecuritySignal,
  SecuritySignalRow,
} from '../../src/domain/security-signal.aggregate';
import {
  EMPTY_COUNTERS,
  normaliseScope,
  type FailureCounters,
  type FailureScope,
} from '../../src/domain/value-objects/failure-counters.vo';
import { GeoLocation } from '../../src/domain/value-objects/geo-location.vo';
import type { AccountSecurityConfig } from '../../src/account-security.config';
import { resolveAccountSecurityConfig } from '../../src/account-security.config';

/**
 * The rate store, in memory.
 *
 * @remarks Keyed the way the Redis adapter keys — a missing id is a missing key, not a key that
 * happens to be empty — so a test that passes a scope production would treat as "no user" gets
 * the same behaviour here. A fake that quietly invented a key for an empty id would pass a test
 * the real adapter fails.
 */
export class InMemoryFailureTracker implements FailureTrackerPort {
  readonly users = new Map<string, FailureCounters>();
  readonly ips = new Map<string, FailureCounters>();

  async load(scope: FailureScope): Promise<FailureCounters> {
    const { userId, ipAddress } = normaliseScope(scope);
    const user = userId === null ? undefined : this.users.get(userId);
    const ip = ipAddress === null ? undefined : this.ips.get(ipAddress);

    return {
      userFailures: Math.max(user?.userFailures ?? 0, ip?.userFailures ?? 0),
      ipFailures: Math.max(user?.ipFailures ?? 0, ip?.ipFailures ?? 0),
      lockedUntil: user?.lockedUntil ?? ip?.lockedUntil ?? null,
    };
  }

  async save(scope: FailureScope, counters: FailureCounters): Promise<void> {
    const { userId, ipAddress } = normaliseScope(scope);
    if (userId !== null) this.users.set(userId, { ...counters });
    if (ipAddress !== null) this.ips.set(ipAddress, { ...counters });
  }

  async clear(scope: FailureScope): Promise<void> {
    const { userId, ipAddress } = normaliseScope(scope);
    if (userId !== null) this.users.delete(userId);
    if (ipAddress !== null) this.ips.delete(ipAddress);
  }

  /** Seeds a user counter, for the "start from four" scenarios. */
  seedUser(userId: string, counters: Partial<FailureCounters> = {}): void {
    this.users.set(userId, { ...EMPTY_COUNTERS, ...counters });
  }

  /** Seeds an ip counter, independently of any user. */
  seedIp(ipAddress: string, counters: Partial<FailureCounters> = {}): void {
    this.ips.set(ipAddress, { ...EMPTY_COUNTERS, ...counters });
  }

  /** What a user-scoped read currently sees. */
  countersFor(userId: string): FailureCounters {
    return this.users.get(userId) ?? { ...EMPTY_COUNTERS };
  }
}

/** The device registry, in memory. */
export class InMemoryDeviceRegistry implements DeviceRegistryPort {
  readonly known = new Set<string>();
  readonly revoked = new Set<string>();

  async isKnown(userId: string, fingerprint: string): Promise<boolean> {
    return userId === '' || this.known.has(`${userId}:${fingerprint}`);
  }

  async isRevoked(userId: string, fingerprint: string): Promise<boolean> {
    return this.revoked.has(`${userId}:${fingerprint}`);
  }

  async remember(userId: string, fingerprint: string): Promise<void> {
    this.known.add(`${userId}:${fingerprint}`);
  }

  async revoke(userId: string, fingerprint: string): Promise<void> {
    this.revoked.add(`${userId}:${fingerprint}`);
  }

  markKnown(userId: string, fingerprint: string): void {
    this.known.add(`${userId}:${fingerprint}`);
  }
}

/** One write, kept whole: the rows and the events that were buffered beside them. */
export interface RecordedWrite {
  readonly attempt: LoginAttempt | null;
  readonly row: ReturnType<LoginAttempt['toRow']>;
  readonly signals: readonly SecuritySignal[];
}

interface HistoryRow {
  readonly userId: string;
  readonly entry: LoginHistoryEntry;
}

/**
 * The repository, in memory.
 *
 * @remarks `writes` is an append-only list rather than a map so a test can assert on the
 * *granularity* of a transaction: "one `saveAttempt` call carried the row, the signals and their
 * events" is the transactional-outbox guarantee, and a snapshot of rows cannot show it.
 */
export class InMemorySecurityRepository implements SecurityRepositoryPort {
  readonly writes: RecordedWrite[] = [];
  readonly signals: SecuritySignalRow[] = [];
  readonly devices = new Map<string, DeviceUsage>();
  readonly history: HistoryRow[] = [];

  async saveAttempt(attempt: LoginAttempt, signals: readonly SecuritySignal[]): Promise<void> {
    const row = attempt.toRow();

    // The adapter opens a transaction only when there is something durable to write. A fake
    // that recorded the call regardless would report a transaction for an attempt that left
    // no trace anywhere, and a test asserting "one transaction carried the row and the signal"
    // would pass for the wrong reason.
    if (row === null && signals.length === 0) return;

    this.writes.push({ attempt, row, signals });

    if (row !== null) {
      this.pushHistory(row.user_id, {
        loginId: row.login_id,
        sessionId: row.session_id,
        fingerprint: row.fingerprint,
        country: row.country,
        location: toLocation(row.latitude, row.longitude, row.country),
        occurredAt: row.occurred_at,
      });
      this.touchDevice(row.user_id, row.fingerprint, row.occurred_at, toLocation(row.latitude, row.longitude, row.country));
    }

    for (const signal of signals) this.recordSignal(signal);
  }

  async saveSignals(signals: readonly SecuritySignal[]): Promise<void> {
    this.writes.push({ attempt: null, row: null, signals });
    for (const signal of signals) this.recordSignal(signal);
  }

  async listLoginHistory(
    userId: string,
    options: { limit?: number } = {},
  ): Promise<readonly LoginHistoryEntry[]> {
    return this.historyFor(userId).slice(0, options.limit ?? 50);
  }

  /** Newest first, the way the adapter's `orderBy: { occurred_at: 'desc' }` returns them. */
  async listDevices(): Promise<readonly DeviceUsage[]> {
    return [...this.devices.values()].sort(
      (a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime(),
    );
  }

  async lastSeenElsewhere(
    userId: string,
    fingerprint: string,
  ): Promise<{ location: GeoLocation; occurredAt: Date } | null> {
    const entry = this.historyFor(userId).find(
      (candidate) => candidate.fingerprint !== fingerprint && candidate.location !== null,
    );

    return entry?.location ? { location: entry.location, occurredAt: entry.occurredAt } : null;
  }

  async recentLoginHours(userId: string, limit: number): Promise<readonly number[]> {
    return this.historyFor(userId)
      .slice(0, limit)
      .map((entry) => entry.occurredAt.getUTCHours());
  }

  async listSignals(userId: string): Promise<readonly SecuritySignalRow[]> {
    return this.signals.filter((signal) => signal.user_id === userId);
  }

  /** Seeds a completed login, for the "where was this account last" scenarios. */
  seedLogin(input: {
    userId: string;
    fingerprint: string;
    occurredAt: Date;
    country?: string | null;
    latitude?: number;
    longitude?: number;
  }): void {
    const location =
      input.latitude !== undefined && input.longitude !== undefined
        ? GeoLocation.of(input.latitude, input.longitude, input.country ?? null)
        : null;

    this.pushHistory(input.userId, {
      loginId: crypto.randomUUID(),
      sessionId: null,
      fingerprint: input.fingerprint,
      country: input.country ?? null,
      location,
      occurredAt: input.occurredAt,
    });

    this.touchDevice(input.userId, input.fingerprint, input.occurredAt, location);
  }

  private recordSignal(signal: SecuritySignal): void {
    const row = signal.toRow();
    this.signals.push(row);

    const fingerprint = row.details.deviceFingerprint;
    if (typeof fingerprint !== 'string' || fingerprint === '') return;

    const existing = this.devices.get(fingerprint);
    if (existing === undefined) {
      this.devices.set(fingerprint, {
        fingerprint,
        lastSeenAt: row.detected_at,
        location: null,
        sessionId: null,
        trusted: true,
        loginCount: 1,
        signals: null,
      });
    }
  }

  private pushHistory(userId: string, entry: LoginHistoryEntry): void {
    this.history.push({ userId, entry });
  }

  private historyFor(userId: string): LoginHistoryEntry[] {
    return this.history
      .filter((row) => row.userId === userId)
      .map((row) => row.entry)
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  }

  private touchDevice(
    userId: string,
    fingerprint: string,
    seenAt: Date,
    location: GeoLocation | null,
  ): void {
    const existing = this.devices.get(fingerprint);
    this.devices.set(fingerprint, {
      fingerprint,
      lastSeenAt: seenAt > (existing?.lastSeenAt ?? seenAt) ? seenAt : (existing?.lastSeenAt ?? seenAt),
      location: existing?.location ?? location,
      sessionId: existing?.sessionId ?? null,
      trusted: existing?.trusted ?? true,
      loginCount: (existing?.loginCount ?? 0) + 1,
      signals: existing?.signals ?? null,
    });
    void userId;
  }
}

/**
 * A config built by hand.
 *
 * @remarks `process.env` is never touched. A test that read the environment would pass or fail
 * with whoever's shell ran it, and the lockout thresholds are the numbers most worth pinning.
 */
export function testConfig(overrides: Partial<AccountSecurityConfig> = {}): AccountSecurityConfig {
  return { ...resolveAccountSecurityConfig({}), ...overrides };
}

function toLocation(
  latitude: number | null,
  longitude: number | null,
  country: string | null,
): GeoLocation | null {
  if (latitude === null || longitude === null) return null;
  return GeoLocation.fromRow(latitude, longitude, country);
}