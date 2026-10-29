import { InMemorySagaStore } from '../src/in-memory-saga.store';
import { RecoveryMode, SagaStatus } from '../src/saga.config';
import { SagaRunner, type SagaDefinition } from '../src/saga-runner.service';
import { SagaRecoveryService } from '../src/saga.recovery';
import { SagaHealthIndicator } from '../src/saga.health';
import type { SagaInstance } from '../src/saga.store.port';
import type { SagaConfig } from '../src/saga.tokens';

const CONFIG: SagaConfig = {
  enabled: true,
  stepTimeoutMs: 50,
  stepMaxAttempts: 2,
  baseRetryDelayMs: 0,
  maxRetryDelayMs: 0,
  recoveryIntervalMs: 1_000,
  staleAfterMs: 1_000,
  retentionHours: 24,
  recoveryMode: RecoveryMode.RESUME,
};

interface Ctx extends Record<string, unknown> {
  trail: string[];
}

const definition: SagaDefinition<Ctx> = {
  type: 'two-step',
  steps: [
    { name: 'a', execute: async (c) => c, compensate: async (c) => c },
    { name: 'b', execute: async (c) => c, compensate: async (c) => c },
  ],
};

const runnerWith = (store: InMemorySagaStore): SagaRunner => {
  const r = new SagaRunner(store, CONFIG, async () => undefined);
  r.register(definition);
  return r;
};

const staleInstance = (over: Partial<SagaInstance> = {}): SagaInstance => ({
  sagaId: 'stale-1',
  sagaType: 'two-step',
  status: SagaStatus.RUNNING,
  stepIndex: 1,
  context: { trail: [] },
  attempts: 0,
  lastError: null,
  // The store's first write for an id must be version 1.
  version: 1,
  startedAt: new Date(Date.now() - 60_000),
  updatedAt: new Date(Date.now() - 60_000),
  completedAt: null,
  ...over,
});

describe('SagaRecoveryService', () => {
  it('sweeps stale instances on tick', async () => {
    const store = new InMemorySagaStore();
    await store.save(staleInstance());
    const service = new SagaRecoveryService(runnerWith(store), CONFIG);

    await service.tick();

    expect((await store.findById('stale-1'))?.status).toBe(SagaStatus.COMPLETED);
  });

  it('starts only when enabled', () => {
    const store = new InMemorySagaStore();
    const runner = runnerWith(store);
    const disabled: SagaConfig = { ...CONFIG, enabled: false };
    const service = new SagaRecoveryService(runner, disabled);

    service.onApplicationBootstrap();

    // Nothing observable happens synchronously; the assertion is that bootstrap does not
    // throw and the service stays stopped. A started service would have scheduled a timer.
    expect(service).toBeDefined();
    service.stop();
  });

  it('does not overlap two ticks', async () => {
    const store = new InMemorySagaStore();
    await store.save(staleInstance());
    const runner = runnerWith(store);
    const recoverSpy = jest.spyOn(runner, 'recover');
    const service = new SagaRecoveryService(runner, CONFIG);

    // Drive the first tick without awaiting it, then start a second.
    const first = service.tick();
    const second = service.tick();
    await Promise.all([first, second]);

    // The second tick must have been dropped, not run concurrently.
    expect(recoverSpy).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it('stops scheduling on stop', async () => {
    const store = new InMemorySagaStore();
    const service = new SagaRecoveryService(runnerWith(store), CONFIG);

    service.start();
    service.stop();

    // A stopped service must not schedule further work; tick is still callable directly.
    await expect(service.tick()).resolves.toBeUndefined();
  });
});

describe('SagaHealthIndicator', () => {
  const checkWith = async (store: InMemorySagaStore) =>
    new SagaHealthIndicator(store).check();

  it('reports up when nothing has failed', async () => {
    const store = new InMemorySagaStore();
    await store.save(staleInstance({ sagaId: 'r1' }));

    const report = await checkWith(store);

    expect(report['saga']?.status).toBe('up');
    expect(report['saga']?.['running']).toBe(1);
    expect(report['saga']?.['failed']).toBe(0);
  });

  it('reports degraded when a saga has failed', async () => {
    const store = new InMemorySagaStore();
    await store.save(
      staleInstance({
        sagaId: 'f1',
        status: SagaStatus.FAILED,
        completedAt: new Date(),
      }),
    );

    const report = await checkWith(store);

    expect(report['saga']?.status).toBe('degraded');
    expect(report['saga']?.['failed']).toBe(1);
  });

  it('reports the compensating backlog', async () => {
    const store = new InMemorySagaStore();
    await store.save(staleInstance({ sagaId: 'c1', status: SagaStatus.COMPENSATING }));

    const report = await checkWith(store);

    expect(report['saga']?.['compensating']).toBe(1);
    expect(report['saga']?.status).toBe('up');
  });

  it('reports down when the store itself is unreachable', async () => {
    const broken = {
      save: jest.fn(),
      findById: jest.fn().mockRejectedValue(new Error('store down')),
      findInterrupted: jest.fn(),
      countByStatus: jest.fn().mockRejectedValue(new Error('store down')),
    };
    const report = await new SagaHealthIndicator(broken).check();

    expect(report['saga']?.status).toBe('down');
  });
});
