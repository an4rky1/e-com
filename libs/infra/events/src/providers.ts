/**
 * @fileoverview Provider wiring every domain module adds to assemble the event pipeline.
 *
 * A helper rather than a dynamic module on purpose: the sink needs `OutboxService` (exported
 * by the already-global outbox module) and the bus needs the `EventBus` that
 * `CqrsModule.forRoot()` puts in the importing module. A nested dynamic module could not see
 * either without re-importing them under different identities, while four lines inside the
 * module factory that already registers handlers resolve both unambiguously.
 */

import { type Provider } from '@nestjs/common';
import type { IDomainEventBus } from '@auth/core';
import { OutboxService } from '@auth/infra/outbox';
import { CqrsDomainEventBus, DOMAIN_EVENT_BUS } from './domain-event-bus';
import type { EventRegistry } from './domain-event-registry';
import { DomainEventSink, DOMAIN_EVENT_SINK } from './domain-event-sink';

/** Providers a service's module factory must spread into its own `providers`. */
export function domainEventProviders(registry: EventRegistry): Provider[] {
  return [
    { provide: DOMAIN_EVENT_BUS, useClass: CqrsDomainEventBus },
    {
      provide: DOMAIN_EVENT_SINK,
      useFactory: (bus: IDomainEventBus, outbox: OutboxService) =>
        new DomainEventSink(bus, outbox, registry),
      inject: [DOMAIN_EVENT_BUS, OutboxService],
    },
  ];
}
