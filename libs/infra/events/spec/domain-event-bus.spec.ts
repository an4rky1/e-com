/**
 * @fileoverview The in-process bus: every fact logged, every fact handed to the CQRS bus,
 * nothing rejected to the caller.
 */

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import type { IDomainEvent } from '@auth/core';
import { CqrsDomainEventBus } from '../src';

const eventOf = (overrides: Partial<IDomainEvent> = {}): IDomainEvent => ({
  eventId: '11111111-1111-4111-8111-111111111111',
  aggregateId: 'user-1',
  aggregateType: 'User',
  eventType: 'user.registered',
  occurredAt: new Date('2023-11-14T22:13:20.000Z'),
  version: 3,
  correlationId: 'trace-1',
  ...overrides,
});

describe('CqrsDomainEventBus', () => {
  it('logs each fact with its identity and trace, then delegates to the CQRS bus', async () => {
    const cqrs = { publishAll: jest.fn() } as unknown as EventBus;
    const log = jest.spyOn(Logger.prototype, 'log');
    const bus = new CqrsDomainEventBus(cqrs);

    await bus.publish(eventOf());

    expect(log).toHaveBeenCalledWith(
      'user.registered User/user-1 v3 trace=trace-1',
    );
    expect(cqrs.publishAll).toHaveBeenCalledWith([expect.objectContaining({ eventType: 'user.registered' })]);
    log.mockRestore();
  });

  it('publishes a batch through one delegation', async () => {
    const cqrs = { publishAll: jest.fn() } as unknown as EventBus;
    const bus = new CqrsDomainEventBus(cqrs);

    await bus.publishAll([eventOf(), eventOf({ eventType: 'user.deleted' })]);

    expect(cqrs.publishAll).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all for an empty batch', async () => {
    const cqrs = { publishAll: jest.fn() } as unknown as EventBus;
    const log = jest.spyOn(Logger.prototype, 'log');
    const bus = new CqrsDomainEventBus(cqrs);

    await bus.publishAll([]);

    expect(cqrs.publishAll).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
