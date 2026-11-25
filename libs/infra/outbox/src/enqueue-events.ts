/**
 * @fileoverview The envelope builder every domain's outbox writer shares.
 *
 * @remarks The envelope — the row in `outbox_events` and the payload it carries — is the
 * transactional-outbox contract: `dedup_key` turns a retried command into a no-op, and
 * `skipDuplicates` makes that safe. One builder means the shape cannot drift between services,
 * which is where a missing `schemaVersion` or a different `partitionKey` field silently
 * disagrees with the relay's read side.
 *
 * @remarks A domain module supplies the event-name -> topic map and the payload guard — that
 * mapping stays next to the service that owns the events, because it is the service's contract
 * to the topics other services read.
 */
import { type Logger } from '@nestjs/common';
import { EVENT_SCHEMA_VERSION } from '@auth/contracts';

/** The events the builder accepts: the domain's `IDomainEvent`s, or a narrower shape. */
export interface OutboxEnvelopeEvent {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly version: number;
  readonly correlationId?: string | undefined;
  readonly payload?: unknown;
}

/**
 * The row shape; the caller casts it to its own generated `outbox_eventsCreateManyInput`.
 *
 * @remarks `payload` is `unknown` on purpose: the generated input's `payload` is a Prisma
 * JSON input, and the shared builder has no reason to know any one service's Prisma module.
 */
export interface OutboxRow {
  id: string;
  type: string;
  aggregate_type: string;
  aggregate_id: string;
  topic: string;
  payload: unknown;
  dedup_key: string;
  status: string;
  attempts: number;
  next_attempt_at: Date;
  trace_id: string;
}

export interface BuildOutboxRowsOptions {
  readonly logger: Logger;
  /** Resolves the event name to the topic the announcement rides on. `null` when unmapped. */
  readonly getTopic: (event: OutboxEnvelopeEvent) => string | null;
  /** Payload keys that must never reach a topic. */
  readonly forbiddenPayloadKey: RegExp;
  readonly schemaVersion?: number;
  /** Event's partition key; defaults to the aggregate id. */
  readonly partitionKey?: (event: OutboxEnvelopeEvent) => string;
  /** Called with the refused payload's keys before the throw; lets a service log its own way. */
  readonly onRefusal?: (event: OutboxEnvelopeEvent, droppedKeys: readonly string[]) => void;
}

export function buildOutboxRows(
  events: readonly OutboxEnvelopeEvent[],
  options: BuildOutboxRowsOptions,
): OutboxRow[] {
  const rows: OutboxRow[] = [];

  for (const event of events) {
    const topic = options.getTopic(event);
    if (!topic) {
      // An unmapped event is a build-time oversight. Logging and continuing is deliberate:
      // failing the transaction would roll back a perfectly valid state change over a topic
      // that has not been wired up yet.
      options.logger.warn(`No topic mapped for domain event "${event.eventType}"`);
      continue;
    }

    rows.push(outboxRowFor(event, topic, options));
  }

  return rows;
}

function outboxRowFor(
  event: OutboxEnvelopeEvent,
  topic: string,
  options: BuildOutboxRowsOptions,
): OutboxRow {
  return {
    id: event.eventId,
    type: event.eventType,
    aggregate_type: event.aggregateType,
    aggregate_id: event.aggregateId,
    topic,
    payload: {
      eventId: event.eventId,
      type: topic,
      schemaVersion: options.schemaVersion ?? EVENT_SCHEMA_VERSION,
      occurredAt: event.occurredAt.toISOString(),
      aggregateId: event.aggregateId,
      aggregateType: event.aggregateType,
      partitionKey: options.partitionKey?.(event) ?? event.aggregateId,
      payload: sanitizeOutboxPayload(event, options),
    },
    dedup_key: `${event.eventType}:${event.aggregateId}:${event.version}`,
    status: 'pending',
    attempts: 0,
    next_attempt_at: new Date(),
    trace_id: event.correlationId ?? crypto.randomUUID(),
  };
}

/** Events without a payload exist; the envelope still needs the key to be present. */
function sanitizeOutboxPayload(
  event: OutboxEnvelopeEvent,
  options: BuildOutboxRowsOptions,
): Record<string, unknown> {
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null) return {};

  const dropped = Object.keys(payload).filter((key) => options.forbiddenPayloadKey.test(key));
  if (dropped.length > 0) {
    options.onRefusal?.(event, dropped);
    throw new Error(
      `refusing to publish "${event.eventType}": payload carries ${dropped.join(', ')}, which may be a credential`,
    );
  }

  return payload as Record<string, unknown>;
}
