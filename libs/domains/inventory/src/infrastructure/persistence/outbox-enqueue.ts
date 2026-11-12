/**
 * @fileoverview The one place domain events become `outbox_events` rows.
 *
 * @remarks Every write in this service goes through here so the transactional-outbox
 * guarantee has a single implementation: the rows go in with the state change, or they do
 * not go in at all. Two call sites each open-coding this is how one of them ends up
 * publishing after the commit, which is precisely the window the pattern exists to close.
 *
 * @remarks `dedup_key` is `<type>:<aggregateId>:<version>` and the unique index on
 * `(dedup_key, type)` is what makes a retried command safe. That is also why the version
 * is never a clock and never a uuid: re-running the same command produces the same key,
 * and the second insert becomes a no-op instead of a duplicate announcement.
 */
import { type Logger } from '@nestjs/common';
import { EVENT_SCHEMA_VERSION } from '@auth/contracts';
import type { IDomainEvent } from '@auth/core';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';

/**
 * Payload keys that must never reach a topic.
 *
 * @remarks A guard, not a convention. The payloads this service publishes are quantities
 * and identifiers, but a later edit that adds "just this one field" for a consumer — a
 * payment-method token, a secret, a raw credential — would otherwise ship it to a Kafka
 * topic with a retention measured in days, from which every consumer, every replay and
 * every log dump could read it.
 *
 * @remarks Anchored where it matters: `orderId`, `reservationId`, `invoiceId` and
 * `adjustmentId` must survive, so the check is for a *value*, not for a substring of every
 * field name this service owns.
 */
const FORBIDDEN_PAYLOAD_KEY = /token|secret|password|plaintext|digest|^key$|^credential$/i;

export interface EnqueueEventsOptions {
  /**
   * The transaction's client — never the root client.
   *
   * @remarks Typed as the generated client rather than a structural subset: `createMany` is
   * generic over its input, and a hand-written structural interface cannot be satisfied by
   * it without widening `data` to `Record<string, unknown>`, which is exactly the loose
   * typing that lets a missing column through to the database.
   */
  readonly client: PrismaClient;
  readonly logger: Logger;
  /** Domain event name -> integration topic. */
  readonly topics: Readonly<Record<string, string>>;
}

/**
 * Appends one outbox row per mapped event, inside the caller's transaction.
 *
 * @remarks `skipDuplicates` is what makes a retried command safe, and batching is what
 * keeps a multi-line reserve — one row per line — to a single round trip inside the
 * transaction.
 */
export async function enqueueEvents(
  events: readonly IDomainEvent[],
  options: EnqueueEventsOptions,
): Promise<void> {
  if (events.length === 0) return;

  const rows: Prisma.outbox_eventsCreateManyInput[] = [];

  for (const event of events) {
    const topic = options.topics[event.eventType];

    if (!topic) {
      // An unmapped event is a build-time oversight. Logging and continuing is deliberate:
      // failing the transaction would roll back a perfectly valid state change over a topic
      // that has not been wired up yet.
      options.logger.warn(`No topic mapped for domain event "${event.eventType}"`);
      continue;
    }

    const payload = readPayload(event);

    rows.push({
      id: event.eventId,
      type: event.eventType,
      aggregate_type: event.aggregateType,
      aggregate_id: event.aggregateId,
      topic,
      // `payload` is a JSON column, so it needs Prisma's Json input type rather than a plain
      // Record; the cast is the documented boundary for that conversion.
      payload: {
        eventId: event.eventId,
        type: topic,
        schemaVersion: EVENT_SCHEMA_VERSION,
        occurredAt: event.occurredAt.toISOString(),
        aggregateId: event.aggregateId,
        aggregateType: event.aggregateType,
        partitionKey: event.aggregateId,
        payload,
      } as unknown as Prisma.InputJsonValue,
      dedup_key: `${event.eventType}:${event.aggregateId}:${event.version}`,
      status: 'pending',
      attempts: 0,
      next_attempt_at: new Date(),
      trace_id: event.correlationId ?? crypto.randomUUID(),
    });
  }

  if (rows.length === 0) return;

  await options.client.outbox_events.createMany({ data: rows, skipDuplicates: true });
}

/** Events without a payload exist; the envelope still needs the key to be present. */
function readPayload(event: IDomainEvent): Record<string, unknown> {
  const candidate = event as unknown as { payload?: unknown };
  return typeof candidate.payload === 'object' && candidate.payload !== null
    ? sanitizePayload(candidate.payload as Record<string, unknown>, event.eventType)
    : {};
}

/**
 * Fails if the payload carries anything that looks like a credential.
 *
 * @remarks Throwing rather than filtering silently: a payload that *tried* to carry a
 * secret is a bug that has already been written, and quietly dropping the field would
 * leave a consumer missing data it might legitimately need — which is how the same bug
 * gets reintroduced in a different shape next time. Failing inside the transaction rolls
 * the whole state change back, so no stock is moved and announced under a payload nobody
 * should have seen.
 */
function sanitizePayload(
  payload: Record<string, unknown>,
  eventType: string,
): Record<string, unknown> {
  const dropped = Object.keys(payload).filter((key) => FORBIDDEN_PAYLOAD_KEY.test(key));

  if (dropped.length > 0) {
    throw new Error(
      `refusing to publish "${eventType}": payload carries ${dropped.join(', ')}, which may be a credential`,
    );
  }

  return payload;
}
