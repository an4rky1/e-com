/**
 * @fileoverview Event transport ports.
 *
 * Why two buses rather than one: domain events and integration events have different
 * delivery guarantees, different naming, and different failure modes. Merging them means a
 * handler that only needed to run in-process starts depending on broker availability.
 * {@link IDomainEventBus} is in-process and best-effort; {@link IIntegrationEventBus} is
 * durable and crosses the process boundary.
 */

import type { IDomainEvent } from '../events/domain-event';

export interface IDomainEventBus {
  publish(event: IDomainEvent): Promise<void>;
  publishAll(events: readonly IDomainEvent[]): Promise<void>;
}

export interface IIntegrationEventPublisher {
  /**
   * Hands a message to the durable transport.
   *
   * @remarks The outbox implements this by *writing a row*, not by producing to Kafka.
   * Calling the broker directly after a save leaves the window described in
   * {@link IRepository.save}.
   *
   * @param partitionKey - the id of the entity whose ordering matters. Two events for the
   * same aggregate must land on the same partition or concurrent state changes reorder.
   */
  publish<TPayload>(
    topic: string,
    payload: TPayload,
    options?: { partitionKey?: string; traceId?: string },
  ): Promise<void>;
}

export interface IIntegrationEventConsumer {
  subscribe<TPayload>(
    topic: string,
    handler: (payload: TPayload, meta: ConsumeMetadata) => Promise<void>,
  ): void;
}

export interface ConsumeMetadata {
  topic: string;
  partition: number;
  offset: string;
  traceId?: string;
  /** Present on messages re-delivered after a failed attempt. */
  attempt: number;
}