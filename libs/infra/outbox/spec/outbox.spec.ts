import { calculateBackoff, OutboxStatus } from '../src/outbox.config';
import { OutboxService } from '../src/outbox.service';
import { OutboxRelay, OutboxHealthIndicator } from '../src/prisma-outbox.repository';
import type { OutboxRecord, OutboxRepositoryPort } from '../src/outbox.repository.port';
import type { OutboxConfig } from '../src/outbox.tokens';

const CONFIG: OutboxConfig = {
  enabled: true,
  pollIntervalMs: 1_000,
  batchSize: 3,
  maxRetries: 3,
  baseRetryDelayMs: 1_000,
  maxRetryDelayMs: 60_000,
  cleanupIntervalMs: 3_600_000,
  retentionHours: 24,
};

const record = (over: Partial<OutboxRecord> = {}): OutboxRecord => ({
  id: 'evt-1',
  topic: 'platform.user.registered.v1',
  partitionKey: 'user-1',
  payload: JSON.stringify({ eventId: 'evt-1' }),
  status: OutboxStatus.PENDING,
  attempts: 0,
  nextAttemptAt: new Date(),
  createdAt: new Date(),
  ...over,
});

class FakeRepository implements OutboxRepositoryPort {
  appended: Array<Record<string, unknown>> = [];
  published: string[][] = [];
  failed: Array<{ id: string; error: string; nextAttemptAt: Date }> = [];
  deadLettered: Array<{ id: string; error: string }> = [];
  batch: OutboxRecord[] = [];
  counts: Record<string, number> = { pending: 0, dlq: 0 };

  async append(entry: Record<string, unknown>): Promise<void> {
    this.appended.push(entry);
  }

  async appendMany(entries: Array<Record<string, unknown>>): Promise<void> {
    this.appended.push(...entries);
  }

  async claimBatch(): Promise<OutboxRecord[]> {
    const batch = this.batch.splice(0, CONFIG.batchSize);
    return batch;
  }

  async markPublished(ids: string[]): Promise<void> {
    this.published.push(ids);
  }

  async markFailed(id: string, error: string, nextAttemptAt: Date): Promise<void> {
    this.failed.push({ id, error, nextAttemptAt });
  }

  async markDeadLettered(id: string, error: string): Promise<void> {
    this.deadLettered.push({ id, error });
  }

  async reclaimStale(): Promise<number> {
    return 0;
  }

  async cleanup(): Promise<number> {
    return 0;
  }

  async countByStatus(status: OutboxStatus): Promise<number> {
    return this.counts[status] ?? 0;
  }
}

const service = (repo: FakeRepository) =>
  new OutboxService(repo as unknown as OutboxRepositoryPort, CONFIG);

describe('calculateBackoff', () => {
  it('grows exponentially with the attempt count', () => {
    const base = 1_000;
    const samples = Array.from({ length: 40 }, () => calculateBackoff(3, base, 60_000));

    // Full jitter bounds the delay to [half, full] of the capped value.
    const capped = Math.min(base * 2 ** 3, 60_000);
    for (const sample of samples) {
      expect(sample).toBeGreaterThanOrEqual(capped / 2);
      expect(sample).toBeLessThanOrEqual(capped);
    }
    expect(new Set(samples).size).toBeGreaterThan(1);
  });

  it('never exceeds the configured ceiling', () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect(calculateBackoff(attempt, 1_000, 60_000)).toBeLessThanOrEqual(60_000);
    }
  });

  it('treats a negative attempt count as zero rather than shrinking the delay', () => {
    expect(calculateBackoff(-5, 1_000, 60_000)).toBeGreaterThanOrEqual(500);
  });
});

describe('OutboxService.publish', () => {
  it('writes a row rather than producing to the broker', async () => {
    const repo = new FakeRepository();
    await service(repo).publish('platform.user.registered.v1', { userId: 'u1' }, {
      aggregateId: 'u1',
      traceId: 'trace-1',
    });

    expect(repo.appended).toHaveLength(1);
    expect(repo.appended[0].topic).toBe('platform.user.registered.v1');
  });

  it('derives the event type by stripping the platform prefix and version suffix', async () => {
    const repo = new FakeRepository();
    await service(repo).publish('platform.user.registered.v1', { userId: 'u1' }, {
      aggregateId: 'u1',
    });

    expect(repo.appended[0].type).toBe('user.registered');
  });

  it('derives a dedup key so re-running a command is a no-op', async () => {
    const repo = new FakeRepository();
    await service(repo).publish('platform.user.registered.v1', { userId: 'u1' }, {
      aggregateId: 'u1',
    });

    expect(repo.appended[0].dedupKey).toBe('user.registered:u1');
  });

  it('always fills trace_id, which the column declares NOT NULL', async () => {
    const repo = new FakeRepository();
    await service(repo).publish('platform.user.registered.v1', { userId: 'u1' }, {
      aggregateId: 'u1',
    });

    expect(repo.appended[0].traceId).toEqual(expect.any(String));
  });

  it('emits one row per payload in publishAll', async () => {
    const repo = new FakeRepository();
    await service(repo).publishAll(
      'platform.user.registered.v1',
      [{ userId: 'u1' }, { userId: 'u2' }],
      { aggregateId: 'u1' },
    );

    expect(repo.appended).toHaveLength(2);
  });

  it('writes nothing for an empty batch', async () => {
    const repo = new FakeRepository();
    await service(repo).publishAll('platform.user.registered.v1', [], {});

    expect(repo.appended).toHaveLength(0);
  });
});

describe('OutboxRelay.tick', () => {
  const relay = (repo: FakeRepository, publisher: { send: () => Promise<void> }) =>
    new OutboxRelay(repo, publisher, CONFIG);

  it('publishes a claimed batch and marks it published', async () => {
    const repo = new FakeRepository();
    repo.batch = [record({ id: 'a' }), record({ id: 'b' })];

    const sent: string[] = [];
    const processed = await relay(repo, {
      send: async (_t, _p, o) => {
        sent.push(String(o.eventId));
      },
    }).tick();

    expect(processed).toBe(2);
    expect(sent).toEqual(['a', 'b']);
    expect(repo.published.flat()).toEqual(['a', 'b']);
  });

  it('schedules a retry with backoff when the broker rejects a publish', async () => {
    const repo = new FakeRepository();
    repo.batch = [record({ id: 'a' })];

    await relay(repo, {
      send: async () => {
        throw new Error('broker down');
      },
    }).tick();

    expect(repo.failed).toHaveLength(1);
    expect(repo.failed[0].id).toBe('a');
    expect(repo.failed[0].nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(repo.deadLettered).toHaveLength(0);
  });

  it('dead-letters once an event exhausts its retries', async () => {
    const repo = new FakeRepository();
    // maxRetries is 3, so an event already at 2 attempts must die on this one.
    repo.batch = [record({ id: 'a', attempts: 2 })];

    await relay(repo, {
      send: async () => {
        throw new Error('broker down');
      },
    }).tick();

    expect(repo.deadLettered).toHaveLength(1);
    expect(repo.failed).toHaveLength(0);
  });

  it('keeps processing the batch after one event fails', async () => {
    const repo = new FakeRepository();
    repo.batch = [record({ id: 'bad' }), record({ id: 'good' })];

    const sent: string[] = [];
    await relay(repo, {
      send: async (_t, _p, o) => {
        if (o.eventId === 'bad') throw new Error('broker down');
        sent.push(String(o.eventId));
      },
    }).tick();

    // The failure must not strand the rows already claimed alongside it.
    expect(sent).toEqual(['good']);
    expect(repo.published.flat()).toEqual(['good']);
    expect(repo.failed.map((f) => f.id)).toEqual(['bad']);
  });

  it('returns 0 and does nothing when the backlog is empty', async () => {
    const repo = new FakeRepository();
    const processed = await relay(repo, { send: async () => undefined }).tick();

    expect(processed).toBe(0);
    expect(repo.published).toHaveLength(0);
  });
});

describe('OutboxHealthIndicator', () => {
  it('reports degraded, not down, when events have been dead-lettered', async () => {
    const repo = new FakeRepository();
    repo.counts = { pending: 2, dlq: 1 };

    const report = await new OutboxHealthIndicator(repo).check();

    // Dead letters mean lost notifications, but the service can still serve traffic.
    expect(report.outbox.status).toBe('degraded');
    expect(report.outbox.pending).toBe(2);
  });

  it('reports up with a clean backlog', async () => {
    const repo = new FakeRepository();
    repo.counts = { pending: 0, dlq: 0 };

    const report = await new OutboxHealthIndicator(repo).check();

    expect(report.outbox.status).toBe('up');
  });
});