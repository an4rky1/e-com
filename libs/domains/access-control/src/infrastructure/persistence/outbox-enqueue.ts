/**
 * @fileoverview The one place domain events become `outbox_events` rows.
 *
 * @remarks Every repository writes through here so the transactional-outbox guarantee has a
 * single implementation: the rows go in with the state change, or they do not go in at all.
 * Three repositories each open-coding this is how one of them ends up publishing after the
 * commit, which is precisely the window the pattern exists to close.
 */

import { type Logger } from '@nestjs/common';
import { type OutboxService } from '@auth/infra/outbox';
import type { IDomainEvent } from '@auth/core';

/** Domain event name -> integration topic, per aggregate. */
export type TopicMap = Readonly<Record<string, string>>;

export interface EnqueueOptions {
  /** Resolves the ordering key for an event; defaults to the aggregate's own id. */
  readonly partitionKey?: (event: IDomainEvent) => string;
  readonly outbox: OutboxService;
  readonly logger: Logger;
  readonly topics: TopicMap;
}

/**
 * Appends one outbox row per mapped event.
 *
 * @remarks `dedupKey` is `<type>:<aggregateId>:<version>` — the aggregate version, not a
 * clock or a uuid. Re-running the same command produces the same version, the unique index
 * on `(dedup_key, type)` turns the second insert into a no-op, and a retry can therefore
 * never turn into a duplicate `role.granted`.
 */
export async function enqueueEvents(
  events: readonly IDomainEvent[],
  options: EnqueueOptions,
): Promise<void> {
  for (const event of events) {
    const topic = options.topics[event.eventType];

    if (!topic) {
      // An unmapped event is a build-time oversight. Logging and continuing is deliberate:
      // failing the transaction would roll back a perfectly valid grant over a topic that has
      // not been wired up yet.
      options.logger.warn(`No topic mapped for domain event "${event.eventType}"`);
      continue;
    }

    await options.outbox.publish(topic, readPayload(event), {
      aggregateId: event.aggregateId,
      aggregateType: event.aggregateType,
      partitionKey: options.partitionKey?.(event) ?? event.aggregateId,
      dedupKey: `${event.eventType}:${event.aggregateId}:${event.version}`,
      traceId: event.correlationId,
    });
  }
}

/** Events without a payload exist; the envelope still needs the key to be present. */
function readPayload(event: IDomainEvent): Record<string, unknown> {
  const candidate = event as unknown as { payload?: unknown };
  return typeof candidate.payload === 'object' && candidate.payload !== null
    ? (candidate.payload as Record<string, unknown>)
    : {};
}