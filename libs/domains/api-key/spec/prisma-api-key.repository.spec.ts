/**
 * @fileoverview The transactional-outbox guarantee, asserted against the real repository.
 *
 * @remarks The property under test is about *when* two things happen relative to a transaction
 * boundary, and a boundary is exactly what a database-free double can still model: the fake
 * client records, for every call, whether the transaction was open at that moment. So this suite
 * can prove that the row write and the event write are inside the same `runInTransaction`, and
 * that there is only one of them, without a connection anywhere.
 *
 * @remarks This is the only suite that touches `PrismaService`. Everything else goes through a
 * port.
 */

import 'reflect-metadata';
import { Topics } from '@auth/contracts';
import type { PrismaService } from '@auth/infra/prisma';
import type { PrismaClient } from '../src/generated/prisma/client';
import { PrismaApiKeyRepository } from '../src/infrastructure/persistence/prisma-api-key.repository';
import { ByUser, UsableKeys } from '../src/domain/ports/api-key-repository.port';
import { ApiKey } from '../src/domain/api-key.aggregate';
import { ApiKeyPrefix } from '../src/domain/value-objects/api-key-prefix.vo';
import { ApiKeyScope } from '../src/domain/value-objects/api-key-scope.vo';
import { FakeApiKeyCrypto, USER_ID } from './support/fakes';

interface Recorded {
  readonly call: string;
  readonly inTransaction: boolean;
}

class RecordingClient {
  /** Every call, with the transaction state it ran under. */
  readonly calls: Recorded[] = [];
  readonly rows = new Map<string, Record<string, unknown>>();
  inTransaction = false;

  readonly api_keys = {
    upsert: async (args: {
      where: { id: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<Record<string, unknown>> => {
      this.calls.push({ call: `api_keys.upsert:${args.where.id}`, inTransaction: this.inTransaction });
      const row = { ...args.create, ...args.update };
      this.rows.set(args.where.id, row);
      return row;
    },
    findUnique: async (args: { where: { id?: string; prefix?: string } }) => {
      this.calls.push({ call: 'api_keys.findUnique', inTransaction: this.inTransaction });
      const match = [...this.rows.values()].find(
        (row) =>
          (args.where.id !== undefined && row.id === args.where.id) ||
          (args.where.prefix !== undefined && row.prefix === args.where.prefix),
      );
      return match ?? null;
    },
    findMany: async () => {
      this.calls.push({ call: 'api_keys.findMany', inTransaction: this.inTransaction });
      return [...this.rows.values()];
    },
    count: async (args?: { where?: { user_id?: string; name?: string } }) => {
      this.calls.push({ call: 'api_keys.count', inTransaction: this.inTransaction });
      const where = args?.where;
      return [...this.rows.values()].filter(
        (row) =>
          (where?.user_id === undefined || row.user_id === where.user_id) &&
          (where?.name === undefined || row.name === where.name),
      ).length;
    },
  };

  readonly outbox_events = {
    createMany: async (args: { data: Record<string, unknown>[]; skipDuplicates?: boolean }) => {
      this.calls.push({ call: 'outbox_events.createMany', inTransaction: this.inTransaction });
      this.outboxRows.push(...args.data);
      this.skipDuplicates.push(args.skipDuplicates === true);
      return { count: args.data.length };
    },
  };

  readonly outboxRows: Record<string, unknown>[] = [];
  readonly skipDuplicates: boolean[] = [];
  transactions = 0;

  /** Runs a callback "inside" a transaction, recording the boundary. */
  async runInTransaction<TResult>(fn: (client: this) => Promise<TResult>): Promise<TResult> {
    this.transactions += 1;
    this.inTransaction = true;
    try {
      return await fn(this);
    } finally {
      this.inTransaction = false;
    }
  }
}

const harness = () => {
  const client = new RecordingClient();
  const repository = new PrismaApiKeyRepository({
    // The boundary lives on the client double, exactly where `PrismaService.runInTransaction`
    // would have it, so the count the assertions read is the real number of transactions.
    runInTransaction: <TResult>(fn: (tx: PrismaClient) => Promise<TResult>): Promise<TResult> =>
      client.runInTransaction(() => fn(client as unknown as PrismaClient)),
    tx: client,
  } as unknown as PrismaService<PrismaClient>);
  const crypto = new FakeApiKeyCrypto();
  return { client, repository, crypto };
};

const issue = (
  crypto: FakeApiKeyCrypto,
  overrides: { now?: Date; scopes?: ApiKeyScope[] } = {},
): { key: ApiKey; plaintext: string } => {
  const material = crypto.issueMaterial(ApiKeyPrefix.TEST);
  const key = ApiKey.issue({
    userId: USER_ID,
    name: 'billing exporter',
    material,
    scopes: overrides.scopes ?? [ApiKeyScope.READ],
    expiresAt: new Date(Date.now() + 3_600_000),
    now: overrides.now,
  });
  return { key, plaintext: material.secret.value };
};

describe('PrismaApiKeyRepository — writes', () => {
  it('writes the row and its event in one transaction', async () => {
    const { repository, client, crypto } = harness();
    const { key, plaintext } = issue(crypto);

    await repository.save(key);

    // One boundary. The row write and the event write are inside it, in that order, and the
    // events are drained before it opens — an event buffer that survived a rollback would be
    // written by the *next* save and attributed to a different key.
    expect(client.transactions).toBe(1);
    expect(client.calls).toEqual([
      { call: `api_keys.upsert:${key.id.value}`, inTransaction: true },
      { call: 'outbox_events.createMany', inTransaction: true },
    ]);
    expect(client.outboxRows).toHaveLength(1);
    expect(JSON.stringify([...client.rows.values()])).not.toContain(plaintext);
  });

  it('writes both rows and both events of a rotation in one transaction', async () => {
    const { repository, client, crypto } = harness();
    const { key } = issue(crypto);
    await repository.save(key);
    client.calls.length = 0;
    client.outboxRows.length = 0;
    const commitsBefore = client.transactions;

    const { revoked, successor } = ApiKey.rotate({
      current: key,
      material: crypto.issueMaterial(ApiKeyPrefix.TEST),
      now: new Date(),
    });
    await repository.saveMany([revoked, successor]);

    // The reason this exists: no instant at which both keys are usable, and none at which
    // neither is.
    expect(client.transactions - commitsBefore).toBe(1);
    expect(client.calls).toHaveLength(4);
    expect(client.calls.every((entry) => entry.inTransaction)).toBe(true);
    expect(client.outboxRows.map((row) => row.type).sort()).toEqual([
      'api_key.revoked',
      'api_key.rotated',
    ]);
    expect(stored(client.rows, revoked.id.value).status).toBe('revoked');
    expect(stored(client.rows, successor.id.value).status).toBe('active');
  });

  it('asks for skipDuplicates, and keys each row by type, aggregate and version', async () => {
    const { repository, client, crypto } = harness();
    const { key } = issue(crypto);

    await repository.save(key);

    expect(client.skipDuplicates).toEqual([true]);
    expect(client.outboxRows[0]).toMatchObject({
      dedup_key: `api_key.created:${key.id.value}:1`,
      topic: Topics.API_KEY_CREATED,
      aggregate_type: 'ApiKey',
    });
  });

  it('carries the prefix and never the key in the published payload', async () => {
    const { repository, client, crypto } = harness();
    const { key, plaintext } = issue(crypto);

    await repository.save(key);

    const payload = client.outboxRows[0].payload as Record<string, Record<string, unknown>>;
    expect(payload.payload).toMatchObject({ apiKeyId: key.id.value, prefix: key.prefix });
    expect(JSON.stringify(client.outboxRows)).not.toContain(plaintext);
    expect(JSON.stringify(client.outboxRows)).not.toContain(key.secretHash);
  });

  it('never rewrites an identity column on update', async () => {
    // A key does not change owner, and rewriting its creation time would break the
    // `(user_id, created_at desc)` listing an owner browses.
    const { repository, client, crypto } = harness();
    const { key } = issue(crypto);
    await repository.save(key);
    key.markUsed(new Date());

    await repository.save(key);

    const row = stored(client.rows, key.id.value);
    expect(row.user_id).toBe(USER_ID);
    expect(row.id).toBe(key.id.value);
    expect(row.last_used_at).toBeInstanceOf(Date);
  });

  it('does nothing at all for an empty batch', async () => {
    const { repository, client } = harness();

    await repository.saveMany([]);

    expect(client.transactions).toBe(0);
    expect(client.calls).toHaveLength(0);
  });
});

describe('PrismaApiKeyRepository — reads', () => {
  it('finds a key by prefix on the unique index, and rehydrates it', async () => {
    const { repository, client, crypto } = harness();
    const { key, plaintext } = issue(crypto);
    await repository.save(key);
    client.calls.length = 0;

    const found = await repository.findByPrefix(key.prefix);

    expect(client.calls).toEqual([{ call: 'api_keys.findUnique', inTransaction: false }]);
    expect(found?.id.value).toBe(key.id.value);
    expect(found?.secretHash).toBe(key.secretHash);
    expect(found?.secretHash).not.toBe(plaintext);
  });

  it('answers null for a prefix that does not exist', async () => {
    const { repository } = harness();

    await expect(repository.findByPrefix('test_zzzzzzzz')).resolves.toBeNull();
  });

  it('answers `existsByName` on the compound unique index, trimmed', async () => {
    const { repository, crypto } = harness();
    const { key } = issue(crypto);
    await repository.save(key);

    // Checked up front so the common case is a clean 409 rather than a driver-level error code
    // surfacing as a 500.
    await expect(repository.existsByName(USER_ID, key.name)).resolves.toBe(true);
    await expect(repository.existsByName(USER_ID, `  ${key.name}  `)).resolves.toBe(true);
    await expect(repository.existsByName(USER_ID, 'something else')).resolves.toBe(false);
    await expect(repository.existsByName('somebody-else', key.name)).resolves.toBe(false);
  });

  it('counts against the domain predicate rather than a second implementation of it', async () => {
    const { repository, crypto } = harness();
    const { key } = issue(crypto);
    await repository.save(key);
    key.revoke('leaked');
    await repository.save(key);

    // A SQL-side copy of "is this key usable" would be free to drift from the aggregate's, and
    // the drift would only show up as a key that authenticates and cannot be listed.
    expect(await repository.count(new UsableKeys())).toBe(0);
    expect(await repository.count(new ByUser(USER_ID))).toBe(1);
    expect(await repository.count(new ByUser('somebody-else'))).toBe(0);
    expect((await repository.find(new UsableKeys()))).toHaveLength(0);
  });
});

function stored<T>(source: Map<string, T>, key: string): T {
  const found = source.get(key);
  if (!found) throw new Error(`expected ${key} to be present`);
  return found;
}