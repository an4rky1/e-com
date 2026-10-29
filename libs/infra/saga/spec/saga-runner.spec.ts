import { SagaExecutionError } from '@auth/core';
import { InMemorySagaStore } from '../src/in-memory-saga.store';
import { RecoveryMode, SagaStatus } from '../src/saga.config';
import { SagaRunner, type SagaDefinition } from '../src/saga-runner.service';
import { SagaConflictError, type SagaInstance } from '../src/saga.store.port';
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

const noSleep = async (): Promise<void> => undefined;

const step = (
  name: string,
  execute: (ctx: Ctx) => Promise<Ctx>,
  compensate: (ctx: Ctx) => Promise<Ctx> = async (ctx) => ctx,
  over: { timeoutMs?: number; maxAttempts?: number } = {},
) => ({ name, execute, compensate, ...over });

const twoStep = (
  first: ReturnType<typeof step>,
  second: ReturnType<typeof step>,
): SagaDefinition<Ctx> => ({ type: 'two-step', steps: [first, second] });

const runner = (store = new InMemorySagaStore(), config = CONFIG) =>
  new SagaRunner(store, config, noSleep);

const ctx = (): Ctx => ({ trail: [] });

describe('SagaRunner.run', () => {
  it('runs every step forward and marks the instance completed', async () => {
    const store = new InMemorySagaStore();
    const definition = twoStep(
      step('a', async (c) => ({ ...c, trail: [...c.trail, 'a'] })),
      step('b', async (c) => ({ ...c, trail: [...c.trail, 'b'] })),
    );

    const result = await runner(store).run(definition, ctx());

    expect(result.status).toBe(SagaStatus.COMPLETED);
    expect(result.context.trail).toEqual(['a', 'b']);

    const persisted = await store.findById(result.sagaId);
    expect(persisted?.status).toBe(SagaStatus.COMPLETED);
    expect(persisted?.stepIndex).toBe(2);
    expect(persisted?.completedAt).not.toBeNull();
  });

  it('persists the instance before the first step runs', async () => {
    const store = new InMemorySagaStore();
    let seenDuringFirstStep: SagaInstance | null = null;
    const definition = twoStep(
      step('a', async (c) => {
        // The instance must already be durable when the first step executes: a crash inside
        // step zero is as recoverable as a crash inside step three.
        seenDuringFirstStep = await store.findById('saga-x');
        return c;
      }),
      step('b', async (c) => c),
    );

    const result = await runner(store).run(definition, ctx(), { sagaId: 'saga-x' });

    expect(seenDuringFirstStep).not.toBeNull();
    expect((seenDuringFirstStep as unknown as SagaInstance).status).toBe(SagaStatus.RUNNING);
    expect(result.sagaId).toBe('saga-x');
  });

  it('threads the context from step to step', async () => {
    const definition = twoStep(
      step('a', async (c) => ({ ...c, fromA: true })),
      step('b', async (c) => {
        expect(c['fromA']).toBe(true);
        return c;
      }),
    );

    const result = await runner().run(definition, ctx());

    expect(result.context['fromA']).toBe(true);
    expect(result.status).toBe(SagaStatus.COMPLETED);
  });

  it('carries a caller-supplied sagaId and correlationId', async () => {
    const store = new InMemorySagaStore();
    const definition = twoStep(step('a', async (c) => c), step('b', async (c) => c));

    const result = await runner(store).run(definition, ctx(), {
      sagaId: 'given-id',
      correlationId: 'corr-1',
    });

    expect(result.sagaId).toBe('given-id');
    const persisted = await store.findById('given-id');
    expect(persisted?.correlationId).toBe('corr-1');
  });

  it('retries a failing step and succeeds on a later attempt', async () => {
    let attempts = 0;
    const definition = twoStep(
      step('flaky', async (c) => {
        attempts += 1;
        if (attempts < 2) throw new Error('transient');
        return c;
      }),
      step('b', async (c) => c),
    );

    const result = await runner().run(definition, ctx());

    expect(attempts).toBe(2);
    expect(result.status).toBe(SagaStatus.COMPLETED);
  });

  it('compensates in reverse order when a step exhausts its budget', async () => {
    const compensated: string[] = [];
    const definition = twoStep(
      step(
        'a',
        async (c) => c,
        async (c) => {
          compensated.push('a');
          return c;
        },
      ),
      step(
        'b',
        async () => {
          throw new Error('b is broken');
        },
        async (c) => {
          compensated.push('b');
          return c;
        },
      ),
    );

    await expect(runner().run(definition, ctx())).rejects.toThrow(SagaExecutionError);
    // `b` never succeeded, so only `a` is undone — newest first.
    expect(compensated).toEqual(['a']);
  });

  it('does not compensate a step that never ran', async () => {
    const compensated: string[] = [];
    const definition = twoStep(
      step(
        'a',
        async () => {
          throw new Error('a is broken');
        },
        async (c) => {
          compensated.push('a');
          return c;
        },
      ),
      step(
        'b',
        async (c) => c,
        async (c) => {
          compensated.push('b');
          return c;
        },
      ),
    );

    await expect(runner().run(definition, ctx())).rejects.toThrow(SagaExecutionError);
    expect(compensated).toEqual([]);
  });

  it('marks the instance compensated when every undo lands', async () => {
    const store = new InMemorySagaStore();
    const definition = twoStep(
      step('a', async (c) => c),
      step('b', async () => {
        throw new Error('boom');
      }),
    );

    await expect(runner(store).run(definition, ctx(), { sagaId: 's1' })).rejects.toThrow();
    const persisted = await store.findById('s1');

    expect(persisted?.status).toBe(SagaStatus.COMPENSATED);
    expect(persisted?.completedAt).not.toBeNull();
  });

  it('marks the instance failed when a compensation itself fails', async () => {
    const store = new InMemorySagaStore();
    const definition = twoStep(
      step('a', async (c) => c, async () => {
        throw new Error('undo is broken');
      }),
      step('b', async () => {
        throw new Error('boom');
      }),
    );

    await expect(runner(store).run(definition, ctx(), { sagaId: 's2' })).rejects.toThrow();
    const persisted = await store.findById('s2');

    expect(persisted?.status).toBe(SagaStatus.FAILED);
    expect(persisted?.lastError).toMatch(/compensation failed/);
  });

  it('names the failing step in the thrown error', async () => {
    const definition = twoStep(
      step('a', async (c) => c),
      step('b', async () => {
        throw new Error('b failed');
      }),
    );

    await expect(runner().run(definition, ctx())).rejects.toMatchObject({
      failedStep: 'b',
    });
  });

  it('retries a step that times out', async () => {
    let attempts = 0;
    const definition: SagaDefinition<Ctx> = {
      type: 'slow',
      steps: [
        step(
          'slow-step',
          async (c) => {
            attempts += 1;
            if (attempts < 2) {
              // Hangs past the step budget on the first try only.
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
            return c;
          },
          undefined,
          { timeoutMs: 20, maxAttempts: 2 },
        ),
      ],
    };

    const result = await runner().run(definition, ctx());

    expect(attempts).toBe(2);
    expect(result.status).toBe(SagaStatus.COMPLETED);
  });

  it('abandons a step that never finishes within the budget', async () => {
    const definition: SagaDefinition<Ctx> = {
      type: 'hang',
      steps: [
        step(
          'hang',
          async (c) => {
            await new Promise((resolve) => setTimeout(resolve, 500));
            return c;
          },
          undefined,
          { timeoutMs: 20, maxAttempts: 1 },
        ),
      ],
    };

    await expect(runner().run(definition, ctx())).rejects.toThrow(SagaExecutionError);
  });
});

describe('SagaRunner.recover', () => {
  /** Seeds a stale running instance, as if its owner died after step 0. */
  const seedInterrupted = async (
    store: InMemorySagaStore,
    over: Partial<SagaInstance> = {},
  ): Promise<SagaInstance> => {
    const seeded: SagaInstance = {
      sagaId: 'interrupted-1',
      sagaType: 'two-step',
      status: SagaStatus.RUNNING,
      stepIndex: 1,
      context: { trail: ['a'] },
      attempts: 0,
      lastError: null,
      // The store's first write for an id must be version 1; the rest of the shape says
      // "this instance has been running for a while".
      version: 1,
      startedAt: new Date(Date.now() - 60_000),
      updatedAt: new Date(Date.now() - 60_000),
      completedAt: null,
      ...over,
    };
    await store.save(seeded);
    return seeded;
  };

  it('resumes a stale running instance from its recorded stepIndex', async () => {
    const store = new InMemorySagaStore();
    await seedInterrupted(store);
    const r = runner(store);
    r.register(
      twoStep(
        step('a', async (c) => c),
        step('b', async (c) => ({ ...c, trail: [...c.trail, 'b'] })),
      ),
    );

    const report = await r.recover();

    expect(report).toMatchObject({ scanned: 1, resumed: 1, failed: 0 });
    const persisted = await store.findById('interrupted-1');
    expect(persisted?.status).toBe(SagaStatus.COMPLETED);
    expect(persisted?.context['trail']).toEqual(['a', 'b']);
  });

  it('re-executes the interrupted step rather than skipping it', async () => {
    const store = new InMemorySagaStore();
    // stepIndex 1 means step 0 finished and step 1 was in flight when the owner died.
    await seedInterrupted(store, { stepIndex: 1, context: { trail: [] } });
    const r = runner(store);
    const executed: string[] = [];
    r.register(
      twoStep(
        step('a', async (c) => {
          executed.push('a');
          return c;
        }),
        step('b', async (c) => {
          executed.push('b');
          return c;
        }),
      ),
    );

    await r.recover();

    // Only step 1 is re-run; step 0 is not executed a second time.
    expect(executed).toEqual(['b']);
  });

  it('gives a resumed instance a fresh attempt budget', async () => {
    const store = new InMemorySagaStore();
    await seedInterrupted(store, { stepIndex: 1, attempts: 1 });
    let attempts = 0;
    const r = runner(store);
    r.register(
      twoStep(
        step('a', async (c) => c),
        step('flaky', async (c) => {
          attempts += 1;
          if (attempts < 2) throw new Error('transient');
          return c;
        }),
      ),
    );

    const report = await r.recover();

    // The seeded instance had already spent one attempt; recovery must still grant the
    // step its full budget rather than inheriting the dead process's counter.
    expect(report.resumed).toBe(1);
    expect(attempts).toBe(2);
  });

  it('compensates a stale compensating instance rather than resuming it', async () => {
    const store = new InMemorySagaStore();
    await seedInterrupted(store, {
      status: SagaStatus.COMPENSATING,
      stepIndex: 1,
      lastError: 'b failed',
    });
    const compensated: string[] = [];
    const r = runner(store);
    r.register(
      twoStep(
        step('a', async (c) => c, async (c) => {
          compensated.push('a');
          return c;
        }),
        step('b', async (c) => c),
      ),
    );

    const report = await r.recover();

    expect(compensated).toEqual(['a']);
    expect(report.compensated).toBe(1);
    expect((await store.findById('interrupted-1'))?.status).toBe(SagaStatus.COMPENSATED);
  });

  it('leaves instances whose type is not registered for a peer', async () => {
    const store = new InMemorySagaStore();
    await seedInterrupted(store, { sagaType: 'unknown-type' });
    const r = runner(store);

    const report = await r.recover();

    expect(report).toMatchObject({ scanned: 1, skipped: 1, resumed: 0 });
    expect((await store.findById('interrupted-1'))?.status).toBe(SagaStatus.RUNNING);
  });

  it('skips instances claimed by another process', async () => {
    const store = new InMemorySagaStore();
    await seedInterrupted(store);
    const r = runner(store);
    r.register(twoStep(step('a', async (c) => c), step('b', async (c) => c)));

    // Simulate a competing replica winning the claim between scan and write.
    const originalSave = store.save.bind(store);
    jest
      .spyOn(store, 'save')
      .mockImplementation(async (instance: SagaInstance) => {
        if (instance.sagaId === 'interrupted-1' && instance.version === 2) {
          throw new SagaConflictError(instance.sagaId, 1);
        }
        return originalSave(instance);
      });

    const report = await r.recover();

    expect(report.skipped).toBe(1);
    expect(report.resumed).toBe(0);
  });

  it('does not touch instances that are not yet stale', async () => {
    const store = new InMemorySagaStore();
    await store.save({
      sagaId: 'fresh-1',
      sagaType: 'two-step',
      status: SagaStatus.RUNNING,
      stepIndex: 0,
      context: {},
      attempts: 0,
      lastError: null,
      version: 1,
      startedAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
    });
    const r = runner(store);
    r.register(twoStep(step('a', async (c) => c), step('b', async (c) => c)));

    const report = await r.recover();

    expect(report.scanned).toBe(0);
    expect((await store.findById('fresh-1'))?.status).toBe(SagaStatus.RUNNING);
  });

  it('compensates a resumed instance whose step fails again', async () => {
    const store = new InMemorySagaStore();
    await seedInterrupted(store, { stepIndex: 1 });
    const compensated: string[] = [];
    const r = runner(store);
    r.register(
      twoStep(
        step('a', async (c) => c, async (c) => {
          compensated.push('a');
          return c;
        }),
        step('b', async () => {
          throw new Error('still broken');
        }),
      ),
    );

    const report = await r.recover();

    // A resumed step that cannot succeed must be undone, not left `running` to be swept
    // again forever.
    expect(compensated).toEqual(['a']);
    expect(report.compensated).toBe(1);
    expect((await store.findById('interrupted-1'))?.status).toBe(SagaStatus.COMPENSATED);
  });

  it('honours compensate mode over resume', async () => {
    const store = new InMemorySagaStore();
    await seedInterrupted(store, { stepIndex: 1, context: { trail: ['a'] } });
    const compensated: string[] = [];
    const r = runner(store);
    r.register(
      twoStep(
        step('a', async (c) => {
          throw new Error('must not re-run');
        }, async (c) => {
          compensated.push('a');
          return c;
        }),
        step('b', async (c) => c),
      ),
    );

    const report = await r.recover(RecoveryMode.COMPENSATE);

    expect(compensated).toEqual(['a']);
    expect(report.compensated).toBe(1);
  });

  it('settles one broken saga without aborting the rest of the sweep', async () => {
    const store = new InMemorySagaStore();
    await seedInterrupted(store, {
      sagaId: 'bad',
      sagaType: 'always-fails',
      stepIndex: 0,
      context: {},
    });
    await seedInterrupted(store, { sagaId: 'good', sagaType: 'two-step' });
    const r = runner(store);
    r.register(
      twoStep(
        step('a', async (c) => c),
        step('b', async (c) => c),
      ),
    );
    r.register({
      type: 'always-fails',
      steps: [
        step('x', async () => {
          throw new Error('nope');
        }),
      ],
    });

    const report = await r.recover();

    expect(report.scanned).toBe(2);
    expect(report.resumed).toBe(1);
    expect((await store.findById('good'))?.status).toBe(SagaStatus.COMPLETED);
    // The bad saga settles (compensated with zero executed steps) rather than throwing.
    expect(['compensated', 'failed']).toContain(
      (await store.findById('bad'))?.status,
    );
  });
});
