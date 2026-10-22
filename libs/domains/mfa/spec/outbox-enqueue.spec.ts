/**
 * @fileoverview The `outbox_events` rows this service writes beside its state changes.
 *
 * @remarks The transactional-outbox guarantee has three parts, and each is asserted here: the
 * row is written through the same client as the mutation, the dedup key makes a retried
 * command a no-op, and the payload can never carry a secret.
 *
 * @remarks No database. The client is a two-line stub that captures `createMany`, because the
 * question being asked — "what would be written?" — is fully determined before a connection
 * is involved.
 */

import 'reflect-metadata';
import type { Logger } from '@nestjs/common';
import { Topics } from '@auth/contracts';
import type { PrismaClient } from '../src/generated/prisma/client';
import {
  enqueueEvents,
  TOPIC_BY_EVENT,
  type EnqueueableEvent,
} from '../src/infrastructure/persistence/outbox-enqueue';

// ---- outbox --------------------------------------------------------------------

/** The three methods `enqueueEvents` actually calls. */
const logger = () =>
  ({
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as Logger & { warn: jest.Mock; error: jest.Mock };

let fakeLogger: ReturnType<typeof logger>;

const eventOf = (overrides: Partial<EnqueueableEvent> = {}): EnqueueableEvent => ({
  eventId: '11111111-1111-4111-8111-111111111111',
  aggregateId: '22222222-2222-4222-8222-222222222222',
  aggregateType: 'MfaFactor',
  eventType: 'mfa.verified',
  occurredAt: new Date('2023-11-14T22:13:20.000Z'),
  version: 7,
  payload: { userId: 'u1', method: 'totp' },
  ...overrides,
});

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

describe('outbox enqueue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fakeLogger = logger();
  });

  it('maps each event to its contract topic', () => {
    expect(TOPIC_BY_EVENT).toEqual({
      'mfa.enrolled': Topics.MFA_ENROLLED,
      'mfa.verified': Topics.MFA_VERIFIED,
      'mfa.failed': Topics.MFA_FAILED,
      'mfa.disabled': Topics.MFA_DISABLED,
    });
  });

  it('writes one row with a dedup key of type, aggregate and version', async () => {
    const { client, rows } = captureOutbox();
    const event = eventOf();

    await enqueueEvents(client, [event], {
      logger: fakeLogger,
      partitionKey: (candidate) => candidate.aggregateId,
    });

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      type: 'mfa.verified',
      topic: Topics.MFA_VERIFIED,
      aggregate_id: event.aggregateId,
      dedup_key: 'mfa.verified:22222222-2222-4222-8222-222222222222:7',
      status: 'pending',
      attempts: 0,
    });
  });

  it('asks for skipDuplicates, so a retried command cannot double-publish', async () => {
    const { client, calls } = captureOutbox();
    const event = eventOf();

    await enqueueEvents(client, [event], {
      logger: fakeLogger,
      partitionKey: (candidate) => candidate.aggregateId,
    });

    // The unique index on `(dedup_key, type)` is what turns the second insert of the same
    // fact into a no-op rather than a duplicate `mfa.verified`.
    expect(calls()[0]?.skipDuplicates).toBe(true);
    expect(calls()[0]?.data[0]?.dedup_key).toBe(
      `${event.eventType}:${event.aggregateId}:${event.version}`,
    );
  });

  it('refuses to publish a payload that carries a secret', async () => {
    const { client, rows } = captureOutbox();
    const withSecret = eventOf({
      payload: { userId: 'u1', secretCiphertext: 'v1.aaa.bbb.ccc' },
    });

    await expect(
      enqueueEvents(client, [withSecret], {
        logger: fakeLogger,
        partitionKey: (candidate) => candidate.aggregateId,
      }),
    ).rejects.toThrow(/secret/i);

    expect(rows()).toHaveLength(0);
    expect(fakeLogger.error).toHaveBeenCalled();
  });

  it('refuses a payload carrying a raw recovery code', async () => {
    const { client } = captureOutbox();

    await expect(
      enqueueEvents(
        client,
        [eventOf({ payload: { userId: 'u1', code: 'ABCDE-FGHJK' } })],
        { logger: fakeLogger, partitionKey: (candidate) => candidate.aggregateId },
      ),
    ).rejects.toThrow(/refusing to publish/i);
  });

  it('skips an event with no topic and says so', async () => {
    const { client, rows } = captureOutbox();

    await enqueueEvents(client, [eventOf({ eventType: 'mfa.enrollment_started' })], {
      logger: fakeLogger,
      partitionKey: (candidate) => candidate.aggregateId,
    });

    expect(rows()).toHaveLength(0);
    expect(fakeLogger.warn).toHaveBeenCalledWith(expect.stringContaining('mfa.enrollment_started'));
  });

  it('writes nothing at all when there are no events', async () => {
    const { client, rows } = captureOutbox();

    await enqueueEvents(client, [], {
      logger: fakeLogger,
      partitionKey: (candidate) => candidate.aggregateId,
    });

    expect(rows()).toHaveLength(0);
  });
});