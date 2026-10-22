/**
 * @fileoverview The single write path into the audit log.
 *
 * @remarks One command, and it is a command rather than a direct repository call because the
 * consumer is not the only future caller: an operator-facing "record that I exported this
 * chain" action and a replay tool would both need the same claim-then-append-then-release
 * sequence, and a caller that reimplements it is a caller that will eventually forget to
 * release the claim.
 */
import { Command } from '@nestjs/cqrs';
import type { ActorType, AuditResult, ResourceType } from '../../domain/value-objects/audit-result.vo';

/** What the caller wants recorded. Everything else is derived. */
export interface RecordAuditEventInput {
  /** `topic:eventId` — the consumer-side idempotency key. */
  readonly idempotencyKey: string;
  readonly actorId: string | null;
  readonly actorType: ActorType;
  readonly action: string;
  readonly resourceType: ResourceType;
  readonly resourceId: string;
  readonly result: AuditResult;
  /** The producer's event time. Distinct from `receivedAt`, which is this service's clock. */
  readonly occurredAt: Date;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  /** Already redacted. The redaction happens in the consumer, before this boundary. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly traceId: string;
}

export class RecordAuditEventCommand extends Command<{ id: string; appended: boolean }> {
  constructor(readonly input: RecordAuditEventInput) {
    super();
  }
}

export const toRecordAuditEventCommand = (input: RecordAuditEventInput): RecordAuditEventCommand =>
  new RecordAuditEventCommand(input);