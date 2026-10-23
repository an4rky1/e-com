/**
 * @fileoverview Prisma adapter for `account_security`.
 *
 * @remarks The transactional-outbox guarantee lives here. Every mutation goes through
 * `runInTransaction` and writes its `outbox_events` rows in the *same* transaction as the state
 * change, so either a consumer eventually hears about a login or nothing about it exists —
 * never a signal that was stored and never announced, and never an announcement of something
 * that was rolled back.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PrismaService } from '@auth/infra/prisma';
import { Topics } from '@auth/contracts';
import type { IDomainEvent } from '@auth/core';
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

/**
 * The domain-event -> topic mapping.
 *
 * @remarks Every event this service raises has exactly one topic, and the mapping is a single
 * lookup so adding a signal type cannot invent a topic name no consumer subscribes to. The
 * attempt's own `login.succeeded` / `login.failed` facts are deliberately *not* here: the
 * durable record of a login is the `login_history` row, and the catalogue gives this service
 * three topics and none of them is "a login happened". An event with no topic is skipped
 * quietly — a warn per sign-in would drown the one warning that matters.
 */
const TOPIC_FOR_EVENT: Record<string, string> = {
  'security.new_device_detected': Topics.SECURITY_NEW_DEVICE_DETECTED,
  'security.suspicious_login_detected': Topics.SECURITY_SUSPICIOUS_LOGIN_DETECTED,
  'security.anomaly_detected': Topics.SECURITY_ANOMALY_DETECTED,
  // The two account-lifecycle facts ride on the anomaly topic: a consumer keeping a count of
  // locked accounts or a device list has to hear about both, and a fifth topic would mean a
  // second subscription for a fact that already has one.
  'account.locked': Topics.SECURITY_ANOMALY_DETECTED,
  'account.unlocked': Topics.SECURITY_ANOMALY_DETECTED,
};

@Injectable()
export class PrismaSecurityRepository implements SecurityRepositoryPort {
  private readonly logger = new Logger(PrismaSecurityRepository.name);

  constructor(
    @Inject(ACCOUNT_SECURITY_PRISMA) private readonly prisma: PrismaService<PrismaClient>,
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

    await this.prisma.runInTransaction(async (client) => {
      if (row !== null) {
        await client.login_history.createMany({ data: [toLoginRow(row)], skipDuplicates: true });
      }

      await this.writeSignals(client, signals);
      await this.writeAttemptEvents(client, attempt);
    });
  }

  /**
   * Signals and their outbox rows, in one commit.
   *
   * @remarks Same guarantee as {@link saveAttempt}, for the commands that mutate without a login.
   */
  async saveSignals(signals: readonly SecuritySignal[]): Promise<void> {
    if (signals.length === 0) return;

    await this.prisma.runInTransaction(async (client) => {
      await this.writeSignals(client, signals);
    });
  }

  private async writeSignals(
    client: PrismaClient,
    signals: readonly SecuritySignal[],
  ): Promise<void> {
    if (signals.length === 0) return;

    const pending = signals.map((signal) => ({ signal, events: signal.clearDomainEvents() }));

    await client.security_signals.createMany({
      data: pending.map(({ signal }) => toSignalRow(signal)),
      skipDuplicates: true,
    });

    for (const { signal, events } of pending) {
      for (const event of events) {
        await this.enqueue(client, event, signal.id, signal.userId);
      }
    }
  }

  private async writeAttemptEvents(client: PrismaClient, attempt: LoginAttempt): Promise<void> {
    const events = attempt.clearDomainEvents();
    const userId = attempt.userId;

    for (const event of events) {
      // An attempt with no resolvable account cannot be partitioned by one, and cannot be
      // announced: both the row's foreign key and the partition key would be missing.
      if (userId === null) continue;
      await this.enqueue(client, event, attempt.id, userId);
    }
  }

  /**
   * Writes one outbox row per domain event.
   *
   * @remarks `dedup_key` is what makes a redelivered command safe: the unique index on
   * `(dedup_key, type)` turns a second insert of the same fact into a no-op instead of a
   * duplicate `security.anomaly_detected`. The key ends in the event's version so two
   * *different* anomalies about the same user are still two events.
   */
  private async enqueue(
    client: PrismaClient,
    event: IDomainEvent,
    aggregateId: string,
    userId: string,
  ): Promise<void> {
    const topic = TOPIC_FOR_EVENT[event.eventType];
    if (topic === undefined) return;

    const payload = readPayload(event);
    const dedupKey = `${event.eventType}:${aggregateId}:${event.version}`;

    await client.outbox_events.createMany({
      data: [
        {
          id: event.eventId,
          type: event.eventType,
          aggregate_type: event.aggregateType,
          aggregate_id: aggregateId,
          topic,
          // `payload` is a JSON column, so it needs Prisma's Json input type rather than a
          // plain Record; the cast is the documented boundary for that conversion.
          payload: {
            eventId: event.eventId,
            type: topic,
            schemaVersion: 1,
            occurredAt: event.occurredAt.toISOString(),
            aggregateId,
            aggregateType: event.aggregateType,
            // The partition key is the *user*, not the attempt or the signal: two signals about
            // the same account have to land on the same partition or a consumer cannot order
            // them, and the order of "locked" against "unlocked" is the whole meaning.
            partitionKey: userId,
            payload: { ...payload, userId },
          } as unknown as Prisma.InputJsonValue,
          dedup_key: dedupKey,
          status: 'pending',
          attempts: 0,
          next_attempt_at: event.occurredAt,
          trace_id: event.correlationId ?? crypto.randomUUID(),
        },
      ],
      skipDuplicates: true,
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

/**
 * A domain event's payload.
 *
 * @remarks `IDomainEvent` carries no `payload` field by design — the interface is the transport
 * shape and a payload is the concrete event's business — so reading one needs a widening cast.
 */
function readPayload(event: IDomainEvent): Record<string, unknown> {
  const candidate = event as unknown as { payload?: unknown };
  return typeof candidate.payload === 'object' && candidate.payload !== null
    ? (candidate.payload as Record<string, unknown>)
    : {};
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
