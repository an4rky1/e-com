/**
 * @fileoverview One audit record.
 *
 * @remarks An immutable value, not an aggregate root: there is nothing to mutate, and the
 * only operations the domain exposes are "describe a fact" and "prove a chain of facts". The
 * name is kept for symmetry with its siblings.
 *
 * @remarks `receivedAt` is stored separately from `occurredAt` and the gap between them is
 * meaningful — a record that took forty seconds to arrive is the difference between "the
 * system was down" and "the system was lying about the time", and hashing both makes the
 * distinction survive tampering.
 */
import type { AuditEventId } from '@auth/ddd-core';
import type { ActorType, AuditResult, ResourceType } from './value-objects/audit-result.vo';
import type { ChainLink } from './audit-chain';

/** Aggregate/event identity constant — the prefix that scopes every audit record. */
export const AUDIT_AGGREGATE = 'AuditEvent';

export interface AuditEventProps {
  id: string;
  partitionKey: string;
  sequence: number;
  occurredAt: Date;
  receivedAt: Date;
  actorId: string;
  actorType: ActorType;
  action: string;
  resourceType: ResourceType;
  resourceId: string;
  result: AuditResult;
  ipAddress: string | null;
  userAgent: string | null;
  payload: Readonly<Record<string, unknown>>;
  traceId: string;
}

/** The shape the hash is taken over, without the two hash columns. */
export type AuditLink = ChainLink;

export class AuditEvent {
  private constructor(private readonly props: AuditEventProps) {}

  get id(): string {
    return this.props.id;
  }

  get partitionKey(): string {
    return this.props.partitionKey;
  }

  get sequence(): number {
    return this.props.sequence;
  }

  get occurredAt(): Date {
    return this.props.occurredAt;
  }

  get receivedAt(): Date {
    return this.props.receivedAt;
  }

  get actorId(): string {
    return this.props.actorId;
  }

  get actorType(): ActorType {
    return this.props.actorType;
  }

  get action(): string {
    return this.props.action;
  }

  get resourceType(): ResourceType {
    return this.props.resourceType;
  }

  get resourceId(): string {
    return this.props.resourceId;
  }

  get result(): AuditResult {
    return this.props.result;
  }

  get ipAddress(): string | null {
    return this.props.ipAddress;
  }

  get userAgent(): string | null {
    return this.props.userAgent;
  }

  get payload(): Readonly<Record<string, unknown>> {
    return this.props.payload;
  }

  get traceId(): string {
    return this.props.traceId;
  }

  /** The canonical form the hash is computed over. */
  get link(): AuditLink {
    return {
      id: this.props.id,
      partitionKey: this.props.partitionKey,
      sequence: this.props.sequence,
      occurredAt: this.props.occurredAt,
      receivedAt: this.props.receivedAt,
      actorId: this.props.actorId,
      actorType: this.props.actorType,
      action: this.props.action,
      resourceType: this.props.resourceType,
      resourceId: this.props.resourceId,
      result: this.props.result,
      ipAddress: this.props.ipAddress,
      userAgent: this.props.userAgent,
      payload: this.props.payload,
      traceId: this.props.traceId,
    };
  }

  /**
   * Records a fact.
   *
   * @remarks `sequence` and `partitionKey` are supplied rather than derived, because both are
   * assigned under a row lock inside the same transaction that inserts the row. Deriving them
   * here would mean reading the chain head outside the transaction that writes it, which is
   * the read-then-write race the lock exists to prevent.
   *
   * @remarks No hashing happens here. `sequence` is only known once the head row is locked, so
   * the hash is computed by the repository from the link this exposes — and computing it in
   * two places is how a chain stops verifying.
   */
  static record(props: AuditEventProps): AuditEvent {
    return new AuditEvent(props);
  }

  /** Rehydration. Sequence and partition come from the row, never from a guess. */
  static fromRow(row: AuditEventProps): AuditEvent {
    return new AuditEvent(row);
  }

  /** The typed id this record carries, for callers that pass one around as an `AuditEventId`. */
  get typedId(): AuditEventId {
    return this.props.id as AuditEventId;
  }
}