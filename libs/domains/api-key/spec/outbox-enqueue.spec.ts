/**
 * @fileoverview The `outbox_events` rows this service writes beside its state changes.
 *
 * @remarks The transactional-outbox guarantee has three parts, and each is asserted here: the
 * rows go in with the mutation, `skipDuplicates` makes a retried command a no-op, and the payload
 * can never carry a credential.
 *
 * @remarks No database. The client is a two-line stub that captures `createMany`, because the
 * question being asked — "what would be written?" — is fully determined before a connection is
 * involved.
 */

import 'reflect-metadata';
import type { Logger } from '@nestjs/common';
import { EVENT_SCHEMA_VERSION, Topics } from '@auth/contracts';
import type { PrismaClient } from '../src/generated/prisma/client';
import { enqueueEvents } from '../src/infrastructure/persistence/outbox-enqueue';
import { ApiKey } from '../src/domain/api-key.aggregate';
import { ApiKeyPrefix } from '../src/domain/value-objects/api-key-prefix.vo';
import { ApiKeyScope } from '../src/domain/value-objects/api-key-scope.vo';
import type { IDomainEvent } from '@auth/core';
import { FakeApiKeyCrypto, USER_ID } from './support/fakes';

const TOPICS = {
  'api_key.created': Topics.API_KEY_CREATED,
  'api_key.rotated': Topics.API_KEY_ROTATED,
  'api_key.revoked': Topics.API_KEY_REVOKED,
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

const issue = () => {
  const crypto = new FakeApiKeyCrypto();
  const material = crypto.issueMaterial(ApiKeyPrefix.TEST);
  const key = ApiKey.issue({
    userId: USER_ID,
    name: 'billing exporter',
    material,
    scopes: [ApiKeyScope.READ],
  });
  return { key, plaintext: material.secret.value };
};

describe('outbox enqueue', () => {
  it('writes one row per event, with the topic the contract names', async () => {
    const { key } = issue();
    const { client, rows } = captureOutbox();

    await enqueueEvents(key.clearDomainEvents(), {
      client,
      logger: fakeLogger(),
      topics: TOPICS,
    });

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      type: 'api_key.created',
      topic: Topics.API_KEY_CREATED,
      aggregate_type: 'ApiKey',
      aggregate_id: key.id.value,
      status: 'pending',
      attempts: 0,
    });
    expect((rows()[0].payload as Record<string, unknown>).schemaVersion).toBe(
      EVENT_SCHEMA_VERSION,
    );
  });

  it('derives the dedup key from type, aggregate and version', async () => {
    const { key } = issue();
    const { client, rows } = captureOutbox();

    await enqueueEvents(key.clearDomainEvents(), {
      client,
      logger: fakeLogger(),
      topics: TOPICS,
    });

    // The unique index on `(dedup_key, type)` is what turns a retried command into a no-op
    // instead of a duplicate `api_key.created`.
    expect(rows()[0].dedup_key).toBe(`api_key.created:${key.id.value}:1`);
  });

  it('asks for skipDuplicates', async () => {
    const { key } = issue();
    const { client, calls } = captureOutbox();

    await enqueueEvents(key.clearDomainEvents(), {
      client,
      logger: fakeLogger(),
      topics: TOPICS,
    });

    expect(calls()[0]?.skipDuplicates).toBe(true);
  });

  it('writes both rows of a rotation in one call', async () => {
    const { key } = issue();
    // Drained first: `rotate` mutates the original, and its `api_key.created` was published
    // when the key was issued, not when it was replaced.
    key.clearDomainEvents();
    const crypto = new FakeApiKeyCrypto();
    const { revoked, successor } = ApiKey.rotate({
      current: key,
      material: crypto.issueMaterial(ApiKeyPrefix.TEST),
    });
    const { client, rows, calls } = captureOutbox();

    await enqueueEvents([...revoked.clearDomainEvents(), ...successor.clearDomainEvents()], {
      client,
      logger: fakeLogger(),
      topics: TOPICS,
    });

    // One round trip for two rows: a rotation is one transaction and one `createMany`.
    expect(calls()).toHaveLength(1);
    expect(rows().map((row) => row.type).sort()).toEqual(['api_key.revoked', 'api_key.rotated']);
    expect(rows().map((row) => row.dedup_key)).toEqual([
      `api_key.revoked:${revoked.id.value}:2`,
      `api_key.rotated:${successor.id.value}:1`,
    ]);
  });

  it('never carries a plaintext key, on any of the three topics', async () => {
    const crypto = new FakeApiKeyCrypto();
    const first = crypto.issueMaterial(ApiKeyPrefix.TEST);
    const created = ApiKey.issue({
      userId: USER_ID,
      name: 'billing exporter',
      material: first,
      scopes: [ApiKeyScope.READ],
    });

    const { revoked, successor } = ApiKey.rotate({
      current: created,
      material: crypto.issueMaterial(ApiKeyPrefix.TEST),
    });
    revoked.revoke('leaked');

    const events: IDomainEvent[] = [
      ...created.clearDomainEvents(),
      ...revoked.clearDomainEvents(),
      ...successor.clearDomainEvents(),
    ];
    const { client, rows } = captureOutbox();

    await enqueueEvents(events, { client, logger: fakeLogger(), topics: TOPICS });

    const published = JSON.stringify(rows());
    for (const secret of crypto.issued.map((material) => material.secret.value)) {
      expect(published).not.toContain(secret);
    }
    // And no digest either: that is a credential-adjacent value with no business on a topic.
    expect(published).not.toMatch(/secret_hash/);
    // The prefix is the non-secret half, and it is what a consumer gets.
    expect(published).toContain(first.prefix);
  });

  it('refuses to publish a payload that carries something secret-shaped', async () => {
    const { client, rows } = captureOutbox();
    const smuggled = {
      ...issue().key.domainEvents[0],
      payload: { apiKeyId: 'a', key: 'test_a1b2c3d4_...' },
    } as IDomainEvent;

    // Fails inside the transaction, so a key is never issued *and* announced under a payload
    // nobody should have seen.
    await expect(
      enqueueEvents([smuggled], { client, logger: fakeLogger(), topics: TOPICS }),
    ).rejects.toThrow(/refusing to publish/i);

    expect(rows()).toHaveLength(0);
  });

  it('refuses a payload carrying a digest', async () => {
    const { client, rows } = captureOutbox();
    const smuggled = {
      ...issue().key.domainEvents[0],
      payload: { apiKeyId: 'a', secret_hash: 'deadbeef' },
    } as IDomainEvent;

    await expect(
      enqueueEvents([smuggled], { client, logger: fakeLogger(), topics: TOPICS }),
    ).rejects.toThrow(/credential/i);

    expect(rows()).toHaveLength(0);
  });

  it('skips an event with no topic, and says which one', async () => {
    const { client, rows } = captureOutbox();
    const logger = fakeLogger();
    const unmapped = {
      ...issue().key.domainEvents[0],
      eventType: 'api_key.retired',
    } as IDomainEvent;

    await enqueueEvents([unmapped], { client, logger, topics: TOPICS });

    // An unmapped event is a build-time oversight. Failing the transaction would roll back a
    // perfectly valid state change over a topic nobody subscribes to yet.
    expect(rows()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('api_key.retired'));
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
      aggregateId: '22222222-2222-4222-8222-222222222222',
      aggregateType: 'ApiKey',
      eventType: 'api_key.created',
      occurredAt: new Date('2023-11-14T22:13:20.000Z'),
      version: 1,
    } as IDomainEvent;

    await enqueueEvents([bare], { client, logger: fakeLogger(), topics: TOPICS });

    expect((rows()[0].payload as Record<string, unknown>).payload).toEqual({});
  });
});