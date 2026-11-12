/**
 * @fileoverview The in-process half of the event pipeline: the concrete {@link IDomainEventBus}.
 *
 * Domain events are statements to this service's own collaborators, so they travel on the
 * CQRS `EventBus` every module already boots — never on Kafka. That is the whole point of
 * the two-bus split: a projection or cache invalidation must not start depending on broker
 * availability, and a consumer in another process must not see aggregate internals.
 *
 * Every published fact is logged here, which makes the bus the single observation point for
 * "what did this service do" without a handler existing in each service.
 */

import { Injectable, Logger } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import type { IDomainEvent, IDomainEventBus } from '@auth/core';

/** DI token for the in-process bus; the core port {@link IDomainEventBus} has no token of its own. */
export const DOMAIN_EVENT_BUS = Symbol('DOMAIN_EVENT_BUS');

@Injectable()
export class CqrsDomainEventBus implements IDomainEventBus {
  private readonly logger = new Logger(CqrsDomainEventBus.name);

  constructor(private readonly cqrs: EventBus) {}

  async publish(event: IDomainEvent): Promise<void> {
    await this.publishAll([event]);
  }

  /**
   * Hands the facts to the CQRS bus.
   *
   * @remarks Handler failures never reject: `EventBus` routes them to its
   * `UnhandledExceptionBus` instead. In-process delivery is best-effort by contract, so a
   * broken handler must not turn a committed command into a failed one.
   */
  async publishAll(events: readonly IDomainEvent[]): Promise<void> {
    if (events.length === 0) return;

    for (const event of events) {
      this.logger.log(describe(event));
    }

    this.cqrs.publishAll([...events]);
  }
}

function describe(event: IDomainEvent): string {
  const correlation = event.correlationId ? ` trace=${event.correlationId}` : '';
  return `${event.eventType} ${event.aggregateType}/${event.aggregateId} v${event.version}${correlation}`;
}
