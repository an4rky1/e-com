/**
 * @fileoverview `enqueueEvents` — the single place domain events become outbox rows.
 *
 * @remarks The dedup key is `<type>:<aggregateId>:<version>`: the aggregate's *event
 * version*, not a clock or a uuid. A retried command produces the same version, and the
 * unique index on `(dedup_key, type)` turns the second insert into a no-op. Getting that
 * wrong is how duplicate `order.created` messages appear on a topic.
 *
 * @remarks The credential guard throws rather than filters: a payload that *tried* to carry
 * a secret is a bug that has already been written, and quietly dropping the field would
 * leave a consumer missing data — which is how the same bug gets reintroduced.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { OrderCreated, OrderPaid, ORDER_AGGREGATE } from '../src/domain/order.aggregate';
import { enqueueEvents } from '../src/infrastructure/persistence/outbox-enqueue';

const TOPICS = {
  'order.created': 'platform.order.created.v1',
  'order.paid': 'platform.order.paid.v1',
} as const;

/** Minimal stand-in for the generated client's `outbox_events.createMany`. */
function recordingClient() {
  const calls: { data: unknown[]; skipDuplicates?: boolean }[] = [];
  return {
    calls,
    outbox_events: {
      createMany: async (args: { data: unknown[]; skipDuplicates?: boolean }) => {
        calls.push(args);
        return { count: args.data.length };
      },
    },
  };
}

const logger = new Logger('test');

describe('enqueueEvents', () => {
  it('writes one row per mapped event with the business dedup key', async () => {
    const client = recordingClient();
    const orderId = '0f1e2d3c-4b5a-4697-8899-aabbccddeeff';

    const created = new OrderCreated(
      orderId,
      {
        orderId,
        userId: 'u1',
        status: 'draft',
        currency: 'USD',
        totalMinor: 1000,
      },
      1,
    );

    await enqueueEvents([created], {
      client: client as never,
      logger,
      topics: TOPICS,
    });

    expect(client.calls).toHaveLength(1);
    const args = client.calls[0];
    expect(args.skipDuplicates).toBe(true);
    expect(args.data).toHaveLength(1);

    const row = args.data[0] as Record<string, unknown>;
    expect(row.type).toBe('order.created');
    expect(row.topic).toBe('platform.order.created.v1');
    expect(row.aggregate_id).toBe(orderId);
    expect(row.aggregate_type).toBe(ORDER_AGGREGATE);
    expect(row.dedup_key).toBe(`order.created:${orderId}:1`);
    expect(row.status).toBe('pending');
  });

  it('batches several events into a single createMany', async () => {
    const client = recordingClient();
    const orderId = '0f1e2d3c-4b5a-4697-8899-aabbccddeeff';

    const created = new OrderCreated(
      orderId,
      { orderId, userId: 'u1', status: 'draft', currency: 'USD', totalMinor: 1000 },
      1,
    );
    const paid = new OrderPaid(
      orderId,
      { orderId, userId: 'u1', status: 'paid', currency: 'USD', totalMinor: 1000, paymentId: 'p' },
      3,
    );

    await enqueueEvents([created, paid], {
      client: client as never,
      logger,
      topics: TOPICS,
    });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].data).toHaveLength(2);
    expect((client.calls[0].data[1] as { dedup_key: string }).dedup_key).toBe(
      `order.paid:${orderId}:3`,
    );
  });

  it('skips unmapped events with a warning instead of failing the transaction', async () => {
    const client = recordingClient();
    const warn = jest.spyOn(logger, 'warn').mockImplementation();

    const orphan = new OrderCreated(
      'id',
      { orderId: 'id', userId: 'u', status: 'draft', currency: 'USD', totalMinor: 1 },
      1,
    );
    // Force an unmapped type by overriding after construction.
    Object.defineProperty(orphan, 'eventType', { value: 'order.unmapped' });

    await enqueueEvents([orphan], {
      client: client as never,
      logger,
      topics: TOPICS,
    });

    expect(client.calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('order.unmapped'),
    );
    warn.mockRestore();
  });

  it('does nothing for an empty event list', async () => {
    const client = recordingClient();

    await enqueueEvents([], { client: client as never, logger, topics: TOPICS });

    expect(client.calls).toHaveLength(0);
  });

  it('refuses a payload that carries a credential-shaped key', async () => {
    const client = recordingClient();
    const evil = new OrderCreated(
      'id',
      {
        orderId: 'id',
        userId: 'u',
        status: 'draft',
        currency: 'USD',
        totalMinor: 1,
        // Smuggled field a future edit might add "just this once".
        payment_method_token: 'pm_secret',
      } as never,
      1,
    );

    await expect(
      enqueueEvents([evil], { client: client as never, logger, topics: TOPICS }),
    ).rejects.toThrow(/payment_method_token/);
    expect(client.calls).toHaveLength(0);
  });
});
