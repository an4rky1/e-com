import { InMemorySagaStore } from '../src/in-memory-saga.store';
import { SagaStatus } from '../src/saga.config';
import { SagaConflictError, type SagaInstance } from '../src/saga.store.port';

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

describe('InMemorySagaStore', () => {
  it('accepts a new instance at version 1', async () => {
    const store = new InMemorySagaStore();

    await store.save(instance());

    expect(await store.findById('saga-1')).toMatchObject({ sagaId: 'saga-1' });
  });

  it('accepts the next version and rejects a stale one', async () => {
    const store = new InMemorySagaStore();
    await store.save(instance({ version: 1 }));

    await store.save(instance({ version: 2, stepIndex: 1 }));

    await expect(store.save(instance({ version: 2, stepIndex: 5 }))).rejects.toThrow(
      SagaConflictError,
    );
  });

  it('rejects a first write that does not start at version 1', async () => {
    const store = new InMemorySagaStore();

    await expect(store.save(instance({ version: 3 }))).rejects.toThrow(
      SagaConflictError,
    );
  });

  it('stores a snapshot, not a live reference', async () => {
    const store = new InMemorySagaStore();
    const source = instance({ context: { step: 'a' } });
    await store.save(source);

    const loaded = await store.findById('saga-1');
    expect(loaded?.context).toEqual({ step: 'a' });
    expect(loaded).not.toBe(source);
  });

  it('finds only non-terminal instances older than the cutoff', async () => {
    const store = new InMemorySagaStore();
    const old = new Date('2026-01-01T00:00:00Z');
    const recent = new Date('2026-06-01T00:00:00Z');

    await store.save(instance({ sagaId: 'old-running', updatedAt: old }));
    await store.save(
      instance({ sagaId: 'old-compensating', status: SagaStatus.COMPENSATING, updatedAt: old }),
    );
    await store.save(
      instance({ sagaId: 'old-completed', status: SagaStatus.COMPLETED, updatedAt: old }),
    );
    await store.save(instance({ sagaId: 'recent-running', updatedAt: recent }));

    const interrupted = await store.findInterrupted(new Date('2026-03-01T00:00:00Z'));

    expect(interrupted.map((i) => i.sagaId).sort()).toEqual([
      'old-compensating',
      'old-running',
    ]);
  });

  it('counts by status', async () => {
    const store = new InMemorySagaStore();
    await store.save(instance({ sagaId: 'a', status: SagaStatus.RUNNING }));
    await store.save(instance({ sagaId: 'b', status: SagaStatus.RUNNING }));
    await store.save(
      instance({ sagaId: 'c', status: SagaStatus.COMPENSATED, completedAt: new Date() }),
    );

    expect(await store.countByStatus(SagaStatus.RUNNING)).toBe(2);
    expect(await store.countByStatus(SagaStatus.COMPENSATED)).toBe(1);
    expect(await store.countByStatus(SagaStatus.FAILED)).toBe(0);
  });
});
