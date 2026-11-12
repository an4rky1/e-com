/**
 * @fileoverview Prisma adapter for `account_security`.
 *
 * @remarks The transactional-outbox guarantee lives here. Every mutation goes through the
 * event sink, which writes the `outbox_events` rows for classified events in the *same*
 * transaction as the state change, so either a consumer eventually hears about a login or
 * nothing about it exists — never a signal that was stored and never announced, and never an
 * announcement of something that was rolled back.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { PrismaService } from '@auth/infra/prisma';
import { DOMAIN_EVENT_SINK, type DomainEventSink } from '@auth/infra/events';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import { ACCOUNT_SECURITY_PRISMA } from '../../account-security.config';
import type { LoginAttempt, LoginHistoryRow } from '../../domain/login-attempt.aggregate';
import type { SecuritySignal, SecuritySignalRow } from '../../domain/security-signal.aggregate';
import type {
  DeviceUsage,
  LoginHistoryEntry,
  SecurityRepositoryPort,
} from '../../domain/ports/security-repository.port';
import type { DeviceSignals } from '../../domain/value-objects/device-fingerprint.vo';
import { GeoLocation } from '../../domain/value-objects/geo-location.vo';
import { SecuritySignalType } from '../../domain/value-objects/security-signal-type.vo';

@Injectable()
export class PrismaSecurityRepository implements SecurityRepositoryPort {
  constructor(
    @Inject(ACCOUNT_SECURITY_PRISMA) private readonly prisma: PrismaService<PrismaClient>,
    @Inject(DOMAIN_EVENT_SINK) private readonly sink: DomainEventSink,
  ) {}

  /**
   * The login history, the signals and every outbox row, in one commit.
   *
   * @remarks `createMany` with `skipDuplicates` rather than `create`: a redelivered command
   * must not turn one anomaly into two, and the unique index on `(dedup_key, type)` is what
   * makes the retry a no-op instead of a duplicate on every downstream consumer.
   */
  async saveAttempt(attempt: LoginAttempt, signals: readonly SecuritySignal[]): Promise<void> {
    const row = attempt.toRow();
    if (row === null && signals.length === 0) {
      // Nothing durable and nothing announced: a failed attempt for a user we cannot identify.
      // The counters moved in Redis, which is the entire point of recording it.
      return;
    }

    const pending = signals.map((signal) => ({ signal, events: signal.clearDomainEvents() }));
    const events = [...pending.flatMap(({ events }) => events), ...attempt.clearDomainEvents()];

    await this.sink.run(this.prisma, events, async (client) => {
      if (row !== null) {
        await client.login_history.createMany({ data: [toLoginRow(row)], skipDuplicates: true });
      }

      if (pending.length > 0) {
        await client.security_signals.createMany({
          data: pending.map(({ signal }) => toSignalRow(signal)),
          skipDuplicates: true,
        });
      }
    });
  }

  /**
   * Signals and their outbox rows, in one commit.
   *
   * @remarks Same guarantee as {@link saveAttempt}, for the commands that mutate without a login.
   */
  async saveSignals(signals: readonly SecuritySignal[]): Promise<void> {
    if (signals.length === 0) return;

    const pending = signals.map((signal) => ({ signal, events: signal.clearDomainEvents() }));
    const events = pending.flatMap(({ events }) => events);

    await this.sink.run(this.prisma, events, async (client) => {
      await client.security_signals.createMany({
        data: pending.map(({ signal }) => toSignalRow(signal)),
        skipDuplicates: true,
      });
    });
  }

  async listLoginHistory(
    userId: string,
    options: { limit?: number } = {},
  ): Promise<readonly LoginHistoryEntry[]> {
    const rows = await this.prisma.tx.login_history.findMany({
      where: { user_id: userId },
      orderBy: { occurred_at: 'desc' },
      take: options.limit ?? 50,
    });

    return rows.map((row) => ({
      loginId: row.login_id,
      sessionId: row.session_id,
      fingerprint: row.fingerprint,
      country: row.country,
      location: toLocation(row.latitude, row.longitude, row.country),
      occurredAt: row.occurred_at,
    }));
  }

  /**
   * Every fingerprint the account has used, newest first.
   *
   * @remarks Reduced in JavaScript rather than with `groupBy`. The rows are already ordered by
   * `occurred_at desc` and the answer only needs the first row per fingerprint, so a SQL
   * `DISTINCT ON` would be a second spelling of the same rule — and this one is unit-testable
   * against a plain array.
   */
  async listDevices(userId: string): Promise<readonly DeviceUsage[]> {
    const [rows, signals] = await Promise.all([
      this.prisma.tx.login_history.findMany({
        where: { user_id: userId },
        orderBy: { occurred_at: 'desc' },
        take: DEVICE_SCAN_LIMIT,
      }),
      // The device's own attributes are not in `login_history` — the table stores a digest, on
      // purpose. They are kept on the `new_device_detected` signal that recorded the first time
      // this fingerprint appeared, which is the one place they were ever written down.
      this.prisma.tx.security_signals.findMany({
        where: { user_id: userId, signal_type: SecuritySignalType.NEW_DEVICE_DETECTED },
        orderBy: { detected_at: 'desc' },
        take: DEVICE_SCAN_LIMIT,
      }),
    ]);

    const attributes = new Map<string, DeviceSignals>();
    for (const signal of signals) {
      const details = readDetails(signal.details);
      const fingerprint = details.deviceFingerprint;
      if (typeof fingerprint !== 'string' || attributes.has(fingerprint)) continue;
      attributes.set(fingerprint, readDeviceSignals(details));
    }

    const devices = new Map<string, DeviceUsage>();

    for (const row of rows) {
      const existing = devices.get(row.fingerprint);
      if (existing === undefined) {
        devices.set(row.fingerprint, {
          fingerprint: row.fingerprint,
          lastSeenAt: row.occurred_at,
          location: toLocation(row.latitude, row.longitude, row.country),
          sessionId: row.session_id,
          trusted: true,
          loginCount: 1,
          signals: attributes.get(row.fingerprint) ?? null,
        });
        continue;
      }

      devices.set(row.fingerprint, { ...existing, loginCount: existing.loginCount + 1 });
    }

    return [...devices.values()];
  }

  async lastSeenElsewhere(
    userId: string,
    fingerprint: string,
  ): Promise<{ location: GeoLocation; occurredAt: Date } | null> {
    const row = await this.prisma.tx.login_history.findFirst({
      where: {
        user_id: userId,
        fingerprint: { not: fingerprint },
        // `null` is excluded by the `not` filter below only if it is stated; a row with no
        // coordinates cannot be compared, so it is filtered out here rather than in JS.
        latitude: { not: null },
        longitude: { not: null },
      },
      orderBy: { occurred_at: 'desc' },
      select: {
        latitude: true,
        longitude: true,
        country: true,
        occurred_at: true,
      },
    });

    if (row === null || row.latitude === null || row.longitude === null) return null;

    return {
      location: GeoLocation.fromRow(row.latitude, row.longitude, row.country),
      occurredAt: row.occurred_at,
    };
  }

  async recentLoginHours(userId: string, limit: number): Promise<readonly number[]> {
    const rows = await this.prisma.tx.login_history.findMany({
      where: { user_id: userId },
      orderBy: { occurred_at: 'desc' },
      take: limit,
      select: { occurred_at: true },
    });

    return rows.map((row) => row.occurred_at.getUTCHours());
  }

  async listSignals(
    userId: string,
    options: { limit?: number } = {},
  ): Promise<readonly SecuritySignalRow[]> {
    const rows = await this.prisma.tx.security_signals.findMany({
      where: { user_id: userId },
      orderBy: { detected_at: 'desc' },
      take: options.limit ?? 50,
    });

    return rows.map((row) => ({
      signal_id: row.signal_id,
      user_id: row.user_id,
      signal_type: row.signal_type,
      risk_score: row.risk_score,
      detected_at: row.detected_at,
      details: readDetails(row.details),
    }));
  }
}

/**
 * How many login rows a device scan reads before giving up.
 *
 * @remarks The device list is a projection of the history and there is no index on
 * `(user_id, fingerprint)` alone that answers "distinct fingerprints ordered by last seen", so
 * the scan is bounded. 500 rows is far past the point where a real account accumulates
 * distinct devices, and past it the answer degrades to "the most recent 500 logins" rather than
 * to a slow query.
 */
const DEVICE_SCAN_LIMIT = 500;

function toLoginRow(row: LoginHistoryRow) {
  return {
    login_id: row.login_id,
    user_id: row.user_id,
    session_id: row.session_id,
    fingerprint: row.fingerprint,
    country: row.country,
    latitude: row.latitude,
    longitude: row.longitude,
    occurred_at: row.occurred_at,
  };
}

function toSignalRow(signal: SecuritySignal) {
  const row = signal.toRow();
  return {
    signal_id: row.signal_id,
    user_id: row.user_id,
    // `signal.type`, not `row.signal_type`. The row widens the field to `string` because that is
    // what the read path faces — a stored row may hold anything, and `fromRow` narrows it back
    // with `isSecuritySignalType`. This is the opposite direction: `signal.type` is already the
    // VO's union and `security_signals.signal_type` is a Postgres enum whose members are exactly
    // those three, so the value can be handed to Prisma without a cast.
    signal_type: signal.type,
    risk_score: row.risk_score,
    detected_at: row.detected_at,
    // `details` is a JSON column, so it needs Prisma's Json input type; the cast is the
    // documented boundary for that conversion.
    details: row.details as unknown as Prisma.InputJsonValue,
  };
}

function toLocation(
  latitude: number | null,
  longitude: number | null,
  country: string | null,
): GeoLocation | null {
  if (latitude === null || longitude === null) return null;
  return GeoLocation.fromRow(latitude, longitude, country);
}

/** `security_signals.details` is a `json` column and may legally hold a scalar or an array. */
function readDetails(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/**
 * The raw device attributes, as the `new_device_detected` signal recorded them.
 *
 * @remarks Read field by field rather than cast. `details` is untyped JSON and this is the one
 * place it flows back into a domain type: a hand-edited row with `userAgent: 42` would put a
 * number into a `DeviceSignals` field and then into a device name.
 */
function readDeviceSignals(details: Record<string, unknown>): DeviceSignals {
  const text = (key: string): string | null => {
    const value = details[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  return {
    userAgent: text('userAgent'),
    platform: text('platform'),
    screenResolution: text('screenResolution'),
    timezone: text('timezone'),
    language: text('language'),
  };
}
