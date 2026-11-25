/**
 * @fileoverview The one place domain events become `outbox_events` rows.
 *
 * @remarks Every write in this service goes through here so the transactional-outbox
 * guarantee has a single implementation: the rows go in with the state change, or they do
 * not go in at all. Two call sites each open-coding this is how one of them ends up publishing
 * after the commit, which is precisely the window the pattern exists to close.
 *
 * @remarks The envelope itself is built by `buildOutboxRows` in `@auth/infra/outbox`; this
 * file supplies the event-name -> topic map and the payload guard.
 */
import type { Logger } from '@nestjs/common';
import { buildOutboxRows } from '@auth/infra/outbox';
import type { IDomainEvent } from '@auth/core';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';

const FORBIDDEN_PAYLOAD_KEY = /token|secret|password|plaintext|digest|^key$|^credential$/i;

export interface EnqueueEventsOptions {
  readonly client: PrismaClient;
  readonly logger: Logger;
  /** Domain event name -> integration topic. */
  readonly topics: Readonly<Record<string, string>>;
}

export async function enqueueEvents(
  events: readonly IDomainEvent[],
  options: EnqueueEventsOptions,
): Promise<void> {
  const rows = buildOutboxRows(events, {
    logger: options.logger,
    getTopic: (event) => options.topics[event.eventType] ?? null,
    forbiddenPayloadKey: FORBIDDEN_PAYLOAD_KEY,
  });
  if (rows.length === 0) return;

  await options.client.outbox_events.createMany({
    data: rows as unknown as Prisma.outbox_eventsCreateManyInput[],
    skipDuplicates: true,
  });
}
