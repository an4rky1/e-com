/**
 * @fileoverview The `outbox_events` rows this service writes beside its state changes.
 *
 * @remarks The transactional-outbox guarantee has three parts, and each is asserted here:
 * the rows go in with the mutation, `skipDuplicates` makes a retried command a no-op, and
 * the payload can never carry a credential.
 *
 * @remarks What is billing-specific — and therefore the reason this suite exists next to
 * the inventory and api-key ones — is the **versioning**. `dedup_key` is
 * `<type>:<aggregateId>:<version>`, every `aggregateId` is the **order** (a partition key
 * of payment id would scatter one order's decisions across partitions), and the versions
 * come from two different counters: the payment's write counter, which advances on each
 * refund, and the invoice's, which advances when its figures are rewritten. Each event
 * family states its version rule here, because a version that does not advance is a
 * silent duplicate announcement and one that advances twice is a gap no consumer sees.
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
import { Payment } from '../src/domain/payment.entity';
import { Invoice } from '../src/domain/invoice.entity';
import { computeTotals } from '../src/domain/totals';
import { ORDER_ID, PAYMENT_ID } from './support/fakes';

const T0 = new Date('2026-01-01T00:00:00.000Z');

/** The `payment.*` / `invoice.*` -> topic mapping the real repository uses. */
const TOPICS: Readonly<Record<string, string>> = {
  'payment.succeeded': Topics.PAYMENT_SUCCEEDED,
  'payment.failed': Topics.PAYMENT_FAILED,
  'payment.refunded': Topics.PAYMENT_REFUNDED,
  'invoice.issued': Topics.INVOICE_ISSUED,
};

const fakeLogger = (): Logger =>
  ({ warn: jest.fn(), log: jest.fn(), error: jest.fn() }) as unknown as Logger;

interface Captured {
  readonly data: Record<string, unknown>[];
  readonly skipDuplicates: boolean;
}

class StubClient {
  readonly captures: Captured[] = [];

  readonly outbox_events = {
    createMany: async (args: { data: Record<string, unknown>[]; skipDuplicates?: boolean }) => {
      this.captures.push({ data: args.data, skipDuplicates: args.skipDuplicates === true });
      return { count: args.data.length };
    },
  };
}

const rows = (client: StubClient): Record<string, unknown>[] =>
  client.captures.flatMap((capture) => capture.data);

/** A settled payment with one buffered `payment.succeeded`, plus its bill. */
const settledCharge = (): { payment: Payment; invoice: Invoice } => {
  const payment = Payment.fromProvider({
    id: PAYMENT_ID,
    orderId: ORDER_ID,
    idempotencyKey: `order:${ORDER_ID}:charge:1`,
    amountMinor: 2_380,
    currency: 'EUR',
    status: 'succeeded',
    provider: 'fake',
    providerRef: 'psp_ch_1',
    customerId: 'customer-1',
    now: T0,
  });
  const invoice = Invoice.issue({
    orderId: ORDER_ID,
    totals: computeTotals({
      lines: [{ sku: 'SKU-1', quantity: 2, unitPriceMinor: 1_000 }],
      currency: 'EUR',
      taxRateBps: 1_900,
    }),
    status: 'paid',
    country: 'DE',
    now: T0,
  });
  return { payment, invoice };
};

describe('enqueueEvents', () => {
  it('writes one row per event, batched into a single createMany', async () => {
    const client = new StubClient();
    const { payment, invoice } = settledCharge();

    await enqueueEvents([...payment.clearDomainEvents(), ...invoice.clearDomainEvents()], {
      client: client as unknown as PrismaClient,
      logger: fakeLogger(),
      topics: TOPICS,
    });

    expect(client.captures).toHaveLength(1);
    expect(client.captures[0].skipDuplicates).toBe(true);
    expect(rows(client).map((row) => row.type)).toEqual([
      'payment.succeeded',
      'invoice.issued',
    ]);
  });

  it('keys every row by the order, with the version each family counts', async () => {
    const client = new StubClient();
    const { payment } = settledCharge();
    payment.clearDomainEvents();

    // A refund advances the payment's own write counter: version 1 was the settlement,
    // version 2 is this refund, and both announcements name the order.
    payment.refund(380, T0);
    await enqueueEvents(payment.clearDomainEvents(), {
      client: client as unknown as PrismaClient,
      logger: fakeLogger(),
      topics: TOPICS,
    });

    const [row] = rows(client);
    expect(row).toMatchObject({
      type: 'payment.refunded',
      aggregate_type: 'Payment',
      aggregate_id: ORDER_ID,
      dedup_key: `payment.refunded:${ORDER_ID}:2`,
      topic: Topics.PAYMENT_REFUNDED,
      status: 'pending',
      attempts: 0,
      trace_id: expect.any(String),
    });
  });

  it('wraps each payload in the integration envelope', async () => {
    const client = new StubClient();
    const { payment } = settledCharge();

    await enqueueEvents(payment.clearDomainEvents(), {
      client: client as unknown as PrismaClient,
      logger: fakeLogger(),
      topics: TOPICS,
    });

    const [row] = rows(client);
    const envelope = row['payload'] as Record<string, unknown>;
    expect(envelope).toMatchObject({
      type: Topics.PAYMENT_SUCCEEDED,
      schemaVersion: EVENT_SCHEMA_VERSION,
      aggregateId: ORDER_ID,
      aggregateType: 'Payment',
      partitionKey: ORDER_ID,
      // The event's own clock, not the aggregate's: `occurredAt` is stamped when the
      // fact is announced.
      occurredAt: expect.any(String),
    });
    expect(envelope['payload']).toMatchObject({
      paymentId: PAYMENT_ID,
      orderId: ORDER_ID,
      amountMinor: 2_380,
      status: 'succeeded',
    });
    // The ids must survive: a consumer that cannot tell which payment this is cannot
    // act on it, and the sanitiser is anchored so they do.
    expect(row['id']).toBe(envelope['eventId']);
  });

  it('skips an unmapped event with a warning instead of rolling back the write', async () => {
    const client = new StubClient();
    const logger = fakeLogger();
    const payment = Payment.fromProvider({
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      idempotencyKey: `order:${ORDER_ID}:charge:1`,
      amountMinor: 100,
      currency: 'EUR',
      status: 'succeeded',
      provider: 'fake',
      customerId: 'customer-1',
      now: T0,
    });
    const orphan = {
      ...payment.clearDomainEvents()[0],
      eventType: 'payment.exploded',
    } as IDomainEvent;

    await enqueueEvents([orphan], {
      client: client as unknown as PrismaClient,
      logger,
      topics: TOPICS,
    });

    expect(client.captures).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith('No topic mapped for domain event "payment.exploded"');
  });

  it('does nothing at all for an empty batch', async () => {
    const client = new StubClient();

    await enqueueEvents([], {
      client: client as unknown as PrismaClient,
      logger: fakeLogger(),
      topics: TOPICS,
    });

    expect(client.captures).toHaveLength(0);
  });

  it('refuses a payload that carries a credential, inside the transaction', async () => {
    const client = new StubClient();
    const payment = Payment.fromProvider({
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      idempotencyKey: `order:${ORDER_ID}:charge:1`,
      amountMinor: 100,
      currency: 'EUR',
      status: 'succeeded',
      provider: 'fake',
      customerId: 'customer-1',
      now: T0,
    });
    const [event] = payment.clearDomainEvents();
    // A later edit that adds "just this one field" for a consumer must not ship a
    // payment-method token to a topic with retention measured in days.
    (event as unknown as { payload: Record<string, unknown> }).payload['paymentMethodToken'] =
      'pm_card_secret';

    await expect(
      enqueueEvents([event], {
        client: client as unknown as PrismaClient,
        logger: fakeLogger(),
        topics: TOPICS,
      }),
    ).rejects.toThrow(/paymentMethodToken/);
    expect(client.captures).toHaveLength(0);
  });

  it('reads a payloadless event as an empty object rather than crashing', async () => {
    const client = new StubClient();
    const bare = {
      eventId: crypto.randomUUID(),
      eventType: 'invoice.issued',
      aggregateType: 'Invoice',
      aggregateId: ORDER_ID,
      version: 1,
      occurredAt: T0,
      correlationId: null,
    } as unknown as IDomainEvent;

    await enqueueEvents([bare], {
      client: client as unknown as PrismaClient,
      logger: fakeLogger(),
      topics: TOPICS,
    });

    const [row] = rows(client);
    expect((row['payload'] as Record<string, unknown>)['payload']).toEqual({});
  });

  it('uses the correlation id as the trace when one exists', async () => {
    const client = new StubClient();
    const { payment } = settledCharge();
    const [event] = payment.clearDomainEvents();
    (event as unknown as { correlationId: string | null }).correlationId = 'trace-abc';

    await enqueueEvents([event], {
      client: client as unknown as PrismaClient,
      logger: fakeLogger(),
      topics: TOPICS,
    });

    expect(rows(client)[0]['trace_id']).toBe('trace-abc');
  });
});
