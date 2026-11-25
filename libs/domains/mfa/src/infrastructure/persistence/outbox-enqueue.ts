/**
 * @fileoverview The one place domain events become `outbox_events` rows.
 *
 * @remarks Every repository in this service writes through here, so the transactional-outbox
 * guarantee has a single implementation: the rows go in with the state change, or they do not
 * go in at all. Two repositories each open-coding this is how one of them ends up publishing
 * after the commit, which is precisely the window the pattern exists to close.
 *
 * @remarks The envelope itself is built by `buildOutboxRows` in `@auth/infra/outbox`; this file
 * supplies the topic table and the payload guard.
 */
import type { Logger } from '@nestjs/common';
import { buildOutboxRows, type OutboxEnvelopeEvent } from '@auth/infra/outbox';
import { Topics } from '@auth/contracts';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';

/** Domain event name -> integration topic, per the contract. */
export const TOPIC_BY_EVENT: Readonly<Record<string, string>> = {
  'mfa.enrolled': Topics.MFA_ENROLLED,
  'mfa.verified': Topics.MFA_VERIFIED,
  'mfa.failed': Topics.MFA_FAILED,
  'mfa.disabled': Topics.MFA_DISABLED,
};

const FORBIDDEN_PAYLOAD_KEY = /secret|cipher|plaintext|digest|otp|^code$|recoverycode/i;

/** The shape `buildOutboxRows` needs; narrower than `IDomainEvent` on purpose. */
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

export async function enqueueEvents(
  client: PrismaClient,
  events: readonly EnqueueableEvent[],
  options: EnqueueOptions,
): Promise<void> {
  const rows = buildOutboxRows(events, {
    logger: options.logger,
    getTopic: (event) => TOPIC_BY_EVENT[event.eventType] ?? null,
    forbiddenPayloadKey: FORBIDDEN_PAYLOAD_KEY,
    partitionKey: options.partitionKey,
    onRefusal: (event, droppedKeys) => {
      options.logger.error(
        `Refusing to publish "${event.eventType}": payload carries ${droppedKeys.join(', ')}`,
      );
    },
  });
  if (rows.length === 0) return;

  await client.outbox_events.createMany({
    data: rows as unknown as Prisma.outbox_eventsCreateManyInput[],
    skipDuplicates: true,
  });
}
