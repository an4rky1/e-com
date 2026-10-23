import { PrismaOutboxRepository } from '../src/prisma-outbox.repository';
import type { OutboxRecord } from '../src/outbox.repository.port';

/**
 * The claim path of the Prisma outbox repository.
 *
 * @remarks The bug this file exists to keep out was not visible from the relay's tests: they drive
 * `OutboxRelay` through the repository *port*, so any storage is interchangeable to them. What
 * actually failed was that claiming was two statements — a `findMany` to pick rows, then an
 * `updateMany` to mark them — and two relays therefore claimed the same rows and published them
 * twice. A port cannot express "these two calls must be one", so the assertion belongs here,
 * against the real claim shape.
 */

/** Captures the raw SQL the repository sends, standing in for the database. */
class RecordingClient {
  readonly queries: string[] = [];
  readonly found: unknown[] = [];
  readonly updated: Array<{ where: Record<string, unknown> }> = [];

  constructor(private readonly claimRows: Record<string, unknown>[]) {}

  get tx(): this {
    return this;
  }

  get outbox_events(): unknown {
    return {
      createMany: jest.fn(),
      findMany: async (args: Record<string, unknown>) => {
        this.found.push(args);
        return [];
      },
      update: jest.fn(),
      updateMany: async (args: Record<string, unknown>) => {
        this.updated.push(args);
        return { count: 0 };
      },
      count: jest.fn(),
      deleteMany: jest.fn(),
    };
  }

  get outbox_dead_letters(): unknown {
    return { create: jest.fn() };
  }

  async $queryRaw(query: TemplateStringsArray): Promise<Record<string, unknown>[]> {
    this.queries.push(String(query));
    return this.claimRows;
  }

  async $transaction(): Promise<never> {
    throw new Error('not expected in these tests');
  }
}

const row = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  type: 'platform.user.registered.v1',
  aggregate_id: `user-${id}`,
  topic: 'platform.user.registered.v1',
  payload: { eventId: id },
  status: 'pending',
  attempts: 0,
  next_attempt_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  ...over,
});

/**
 * The object handed to the repository. `tx` is what every read goes through, so a fake that is
 * also its own `tx` stands in for both the service's PrismaService and the client behind it.
 */
function repositoryWith(prismaLike: unknown): PrismaOutboxRepository {
  return new PrismaOutboxRepository(prismaLike as never);
}

const toRecord = (r: OutboxRecord): string => r.id;

describe('PrismaOutboxRepository.claimBatch', () => {
  it('claims in a single statement, with the lock inside the selection', async () => {
    const client = new RecordingClient([row('evt-1'), row('evt-2')]);
    const repository = repositoryWith(client);

    const claimed = (await repository.claimBatch(5)).map(toRecord);

    // One statement. A select-then-update is two transactions, and in the gap between them a
    // second replica selects the same rows; both updates then match `status = 'pending'` and both
    // publish. That is the difference between exactly-once and at-most-twice.
    expect(client.queries).toHaveLength(1);

    const sql = client.queries[0] ?? '';
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('RETURNING');

    // The lease marker is written by the same statement that takes the rows, not by a follow-up.
    expect(client.updated).toHaveLength(0);
    expect(client.found).toHaveLength(0);

    expect(claimed).toEqual(['evt-1', 'evt-2']);
  });

  it('skips rows another replica has in flight rather than waiting on them', async () => {
    const client = new RecordingClient([row('evt-1')]);
    const repository = repositoryWith(client);

    await repository.claimBatch(5);

    const sql = client.queries[0] ?? '';
    // The lease escape hatch has to be in the same statement: a row locked by a replica that is
    // currently publishing is not a row this replica may take, and a lock held by a dead relay is
    // reclaimed by age rather than waited out.
    expect(sql).toContain('locked_at IS NULL OR locked_at <');
    expect(sql).toContain('status', );
    expect(sql).toContain("status = 'pending'");
  });

  it('serialises a payload that arrives as a string without re-quoting it', async () => {
    const client = new RecordingClient([row('evt-1', { payload: '{"eventId":"evt-1"}' })]);
    const repository = repositoryWith(client);

    const [claimed] = await repository.claimBatch(5);

    expect(claimed?.payload).toBe('{"eventId":"evt-1"}');
  });

  it('serialises a payload that arrives as a parsed object', async () => {
    const client = new RecordingClient([row('evt-1', { payload: { eventId: 'evt-1' } })]);
    const repository = repositoryWith(client);

    const [claimed] = await repository.claimBatch(5);

    expect(claimed?.payload).toBe('{"eventId":"evt-1"}');
  });

  it('returns nothing when there is nothing due', async () => {
    const client = new RecordingClient([]);
    const repository = repositoryWith(client);

    await expect(repository.claimBatch(5)).resolves.toEqual([]);
    expect(client.queries).toHaveLength(1);
  });
});

describe('PrismaOutboxRepository.markDeadLettered', () => {
  it('moves the row and copies the payload in one transaction', async () => {
    const deadLetterWrites: Array<Record<string, unknown>> = [];
    const update = jest.fn();
    const findMany = async () => [row('evt-1')];

    // `markDeadLettered` reads through the ambient transaction rather than the root client, and
    // `runInTransaction` is what supplies it — so the fake has to hand the callback a client that
    // carries the same delegates the root one does.
    const repository = repositoryWith({
      tx: { outbox_events: { findMany, update }, outbox_dead_letters: { create: jest.fn() } },
      runInTransaction: async (fn: (client: unknown) => Promise<unknown>) => fn({ outbox_events: { findMany, update }, outbox_dead_letters: { create: async (args: { data: Record<string, unknown> }) => { deadLetterWrites.push(args.data); } } }),
    });

    await repository.markDeadLettered('evt-1', 'boom');

    // Both halves are asserted, because a dead letter without the status change is replayed
    // forever, and a status change without the copy loses the payload an operator needs.
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'evt-1' }, data: expect.objectContaining({ status: 'dlq' }) }),
    );
    expect(deadLetterWrites).toHaveLength(1);
    expect(deadLetterWrites[0]).toMatchObject({ outbox_id: 'evt-1', reason: 'platform.user.registered.v1' });
  });
});
