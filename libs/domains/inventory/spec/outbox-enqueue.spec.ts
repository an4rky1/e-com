/**
 * @fileoverview The `outbox_events` rows this service writes beside its state changes.
 *
 * @remarks The transactional-outbox guarantee has three parts, and each is asserted here:
 * the rows go in with the mutation, `skipDuplicates` makes a retried command a no-op, and
 * the payload can never carry a credential.
 *
 * @remarks What is inventory-specific — and therefore the reason this suite exists next to
 * the api-key one — is the **versioning**. `dedup_key` is `<type>:<aggregateId>:<version>`,
 * and a multi-line reserve shares one `aggregateId` (the order): if every line took the
 * reservation's own version, the first row would land and `createMany(skipDuplicates)`
 * would silently swallow the rest, leaving the order side told it holds one line of the
 * three it was granted. Each event family states its version rule here.
 *
 * @remarks No database. The client is a two-line stub that captures `createMany`, because
 * the question being asked — "what would be written?" — is fully determined before a
 * connection is involved.
 */

import 'reflect-metadata';
import type { Logger } from '@nestjs/common';
import type { IDomainEvent } from '@auth/core';
import { EVENT_SCHEMA_VERSION, Topics } from '@auth/contracts';
import type { PrismaClient } from '../src/generated/prisma/client';
import { enqueueEvents } from '../src/infrastructure/persistence/outbox-enqueue';
import { Reservation } from '../src/domain/reservation.entity';
import { StockLevel } from '../src/domain/stock-level.aggregate';
import {
  stockRejectedEvents,
  stockReleasedEvent,
} from '../src/domain/inventory.events';
import { ORDER_ID, WAREHOUSE } from './support/fakes';

const TOPICS = {
  'stock.reserved': Topics.STOCK_RESERVED,
  'stock.rejected': Topics.STOCK_REJECTED,
  'stock.released': Topics.STOCK_RELEASED,
  'stock.changed': Topics.STOCK_CHANGED,
};

const fakeLogger = (): Logger =>
  ({ warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) as unknown as Logger;

/** Captures what would have been written, without a database. */
const captureOutbox = (): {
  client: PrismaClient;
  rows: () => Record<string, unknown>[];
  calls: () => { data: Record<string, unknown>[]; skipDuplicates?: boolean }[];
} => {
  const written: Record<string, unknown>[] = [];
  const calls: { data: Record<string, unknown>[]; skipDuplicates?: boolean }[] = [];

  const client = {
    outbox_events: {
      createMany: async (args: {
        data: Record<string, unknown>[];
        skipDuplicates?: boolean;
      }) => {
        calls.push(args);
        written.push(...args.data);
        return { count: args.data.length };
      },
    },
  } as unknown as PrismaClient;

  return { client, rows: () => written, calls: () => calls };
};

/** A hold over three SKUs, announced exactly the way the repository announces it. */
const reserveBatch = (skus: readonly string[]): readonly IDomainEvent[] => {
  const reservation = Reservation.create({
    orderId: ORDER_ID,
    warehouseId: WAREHOUSE,
    lines: skus.map((sku, index) => ({ sku, qty: index + 1 })),
  });
  reservation.announceReserved();
  return reservation.clearDomainEvents();
};

describe('outbox enqueue', () => {
  it('writes one row per held line, each on the reserved topic', async () => {
    const { client, rows } = captureOutbox();

    await enqueueEvents(reserveBatch(['SKU-1', 'SKU-2', 'SKU-3']), {
      client,
      logger: fakeLogger(),
      topics: TOPICS,
    });

    expect(rows()).toHaveLength(3);
    expect(rows().every((row) => row.topic === Topics.STOCK_RESERVED)).toBe(true);
    expect(rows().every((row) => row.status === 'pending')).toBe(true);
    expect(rows().every((row) => row.attempts === 0)).toBe(true);
    expect((rows()[0].payload as Record<string, unknown>).schemaVersion).toBe(
      EVENT_SCHEMA_VERSION,
    );
  });

  it('indexes a batch from one, so no line is swallowed by dedup', async () => {
    const { client, rows, calls } = captureOutbox();

    await enqueueEvents(reserveBatch(['SKU-1', 'SKU-2', 'SKU-3']), {
      client,
      logger: fakeLogger(),
      topics: TOPICS,
    });

    // One round trip for three rows: a reserve is one transaction and one `createMany`.
    expect(calls()).toHaveLength(1);
    expect(rows().map((row) => row.dedup_key)).toEqual([
      `stock.reserved:${ORDER_ID}:1`,
      `stock.reserved:${ORDER_ID}:2`,
      `stock.reserved:${ORDER_ID}:3`,
    ]);
    expect(new Set(rows().map((row) => row.dedup_key)).size).toBe(3);
    expect(rows().every((row) => row.aggregate_id === ORDER_ID)).toBe(true);
  });

  it('keys a rejection the same way, for a batch that wrote no reservation', async () => {
    const { client, rows } = captureOutbox();

    await enqueueEvents(
      stockRejectedEvents({
        orderId: ORDER_ID,
        warehouseId: WAREHOUSE,
        lines: [
          { sku: 'SKU-1', qty: 4 },
          { sku: 'SKU-2', qty: 1 },
        ],
      }),
      { client, logger: fakeLogger(), topics: TOPICS },
    );

    // Reserved and rejected never coexist in one transaction, so their index sequences
    // cannot collide — and the `type` half of the unique index separates them anyway.
    expect(rows().map((row) => row.dedup_key)).toEqual([
      `stock.rejected:${ORDER_ID}:1`,
      `stock.rejected:${ORDER_ID}:2`,
    ]);
    expect(rows().every((row) => row.topic === Topics.STOCK_REJECTED)).toBe(true);
    expect((rows()[0].payload as { payload: { reason: string } }).payload.reason).toBe(
      'insufficient_stock',
    );
  });

  it('keys a release at version one: the hold is terminal, so there is no second one', async () => {
    const { client, rows } = captureOutbox();

    await enqueueEvents(
      [stockReleasedEvent({ orderId: ORDER_ID, warehouseId: WAREHOUSE, lines: 3 })],
      { client, logger: fakeLogger(), topics: TOPICS },
    );

    expect(rows()[0].dedup_key).toBe(`stock.released:${ORDER_ID}:1`);
    expect(rows()[0].topic).toBe(Topics.STOCK_RELEASED);
  });

  it('keys a stock.changed by sku and the row version, not by an order', async () => {
    const level = StockLevel.create({
      sku: 'SKU-1',
      warehouseId: WAREHOUSE,
      safety: 0,
      id: '5f0e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
    });
    level.adjust(10);
    level.adjust(-1);
    const { client, rows } = captureOutbox();

    await enqueueEvents(level.clearDomainEvents(), {
      client,
      logger: fakeLogger(),
      topics: TOPICS,
    });

    // The row's own write counter: two corrections of one SKU must produce two keys, or
    // the second announcement is dropped and a consumer sees a stock level that never
    // moved.
    expect(rows().map((row) => row.dedup_key)).toEqual([
      'stock.changed:SKU-1:2',
      'stock.changed:SKU-1:3',
    ]);
    expect(rows().every((row) => row.aggregate_id === 'SKU-1')).toBe(true);
    expect(rows().every((row) => row.aggregate_type === 'StockLevel')).toBe(true);
  });

  it('asks for skipDuplicates, which is what makes a retried command a no-op', async () => {
    const { client, calls } = captureOutbox();

    await enqueueEvents(reserveBatch(['SKU-1']), {
      client,
      logger: fakeLogger(),
      topics: TOPICS,
    });

    expect(calls()[0]?.skipDuplicates).toBe(true);
  });

  it('never carries a credential-shaped key on any topic', async () => {
    const events: IDomainEvent[] = [
      ...reserveBatch(['SKU-1']),
      ...stockRejectedEvents({
        orderId: ORDER_ID,
        warehouseId: WAREHOUSE,
        lines: [{ sku: 'SKU-2', qty: 1 }],
      }),
      stockReleasedEvent({ orderId: ORDER_ID, warehouseId: WAREHOUSE, lines: 1 }),
    ];
    const { client, rows } = captureOutbox();

    await enqueueEvents(events, { client, logger: fakeLogger(), topics: TOPICS });

    const published = JSON.stringify(rows());
    expect(published).not.toMatch(/token|secret|password|plaintext|digest/i);
    // The identifiers a consumer needs must survive the check.
    expect(published).toContain(ORDER_ID);
    expect(published).toContain('SKU-1');
  });

  it('refuses to publish a payload that carries something secret-shaped', async () => {
    const { client, rows } = captureOutbox();
    const smuggled = {
      ...reserveBatch(['SKU-1'])[0],
      payload: { orderId: ORDER_ID, token: 'pm_card_4242' },
    } as IDomainEvent;

    // Fails inside the transaction, so stock is never moved *and* announced under a
    // payload nobody should have seen.
    await expect(
      enqueueEvents([smuggled], { client, logger: fakeLogger(), topics: TOPICS }),
    ).rejects.toThrow(/refusing to publish/i);

    expect(rows()).toHaveLength(0);
  });

  it('skips an event with no topic, and says which one', async () => {
    const { client, rows } = captureOutbox();
    const logger = fakeLogger();
    const unmapped = {
      ...reserveBatch(['SKU-1'])[0],
      eventType: 'stock.split',
    } as IDomainEvent;

    await enqueueEvents([unmapped], { client, logger, topics: TOPICS });

    // An unmapped event is a build-time oversight. Failing the transaction would roll
    // back a perfectly valid state change over a topic nobody subscribes to yet.
    expect(rows()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('stock.split'));
  });

  it('writes nothing at all when there are no events', async () => {
    const { client, rows, calls } = captureOutbox();

    await enqueueEvents([], { client, logger: fakeLogger(), topics: TOPICS });

    expect(rows()).toHaveLength(0);
    expect(calls()).toHaveLength(0);
  });

  it('handles an event that carries no payload at all', async () => {
    const { client, rows } = captureOutbox();
    const bare = {
      eventId: '11111111-1111-4111-8111-111111111111',
      aggregateId: ORDER_ID,
      aggregateType: 'Reservation',
      eventType: 'stock.released',
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
      version: 1,
    } as IDomainEvent;

    await enqueueEvents([bare], { client, logger: fakeLogger(), topics: TOPICS });

    expect((rows()[0].payload as Record<string, unknown>).payload).toEqual({});
  });
});
