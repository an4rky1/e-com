import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EVENT_SCHEMA_VERSION,
  type IntegrationEvent,
} from '@auth/contracts';
import type { IIntegrationEventPublisher } from '@auth/ddd-core';
import type { OutboxRepositoryPort, NewOutboxEntry } from './outbox.repository.port';
import { OUTBOX_CONFIG, OUTBOX_REPOSITORY, type OutboxConfig } from './outbox.tokens';

export interface PublishOptions {
  /** Id of the entity whose ordering matters; also the Kafka partition key. */
  partitionKey?: string;
  aggregateId?: string;
  aggregateType?: string;
  traceId?: string;
  /**
   * Stable identity of the fact. Defaults to `<type>:<aggregateId>`, which is what makes a
   * retried command a no-op instead of a duplicate event.
   */
  dedupKey?: string;
}

/**
 * Writes outbound events inside the caller's transaction.
 *
 * @remarks This is the seam the whole transactional-outbox guarantee rests on. It writes a
 * *row*, never a Kafka message. Producing directly after `save()` leaves a window — between
 * the commit and the send — in which the state is durable but the event is gone, and no
 * consumer ever hears about the change.
 */
@Injectable()
export class OutboxService implements IIntegrationEventPublisher {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    @Inject(OUTBOX_REPOSITORY) private readonly repository: OutboxRepositoryPort,
    @Inject(OUTBOX_CONFIG) private readonly config: OutboxConfig,
  ) {}

  async publish<TPayload>(
    topic: string,
    payload: TPayload,
    options: PublishOptions = {},
  ): Promise<void> {
    const entry = this.toEntry(topic, payload, options);
    await this.repository.append(entry);
  }

  /**
   * Appends several payloads to one topic in a single round trip.
   *
   * @remarks Batched because the hot path — registering a user writes the row and its event
   * together — would otherwise pay one insert round trip per event inside the transaction.
   */
  async publishAll<TPayload>(
    topic: string,
    payloads: readonly TPayload[],
    options: PublishOptions = {},
  ): Promise<void> {
    if (payloads.length === 0) return;
    await this.repository.appendMany(
      payloads.map((payload) => this.toEntry(topic, payload, options)),
    );
  }

  private toEntry<TPayload>(
    topic: string,
    payload: TPayload,
    options: PublishOptions,
  ): NewOutboxEntry {
    const aggregateId = options.aggregateId ?? options.partitionKey ?? '';
    const aggregateType = options.aggregateType ?? topic.split('.')[1] ?? 'unknown';
    const eventType = eventTypeOf(topic);

    // `trace_id` is NOT NULL in the schema, so a missing one is filled rather than skipped:
    // an untraceable event is far harder to debug than a synthetic root id.
    const traceId = options.traceId ?? crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const now = new Date();

    const event: IntegrationEvent<TPayload> = {
      eventId,
      type: topic,
      schemaVersion: EVENT_SCHEMA_VERSION,
      occurredAt: now.toISOString(),
      aggregateId,
      aggregateType,
      partitionKey: options.partitionKey ?? aggregateId,
      traceId,
      payload,
    };

    return {
      id: eventId,
      type: eventType,
      aggregateType,
      aggregateId,
      topic,
      payload: JSON.stringify(event),
      dedupKey: options.dedupKey ?? `${eventType}:${aggregateId}`,
      traceId,
      nextAttemptAt: now,
    };
  }

  /** Exposed so a relay can report backlog without reaching into the repository. */
  get settings(): OutboxConfig {
    return this.config;
  }
}

/**
 * Derives the event name from a topic.
 *
 * @remarks `platform.user.registered.v1` -> `user.registered`. Keeping the stable name in
 * `type` while the version lives in the topic suffix is what lets `dedup_key` uniqueness
 * survive a v2 topic: re-running the same fact on v2 still collides on the same key.
 */
function eventTypeOf(topic: string): string {
  return topic
    .replace(/^platform\./, '')
    .replace(/\.v\d+$/, '');
}