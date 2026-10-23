/**
 * @fileoverview The one place domain events become `outbox_events` rows.
 *
 * @remarks Every repository in this service writes through here, so the transactional-outbox
 * guarantee has a single implementation: the rows go in with the state change, or they do not
 * go in at all. Two repositories each open-coding this is how one of them ends up publishing
 * after the commit, which is precisely the window the pattern exists to close.
 */

import type { Logger } from '@nestjs/common';
import { Topics } from '@auth/contracts';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';

/** Domain event name -> integration topic, per the contract. */
export const TOPIC_BY_EVENT: Readonly<Record<string, string>> = {
  'mfa.enrolled': Topics.MFA_ENROLLED,
  'mfa.verified': Topics.MFA_VERIFIED,
  'mfa.failed': Topics.MFA_FAILED,
  'mfa.disabled': Topics.MFA_DISABLED,
};

/**
 * Keys that must never appear in a published payload.
 *
 * @remarks A guard, not a convention. The aggregates already publish `{ userId, method }`, but
 * a later edit that adds the secret to an event "for just this one consumer" would otherwise
 * ship a TOTP secret to a Kafka topic with a retention measured in days — from which every
 * future consumer, every replay and every log dump could read it. Filtering by key rather
 * than trusting the payload means the mistake fails loudly instead.
 */
const FORBIDDEN_PAYLOAD_KEY = /secret|cipher|plaintext|digest|otp|^code$|recoverycode/i;

/** The shape {@link enqueueEvents} needs; narrower than `IDomainEvent` on purpose. */
export interface EnqueueableEvent {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly version: number;
  readonly correlationId?: string | undefined;
  readonly payload?: unknown;
}

export interface EnqueueOptions {
  readonly logger: Logger;
  /** Resolves the ordering key. Recovery codes partition by user, factors by factor id. */
  readonly partitionKey: (event: EnqueueableEvent) => string;
}

/**
 * Appends one outbox row per mapped event, inside the caller's transaction.
 *
 * @remarks `dedup_key` is `<type>:<aggregateId>:<version>` — the aggregate version, not a
 * clock or a uuid. Re-running the same command produces the same version, and
 * `skipDuplicates` against the unique index on `(dedup_key, type)` turns the second insert
 * into a no-op, so a retried command can never become a duplicate `mfa.verified`.
 */
export async function enqueueEvents(
  client: PrismaClient,
  events: readonly EnqueueableEvent[],
  options: EnqueueOptions,
): Promise<void> {
  const rows: Prisma.outbox_eventsCreateManyInput[] = events.flatMap((event) => {
    const topic = TOPIC_BY_EVENT[event.eventType];

    if (!topic) {
      // `mfa.enrollment_started` has no topic by design: nothing outside this service acts on
      // an enrollment that has not been confirmed yet. Logging and continuing is deliberate —
      // failing the transaction would roll back a perfectly valid enrollment over a topic
      // nobody subscribes to.
      options.logger.warn(`No topic mapped for domain event "${event.eventType}"`);
      return [];
    }

    return [
      {
        id: event.eventId,
        type: event.eventType,
        aggregate_type: event.aggregateType,
        aggregate_id: event.aggregateId,
        topic,
        payload: {
          eventId: event.eventId,
          topic,
          schemaVersion: 1,
          occurredAt: event.occurredAt.toISOString(),
          aggregateId: event.aggregateId,
          aggregateType: event.aggregateType,
          partitionKey: options.partitionKey(event),
          payload: sanitizePayload(event.payload, options.logger, event.eventType),
          // `payload` is a JSON column, so it needs Prisma's Json input type rather than a
          // plain Record; the cast is the documented boundary for that conversion.
        } as unknown as Prisma.InputJsonValue,
        dedup_key: `${event.eventType}:${event.aggregateId}:${event.version}`,
        status: 'pending',
        attempts: 0,
        next_attempt_at: new Date(),
        trace_id: event.correlationId ?? crypto.randomUUID(),
      },
    ];
  });

  if (rows.length === 0) return;

  await client.outbox_events.createMany({ data: rows, skipDuplicates: true });
}

/**
 * Fails if the payload carries anything that looks like a secret.
 *
 * @remarks Throwing rather than filtering silently: a payload that *tried* to carry a secret
 * is a bug that has already been written, and quietly dropping the field would leave the
 * consumer missing data it might legitimately need — which is how the same bug gets
 * reintroduced in a different shape next time.
 */
function sanitizePayload(
  payload: unknown,
  logger: Logger,
  eventType: string,
): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) return {};

  const record = payload as Record<string, unknown>;
  const dropped = Object.keys(record).filter((key) => FORBIDDEN_PAYLOAD_KEY.test(key));

  if (dropped.length > 0) {
    logger.error(
      `Refusing to publish "${eventType}": payload carries ${dropped.join(', ')}`,
    );
    throw new Error(
      `refusing to publish: "${eventType}" carries ${dropped.join(', ')}, which may be a secret`,
    );
  }

  return record;
}