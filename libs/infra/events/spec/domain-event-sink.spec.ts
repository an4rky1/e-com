/**
 * @fileoverview The split point: state + integration rows in one transaction, in-process
 * dispatch after the commit.
 *
 * @remarks No database. What is being asserted — which events reach which plane, in what
 * order, and what a refusal does — is fully determined before a connection is involved; the
 * transaction runner is a two-line fake that records the sequence.
 */

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Topics } from '@auth/contracts';
import type { IDomainEvent, IDomainEventBus } from '@auth/core';
import type { OutboxService } from '@auth/infra/outbox';
import {
  classify,
  DomainEventSink,
  type EventRegistry,
  type TransactionRunner,
} from '../src';

// ---- fixtures -------------------------------------------------------------------

interface FakeEvent extends IDomainEvent {
  readonly payload?: Record<string, unknown>;
}

const eventOf = (overrides: Partial<FakeEvent> = {}): FakeEvent => ({
  eventId: '11111111-1111-4111-8111-111111111111',
  aggregateId: 'user-1',
  aggregateType: 'User',
  eventType: 'user.registered',
  occurredAt: new Date('2023-11-14T22:13:20.000Z'),
  version: 3,
  correlationId: 'trace-1',
  payload: { email: 'a@b.invalid' },
  ...overrides,
});

const registryOf = (overrides: Partial<EventRegistry> = {}): EventRegistry => ({
  integration: {
    'user.registered': { topic: Topics.USER_REGISTERED },
    'user.internal_thing': {
      topic: 'platform.user.internal_thing.v1',
      toPayload: (event) => ({ only: event.aggregateId }),
      partitionKey: () => 'fixed-partition',
    },
  },
  internal: ['user.activated'],
  ...overrides,
});

interface Fakes {
  readonly sequence: string[];
  readonly published: { topic: string; payload: Record<string, unknown>; options: Record<string, unknown> }[];
  readonly bus: IDomainEventBus;
  readonly uow: TransactionRunner<object>;
  readonly sink: DomainEventSink;
  readonly busDispatch: jest.Mock;
}

const fakesOf = (registry: EventRegistry = registryOf()): Fakes => {
  const sequence: string[] = [];
  const published: Fakes['published'] = [];
  const busDispatch = jest.fn(async () => {
    sequence.push('dispatch');
  });

  const outbox = {
    publish: async (
      topic: string,
      payload: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => {
      sequence.push('outbox');
      published.push({ topic, payload, options });
    },
  } as unknown as OutboxService;

  const bus = { publishAll: busDispatch, publish: jest.fn() } as unknown as IDomainEventBus;

  const uow: TransactionRunner<object> = {
    runInTransaction: async (fn) => {
      sequence.push('tx:start');
      try {
        return await fn({ name: 'transaction-client' });
      } finally {
        sequence.push('tx:end');
      }
    },
  };

  return {
    sequence,
    published,
    bus,
    uow,
    busDispatch,
    sink: new DomainEventSink(bus, outbox, registry),
  };
};

// ---- registry classification ------------------------------------------------------

describe('classify', () => {
  it('reports integration, internal and unclassified distinctly', () => {
    const registry = registryOf();

    expect(classify(registry, 'user.registered').kind).toBe('integration');
    expect(classify(registry, 'user.activated').kind).toBe('internal');
    expect(classify(registry, 'user.mystery').kind).toBe('unclassified');
  });
});

// ---- the sink ---------------------------------------------------------------------

describe('DomainEventSink', () => {
  it('writes the integration row inside the transaction and dispatches after it', async () => {
    const fakes = fakesOf();

    await fakes.sink.run(fakes.uow, [eventOf()], async () => {
      fakes.sequence.push('work');
    });

    expect(fakes.sequence).toEqual(['tx:start', 'work', 'outbox', 'tx:end', 'dispatch']);
  });

  it('addresses the envelope with dedup key, partition key and trace id', async () => {
    const fakes = fakesOf();

    await fakes.sink.run(fakes.uow, [eventOf()], async () => undefined);

    expect(fakes.published).toHaveLength(1);
    expect(fakes.published[0]).toMatchObject({
      topic: Topics.USER_REGISTERED,
      payload: { email: 'a@b.invalid' },
      options: {
        aggregateId: 'user-1',
        aggregateType: 'User',
        partitionKey: 'user-1',
        dedupKey: 'user.registered:user-1:3',
        traceId: 'trace-1',
      },
    });
  });

  it('honours a route-level payload mapper and partition key', async () => {
    const fakes = fakesOf();

    await fakes.sink.run(fakes.uow, [eventOf({ eventType: 'user.internal_thing' })], async () => undefined);

    expect(fakes.published[0]).toMatchObject({
      payload: { only: 'user-1' },
      options: { partitionKey: 'fixed-partition' },
    });
  });

  it('keeps an internal event out of the outbox but still dispatches it in-process', async () => {
    const fakes = fakesOf();

    await fakes.sink.run(fakes.uow, [eventOf({ eventType: 'user.activated' })], async () => undefined);

    expect(fakes.published).toHaveLength(0);
    expect(fakes.busDispatch).toHaveBeenCalledWith([
      expect.objectContaining({ eventType: 'user.activated' }),
    ]);
  });

  it('warns about an unclassified event instead of failing the command', async () => {
    const fakes = fakesOf();
    const warn = jest.spyOn(Logger.prototype, 'warn');

    await expect(
      fakes.sink.run(fakes.uow, [eventOf({ eventType: 'user.mystery' })], async () => undefined),
    ).resolves.toBeUndefined();

    expect(fakes.published).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('user.mystery'));
    warn.mockRestore();
  });

  it('lets a refusing guard abort the transaction and skip dispatch', async () => {
    const fakes = fakesOf(
      registryOf({
        guardPayload: (payload) => {
          if ('email' in payload) throw new Error('refusing to publish: may be a secret');
        },
      }),
    );

    await expect(fakes.sink.run(fakes.uow, [eventOf()], async () => undefined)).rejects.toThrow(
      /refusing to publish/,
    );

    expect(fakes.published).toHaveLength(0);
    expect(fakes.busDispatch).not.toHaveBeenCalled();
    // The runner's own teardown still ran; the sink must not swallow the refusal.
    expect(fakes.sequence).toEqual(['tx:start', 'tx:end']);
  });

  it('swallows an in-process dispatch failure: the state is already committed', async () => {
    const fakes = fakesOf();
    fakes.busDispatch.mockRejectedValueOnce(new Error('handler exploded'));

    await expect(fakes.sink.run(fakes.uow, [eventOf()], async () => undefined)).resolves.toBeUndefined();

    expect(fakes.published).toHaveLength(1);
  });

  it('does not enqueue or dispatch when there are no events', async () => {
    const fakes = fakesOf();

    await fakes.sink.run(fakes.uow, [], async () => {
      fakes.sequence.push('work');
    });

    expect(fakes.sequence).toEqual(['tx:start', 'work', 'tx:end']);
    expect(fakes.busDispatch).not.toHaveBeenCalled();
  });
});
