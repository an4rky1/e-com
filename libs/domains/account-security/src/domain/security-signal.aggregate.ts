/**
 * @fileoverview The `SecuritySignal` aggregate: one thing this service noticed.
 *
 * @remarks A signal is the output of the whole service. Scoring produces evidence, and evidence
 * has to land somewhere queryable and announceable: `security_signals` is the durable record and
 * the outbox row is the announcement. The two commit together, which is what makes a signal
 * impossible to store without anyone being told about it, or to announce without a record.
 */
import { AggregateRoot, DomainEvent, Ensure } from '@auth/core';
import type { SecurityEventPayload } from '@auth/contracts';
import { RiskScore } from './value-objects/risk-score.vo';
import {
  isSecuritySignalType,
  SecuritySignalType,
} from './value-objects/security-signal-type.vo';

export const SECURITY_SIGNAL_AGGREGATE = 'SecuritySignal';

/** The domain event a signal raises. One type per signal type, so topics map 1:1. */
export class SecuritySignalRaised extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: SecurityEventPayload & { readonly signalId: string },
    version = 1,
  ) {
    super(aggregateId, SECURITY_SIGNAL_AGGREGATE, `security.${payload.type}`, version);
  }
}

/** The row shape of `security_signals`. */
export interface SecuritySignalRow {
  signal_id: string;
  user_id: string;
  signal_type: string;
  risk_score: number;
  detected_at: Date;
  details: Record<string, unknown>;
}

/** What a caller wants recorded. Everything optional except the user and the type. */
export interface SecuritySignalProps {
  readonly userId: string;
  readonly type: SecuritySignalType;
  readonly score: RiskScore;
  readonly ipAddress: string | null;
  readonly deviceFingerprint: string | null;
  readonly factors: readonly string[];
  readonly details: Readonly<Record<string, unknown>>;
}

export class SecuritySignal extends AggregateRoot<string> {
  private constructor(
    private readonly props: SecuritySignalProps,
    id: string,
    detectedAt: Date,
  ) {
    super(id, detectedAt, detectedAt, null);
  }

  /**
   * Raises a signal.
   *
   * @remarks Construction is a transition, not the absence of one: a signal that exists is a
   * signal that has to be published, so the factory raises the event and {@link fromRow} — the
   * only path that has already written — does not. A signal saved with an empty event buffer
   * would be an anomaly nobody downstream ever hears about.
   */
  static create(input: {
    userId: string;
    type: SecuritySignalType;
    score: RiskScore;
    factors?: readonly string[];
    ipAddress?: string | null;
    deviceFingerprint?: string | null;
    details?: Readonly<Record<string, unknown>>;
    id?: string;
    now?: Date;
  }): SecuritySignal {
    Ensure.notEmpty(input.userId, 'userId');

    const now = input.now ?? new Date();
    const id = input.id ?? crypto.randomUUID();
    const factors = input.factors ?? [];

    const signal = new SecuritySignal(
      {
        userId: input.userId,
        type: input.type,
        score: input.score,
        ipAddress: input.ipAddress ?? null,
        deviceFingerprint: input.deviceFingerprint ?? null,
        factors,
        details: { ...input.details },
      },
      id,
      now,
    );

    signal.addDomainEvent(
      new SecuritySignalRaised(
        id,
        {
          signalId: id,
          userId: input.userId,
          type: input.type,
          riskScore: input.score.value,
          riskLevel: input.score.level,
          ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
          ...(input.deviceFingerprint ? { deviceFingerprint: input.deviceFingerprint } : {}),
          factors: [...factors],
        },
        signal.version,
      ),
    );

    return signal;
  }

  /** Rehydration from `security_signals`. Does not emit — the write already happened. */
  static fromRow(row: SecuritySignalRow): SecuritySignal {
    const details = readDetails(row.details);

    return new SecuritySignal(
      {
        userId: row.user_id,
        // An unrecognised column value is read as the catch-all rather than cast through: the
        // column is `text`, and a type that reached here from an older row or a hand-edited
        // record still has to render somewhere instead of failing a whole history query.
        type: isSecuritySignalType(row.signal_type)
          ? row.signal_type
          : SecuritySignalType.ANOMALY_DETECTED,
        score: RiskScore.create(row.risk_score),
        ipAddress: (details.ipAddress as string | undefined) ?? null,
        deviceFingerprint: (details.deviceFingerprint as string | undefined) ?? null,
        factors: Array.isArray(details.factors)
          ? (details.factors as string[])
          : [],
        details,
      },
      row.signal_id,
      row.detected_at,
    );
  }

  get userId(): string {
    return this.props.userId;
  }

  get type(): SecuritySignalType {
    return this.props.type;
  }

  get score(): RiskScore {
    return this.props.score;
  }

  get factors(): readonly string[] {
    return this.props.factors;
  }

  get detectedAt(): Date {
    return this.createdAt;
  }

  /**
   * The event-stream version, not a stored column.
   *
   * @remarks `security_signals` has no version column, and it does not need one: a signal is
   * immutable and raises exactly one event, so `dedup_key` is already unique through
   * `signal_id` and the version only has to be stable. `create` therefore always produces 1.
   */
  override get version(): number {
    return this.domainEvents.length + 1;
  }

  toRow(): SecuritySignalRow {
    return {
      signal_id: this.id,
      user_id: this.props.userId,
      signal_type: this.props.type,
      risk_score: this.props.score.value,
      detected_at: this.detectedAt,
      details: {
        ...this.props.details,
        ipAddress: this.props.ipAddress,
        deviceFingerprint: this.props.deviceFingerprint,
        factors: [...this.props.factors],
        riskLevel: this.props.score.level,
      },
    };
  }
}

/**
 * Reads the JSON column back into a plain object.
 *
 * @remarks `security_signals.details` is a `json` column, so it comes back as
 * `Prisma.JsonValue` — which may legitimately be a scalar, an array, or `null` if an operator
 * or an older writer put one there. Widening it to a record without checking is how a
 * `"details": "n/a"` row crashes the signal a user is looking at in an audit screen.
 */
function readDetails(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}