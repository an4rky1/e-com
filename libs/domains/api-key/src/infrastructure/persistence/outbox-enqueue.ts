/**
 * @fileoverview The one place domain events become `outbox_events` rows.
 *
 * @remarks Every write goes through here so the transactional-outbox guarantee has a single
 * implementation: the rows go in with the state change, or they do not go in at all. Two call
 * sites each open-coding this is how one of them ends up publishing after the commit, which is
 * precisely the window the pattern exists to close.
 */
import { type Logger } from '@nestjs/common';
import { EVENT_SCHEMA_VERSION } from '@auth/contracts';
import type { IDomainEvent } from '@auth/core';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';

/**
 * Payload keys that must never reach a topic.
 *
 * @remarks A guard, not a convention. The aggregates publish `{ apiKeyId, prefix, scopes }`
 * today, but a later edit that adds the secret "for just this one consumer" would otherwise
 * ship a live credential to a topic with a retention measured in days, from which every
 * consumer, every replay and every log dump could read it.
 *
 * @remarks Anchored where it matters. `apiKeyId` and `secret_hash`-free identifiers such as
 * `userId` must survive: the check is for a *value*, not for a substring of every field name
 * this service owns. `^key$`/`^api_key$` catch a bare `key` payload field; `secret` and
 * `digest` catch the two things a credential can be smuggled out as.
 */
const FORBIDDEN_PAYLOAD_KEY = /secret|plaintext|digest|^key$|^api_key$/i;

export interface EnqueueEventsOptions {
  /**
   * The transaction's client — never the root client.
   *
   * @remarks Typed as the generated client rather than a structural subset: `createMany` is
   * generic over its input, and a hand-written structural interface cannot be satisfied by it
   * without widening `data` to `Record<string, unknown>`, which is exactly the loose typing that
   * lets a missing column through to the database.
   */
  readonly client: PrismaClient;
  readonly logger: Logger;
  /** Domain event name -> integration topic. */
  readonly topics: Readonly<Record<string, string>>;
}

/**
 * Appends one outbox row per mapped event, inside the caller's transaction.
 *
 * @remarks `dedup_key` is `<type>:<aggregateId>:<version>`. The aggregate's *event version*,
 * not a clock or a uuid: re-running the same command produces the same version, and the
 * unique index on `(dedup_key, type)` turns the second insert into a no-op instead of a
 * duplicate `api_key.created`.
 *
 * @remarks `skipDuplicates` is what makes a retried command safe, and batching is what keeps
 * a rotation — two rows, two events — to a single round trip inside the transaction.
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
 * @remarks Throwing rather than filtering silently: a payload that *tried* to carry a secret is
 * a bug that has already been written, and quietly dropping the field would leave a consumer
 * missing data it might legitimately need — which is how the same bug gets reintroduced in a
 * different shape next time. Failing inside the transaction rolls the whole state change back,
 * so a key is never issued and announced under a payload nobody should have seen.
 */
function sanitizePayload(payload: Record<string, unknown>, eventType: string): Record<string, unknown> {
  const dropped = Object.keys(payload).filter((key) => FORBIDDEN_PAYLOAD_KEY.test(key));

  if (dropped.length > 0) {
    throw new Error(
      `refusing to publish "${eventType}": payload carries ${dropped.join(', ')}, which may be a credential`,
    );
  }

  return payload;
}