import { RedisSagaStore } from '../src/redis-saga.store';
import { SagaStatus } from '../src/saga.config';
import { SagaConflictError, type SagaInstance } from '../src/saga.store.port';

/**
 * A stand-in for ioredis that implements just the commands the store uses.
 *
 * @remarks The Lua script is emulated in JS rather than shipped to a real server: the unit
 * suite's job is to pin the store's *logic* — version comparison, active-set membership,
 * terminal TTL — and a real Redis would turn every test into an integration test without
 * asserting anything this fake does not.
 */
class FakeRedis {
  private readonly kv = new Map<string, string>();
  private readonly sets = new Map<string, Map<string, number>>();
  private readonly ttls = new Map<string, number>();

  async eval(
    _script: string,
    _numKeys: number,
    instanceKey: string,
    activeSet: string,
    payload: string,
    version: string,
    updatedAt: string,
    terminal: string,
    sagaId: string,
    retentionMs: string,
  ): Promise<number> {
    const current = this.kv.get(instanceKey);
    if (current !== undefined) {
      const decoded = JSON.parse(current) as { version?: number };
      if (decoded.version !== Number(version) - 1) return 0;
    }

    this.kv.set(instanceKey, payload);

    const set = this.sets.get(activeSet) ?? new Map<string, number>();
    this.sets.set(activeSet, set);

    if (terminal === '1') {
      set.delete(sagaId);
      this.ttls.set(instanceKey, Number(retentionMs));
    } else {
      set.set(sagaId, Number(updatedAt));
    }
    return 1;
  }

  async get(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null;
  }

  async zrangebyscore(key: string, _min: string, max: string): Promise<string[]> {
    const set = this.sets.get(key);
    if (!set) return [];
    const ceiling = Number(max);
    return [...set.entries()]
      .filter(([, score]) => score <= ceiling)
      .map(([member]) => member);
  }

  async zrange(key: string, _start: string, _stop: string): Promise<string[]> {
    return [...(this.sets.get(key)?.keys() ?? [])];
  }

  async mget(keys: string[]): Promise<(string | null)[]> {
    return keys.map((key) => this.kv.get(key) ?? null);
  }

  /** Test helper: how long a key is set to live, in ms. */
  ttlOf(key: string): number | undefined {
    return this.ttls.get(key);
  }

  has(key: string): boolean {
    return this.kv.has(key);
  }

  activeMembers(setKey: string): string[] {
    return [...(this.sets.get(setKey)?.keys() ?? [])];
  }
}

const instance = (over: Partial<SagaInstance> = {}): SagaInstance => ({
  sagaId: 'saga-1',
  sagaType: 'registration',
  status: SagaStatus.RUNNING,
  stepIndex: 0,
  context: {},
  attempts: 0,
  lastError: null,
  version: 1,
  startedAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  completedAt: null,
  ...over,
});

const storeWith = (redis: FakeRedis) => new RedisSagaStore(redis as never, 24);

describe('RedisSagaStore', () => {
  it('writes a new instance and puts it in the active set', async () => {
    const redis = new FakeRedis();
    const store = storeWith(redis);

    await store.save(instance());

    expect(await store.findById('saga-1')).toMatchObject({
      sagaId: 'saga-1',
      status: SagaStatus.RUNNING,
      version: 1,
    });
    expect(redis.activeMembers('saga:active')).toEqual(['saga-1']);
  });

  it('revives Dates that JSON turned into strings', async () => {
    const redis = new FakeRedis();
    const store = storeWith(redis);

    await store.save(instance({ stepIndex: 3 }));
    const loaded = await store.findById('saga-1');

    expect(loaded?.updatedAt).toBeInstanceOf(Date);
    expect(loaded?.startedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('rejects a write whose version is not the next one', async () => {
    const redis = new FakeRedis();
    const store = storeWith(redis);
    await store.save(instance({ version: 1 }));

    await expect(store.save(instance({ version: 1 }))).rejects.toThrow(
      SagaConflictError,
    );
  });

  it('accepts the next version', async () => {
    const redis = new FakeRedis();
    const store = storeWith(redis);
    await store.save(instance({ version: 1 }));

    await store.save(instance({ version: 2, stepIndex: 1 }));

    expect((await store.findById('saga-1'))?.stepIndex).toBe(1);
  });

  it('takes a terminal instance out of the active set and gives it a TTL', async () => {
    const redis = new FakeRedis();
    const store = storeWith(redis);
    await store.save(instance({ version: 1 }));

    await store.save(
      instance({ version: 2, status: SagaStatus.COMPLETED, completedAt: new Date() }),
    );

    expect(redis.activeMembers('saga:active')).toEqual([]);
    expect(redis.ttlOf('saga:instance:saga-1')).toBe(24 * 3_600_000);
  });

  it('finds only stale non-terminal instances', async () => {
    const redis = new FakeRedis();
    const store = storeWith(redis);
    const old = new Date('2026-01-01T00:00:00Z').getTime();
    const recent = new Date('2026-06-01T00:00:00Z').getTime();

    await store.save(instance({ sagaId: 'old', updatedAt: new Date(old) }));
    await store.save(
      instance({
        sagaId: 'recent',
        updatedAt: new Date(recent),
        version: 1,
      }),
    );

    const interrupted = await store.findInterrupted(new Date('2026-03-01T00:00:00Z'));

    expect(interrupted.map((i) => i.sagaId)).toEqual(['old']);
  });

  it('counts by status across the active set', async () => {
    const redis = new FakeRedis();
    const store = storeWith(redis);
    await store.save(instance({ sagaId: 'a', version: 1 }));
    await store.save(
      instance({
        sagaId: 'b',
        status: SagaStatus.COMPENSATING,
        version: 1,
      }),
    );

    expect(await store.countByStatus(SagaStatus.RUNNING)).toBe(1);
    expect(await store.countByStatus(SagaStatus.COMPENSATING)).toBe(1);
    expect(await store.countByStatus(SagaStatus.FAILED)).toBe(0);
  });

  it('returns null for an unknown id', async () => {
    const store = storeWith(new FakeRedis());

    expect(await store.findById('nope')).toBeNull();
  });
});
