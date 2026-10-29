import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ISagaStep, SagaExecutionError } from '@auth/core';
import {
  calculateBackoff,
  RecoveryMode,
  SagaStatus,
} from './saga.config';
import { SAGA_CONFIG, SAGA_STORE, type SagaConfig } from './saga.tokens';
import {
  SagaConflictError,
  type SagaInstance,
  type SagaStorePort,
} from './saga.store.port';

/**
 * A step, plus the two knobs the durable runner needs on top of the in-memory primitive.
 *
 * @remarks `timeoutMs` and `maxAttempts` are per-step because a saga's steps are not equal:
 * a gRPC call to a billing service wants a short timeout and a couple of retries, while a
 * slow backfill wants a long timeout and one attempt. Falling back to the configured
 * defaults keeps a definition honest about only the steps that differ.
 */
export interface SagaStepDefinition<TContext> extends ISagaStep<TContext> {
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
}

/**
 * A named sequence of steps, registered with the runner under `type`.
 *
 * @remarks `type` is what a recovered instance is looked up by, so it must be stable across
 * deploys: renaming it strands every in-flight instance of the old name. The context must be
 * JSON-serialisable — it is persisted after every step — and steps must be idempotent, because
 * recovery re-executes the step an interrupted process was in the middle of.
 */
export interface SagaDefinition<TContext> {
  readonly type: string;
  readonly steps: readonly SagaStepDefinition<TContext>[];
}

export interface SagaRunOptions {
  readonly sagaId?: string;
  readonly correlationId?: string;
}

export interface SagaRunResult<TContext> {
  readonly sagaId: string;
  readonly status: SagaStatus;
  readonly context: TContext;
  readonly failedStep?: string;
}

/** A step that outran its budget. Subclassed so recovery can tell timeout from failure. */
export class SagaStepTimeoutError extends Error {
  override readonly name = 'SagaStepTimeoutError';

  constructor(step: string, timeoutMs: number) {
    super(`saga step "${step}" timed out after ${timeoutMs}ms`);
  }
}

/** What one recovery pass reports, for a boot log or a metric. */
export interface SagaRecoveryReport {
  readonly scanned: number;
  readonly resumed: number;
  readonly compensated: number;
  readonly failed: number;
  readonly skipped: number;
}

/**
 * The durable saga engine.
 *
 * @remarks The in-memory {@link import('@auth/core').SagaOrchestrator} answers "run these steps
 * and undo them if one fails" inside a single process. That primitive is correct only while
 * nothing can kill the process mid-run, and in a service mesh something always can. What makes
 * this a *runner* rather than a taller orchestrator is the store: every state transition —
 * step advanced, attempt spent, compensation entered — is written before the next action, so a
 * process that dies between two steps leaves behind a record the next process can pick up.
 *
 * @remarks Concurrency is settled by the store's optimistic version, not by a lock. A runner
 * that lost the race gets {@link SagaConflictError} and stops touching the instance; the winner
 * owns it. A lock would leave the instance orphaned when the holder dies without unlocking,
 * which is precisely the failure this engine exists to survive.
 */
@Injectable()
export class SagaRunner {
  private readonly logger = new Logger(SagaRunner.name);
  private readonly registry = new Map<string, SagaDefinition<Record<string, unknown>>>();

  constructor(
    @Inject(SAGA_STORE) private readonly store: SagaStorePort,
    @Inject(SAGA_CONFIG) private readonly config: SagaConfig,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  /**
   * Makes a definition recoverable by its `type`.
   *
   * @remarks Registration is explicit rather than a side effect of importing the definition,
   * because recovery must never depend on module load order: an instance is resumed only if
   * the type it was started with is registered in this process.
   */
  register<TContext extends Record<string, unknown>>(
    definition: SagaDefinition<TContext>,
  ): void {
    if (definition.type.trim().length === 0) {
      throw new Error('saga type must be a non-empty string');
    }
    this.registry.set(
      definition.type,
      definition as unknown as SagaDefinition<Record<string, unknown>>,
    );
  }

  registeredTypes(): string[] {
    return [...this.registry.keys()];
  }

  /**
   * Runs a saga to completion, compensating in reverse if a step cannot be made to succeed.
   *
   * @remarks The instance is created and persisted *before* the first step runs, so a crash
   * during step zero is as recoverable as a crash during step three.
   */
  async run<TContext extends Record<string, unknown>>(
    definition: SagaDefinition<TContext>,
    context: TContext,
    options: SagaRunOptions = {},
  ): Promise<SagaRunResult<TContext>> {
    this.register(definition);

    const now = new Date();
    let instance: SagaInstance = {
      sagaId: options.sagaId ?? crypto.randomUUID(),
      sagaType: definition.type,
      status: SagaStatus.RUNNING,
      stepIndex: 0,
      context: { ...context },
      attempts: 0,
      lastError: null,
      ...(options.correlationId ? { correlationId: options.correlationId } : {}),
      version: 1,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
    };
    await this.store.save(instance);

    try {
      instance = await this.drive(definition, instance);
    } catch (error) {
      if (error instanceof SagaConflictError) {
        // Another process claimed this instance — most likely a recovery sweeper that
        // decided we were stale. Its owner is now, so the local run simply stops.
        this.logger.warn(
          `saga ${instance.sagaId}: ownership lost to another process; abandoning local run`,
        );
        throw error;
      }

      // `drive` persisted its own progress; the local `instance` still holds the pre-run
      // value. Reloading is what tells the compensation which steps actually ran.
      const latest = await this.store.findById(instance.sagaId);
      if (latest === null) {
        throw error;
      }
      instance = latest;

      const failedStep =
        error instanceof SagaExecutionError ? error.failedStep : 'unknown';
      instance = await this.compensate(definition, instance, failedStep, error);
      throw new SagaExecutionError(
        instance.sagaId,
        failedStep,
        error,
        instance.status === SagaStatus.FAILED ? [new Error(instance.lastError ?? 'compensation failed')] : [],
      );
    }

    return {
      sagaId: instance.sagaId,
      status: instance.status,
      context: instance.context as TContext,
    };
  }

  /**
   * Finishes sagas whose owner died mid-run.
   *
   * @remarks Scans for instances untouched for longer than the staleness window, claims each
   * one by writing its next version, and either resumes it (default) or compensates it. A
   * claim that loses the race is skipped: another replica is already on it.
   *
   * @remarks Instances whose type is not registered in this process are left alone rather
   * than failed — this replica may simply not have the code, and a peer that does will come
   * along. Only the staleness window bounds how long they wait.
   */
  async recover(mode: RecoveryMode = this.config.recoveryMode): Promise<SagaRecoveryReport> {
    const cutoff = new Date(Date.now() - this.config.staleAfterMs);
    const interrupted = await this.store.findInterrupted(cutoff);

    let resumed = 0;
    let compensated = 0;
    let failed = 0;
    let skipped = 0;

    for (const stale of interrupted) {
      const definition = this.registry.get(stale.sagaType);
      if (!definition) {
        this.logger.warn(
          `saga ${stale.sagaId}: type "${stale.sagaType}" is not registered in this process; leaving it for a peer`,
        );
        skipped += 1;
        continue;
      }

      let instance: SagaInstance;
      try {
        instance = await this.claim(stale);
      } catch (error) {
        if (error instanceof SagaConflictError) {
          skipped += 1;
          continue;
        }
        throw error;
      }

      try {
        if (mode === RecoveryMode.COMPENSATE || instance.status === SagaStatus.COMPENSATING) {
          instance = await this.compensate(
            definition,
            instance,
            instance.lastError ?? 'interrupted',
            new Error(instance.lastError ?? 'interrupted'),
          );
          compensated += 1;
        } else {
          // Resume: re-execute the step the dead process was on. Steps are idempotent by
          // contract, so re-running one that half-finished is safe.
          try {
            instance = await this.drive(definition, instance);
            resumed += 1;
          } catch (error) {
            // A resumed step that cannot succeed is a saga that must be undone, exactly as
            // if the failure had happened inline. `drive` persisted its own progress, so the
            // local copy is stale — reload before compensating, or the first undo write
            // conflicts and the instance is left `running` to be swept again forever.
            const latest = await this.store.findById(instance.sagaId);
            if (latest === null) throw error;
            const failedStep =
              error instanceof SagaExecutionError ? error.failedStep : 'unknown';
            instance = await this.compensate(definition, latest, failedStep, error);
            compensated += 1;
          }
        }
        this.logger.log(
          `saga ${instance.sagaId}: recovered via ${mode} to status "${instance.status}"`,
        );
      } catch (error) {
        // `compensate` marks the instance failed when an undo cannot land. Either way the
        // instance is settled — one bad saga must not abort the rest of the sweep.
        failed += 1;
        this.logger.error(
          `saga ${instance.sagaId}: recovery failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return { scanned: interrupted.length, resumed, compensated, failed, skipped };
  }

  async findById(sagaId: string): Promise<SagaInstance | null> {
    return this.store.findById(sagaId);
  }

  /**
   * Executes steps forward until the saga settles or a step exhausts its budget.
   *
   * @remarks Persist-after-every-transition, not persist-at-the-end. The write after a step
   * succeeds is what lets recovery skip that step; the write of the attempt count before a
   * retry is what stops a crash loop from granting a step an unbounded number of tries.
   */
  private async drive(
    definition: SagaDefinition<Record<string, unknown>>,
    instance: SagaInstance,
  ): Promise<SagaInstance> {
    let current = instance;

    while (current.stepIndex < definition.steps.length) {
      const step = definition.steps[current.stepIndex];
      const maxAttempts = step.maxAttempts ?? this.config.stepMaxAttempts;
      const timeoutMs = step.timeoutMs ?? this.config.stepTimeoutMs;

      let lastError: unknown;
      let succeeded = false;

      for (let attempt = current.attempts; attempt < maxAttempts; attempt += 1) {
        current = await this.persist({
          ...current,
          attempts: attempt,
        });

        try {
          const nextContext = await this.withTimeout(
            step.execute(current.context),
            timeoutMs,
            step.name,
          );
          current = await this.persist({
            ...current,
            context: nextContext,
            stepIndex: current.stepIndex + 1,
            attempts: 0,
            lastError: null,
          });
          succeeded = true;
          break;
        } catch (error) {
          lastError = error;
          const isLast = attempt === maxAttempts - 1;
          if (isLast) break;

          const delay = calculateBackoff(
            attempt,
            this.config.baseRetryDelayMs,
            this.config.maxRetryDelayMs,
          );
          this.logger.warn(
            `saga ${current.sagaId} step "${step.name}" failed (attempt ${attempt + 1}/${maxAttempts}); retry in ${delay}ms: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          await this.sleep(delay);
          // The attempt counter is written on the next loop iteration; reloading keeps the
          // in-memory copy aligned with what the store will accept.
          current = { ...current, attempts: attempt + 1 };
        }
      }

      if (succeeded) continue;

      this.logger.error(
        `saga ${current.sagaId} step "${step.name}" exhausted ${maxAttempts} attempt(s)`,
      );
      throw new SagaExecutionError(
        current.sagaId,
        step.name,
        lastError instanceof Error ? lastError : new Error(String(lastError)),
        [],
      );
    }

    if (current.status === SagaStatus.RUNNING) {
      current = await this.persist({
        ...current,
        status: SagaStatus.COMPLETED,
        completedAt: new Date(),
      });
    }
    return current;
  }

  /**
   * Undoes the steps that ran, newest first.
   *
   * @remarks Each compensation gets the same timeout and retry budget as a forward step: an
   * undo that fails once is exactly as likely to succeed on a second try as a forward step,
   * and giving up on the first failure is how "half-registered user" survives a runner that
   * was supposed to prevent it.
   *
   * @remarks A compensation that exhausts its budget marks the instance `failed` rather than
   * `compensated`. The distinction is the whole point of the health indicator: `compensated`
   * means the world is consistent again, `failed` means a human has to look.
   */
  private async compensate(
    definition: SagaDefinition<Record<string, unknown>>,
    instance: SagaInstance,
    failedStep: string,
    cause: unknown,
  ): Promise<SagaInstance> {
    let current = await this.persist({
      ...instance,
      status: SagaStatus.COMPENSATING,
      lastError: cause instanceof Error ? cause.message : String(cause),
    });

    // Only steps before the failed one ran; `stepIndex` is the count of successes.
    const executed = definition.steps.slice(0, current.stepIndex).reverse();
    const errors: unknown[] = [];

    for (const step of executed) {
      const timeoutMs = step.timeoutMs ?? this.config.stepTimeoutMs;
      const maxAttempts = step.maxAttempts ?? this.config.stepMaxAttempts;
      let compensated = false;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          const nextContext = await this.withTimeout(
            step.compensate(current.context),
            timeoutMs,
            `${step.name} (compensate)`,
          );
          current = await this.persist({
            ...current,
            context: nextContext,
          });
          compensated = true;
          break;
        } catch (error) {
          if (attempt === maxAttempts - 1) {
            errors.push(error);
            break;
          }
          const delay = calculateBackoff(
            attempt,
            this.config.baseRetryDelayMs,
            this.config.maxRetryDelayMs,
          );
          await this.sleep(delay);
        }
      }

      if (!compensated) {
        this.logger.error(
          `saga ${current.sagaId}: compensation of "${step.name}" failed after ${maxAttempts} attempt(s)`,
        );
      }
    }

    const failed = errors.length > 0;
    return this.persist({
      ...current,
      status: failed ? SagaStatus.FAILED : SagaStatus.COMPENSATED,
      completedAt: new Date(),
      lastError: failed
        ? `compensation failed for ${errors.length} step(s): ${describe(errors[0])}`
        : current.lastError,
    });
  }

  /**
   * Takes ownership of a stale instance by writing the next version.
   *
   * @remarks The claim is a write, not a read-then-lock: the optimistic version means exactly
   * one process's claim succeeds, and that process owns the instance until it settles it.
   */
  private async claim(stale: SagaInstance): Promise<SagaInstance> {
    const instance: SagaInstance = {
      ...stale,
      // A fresh attempt budget on recovery: the dead process's attempts were spent against
      // its own failures, and a deployment since then may have fixed the cause.
      attempts: 0,
      version: stale.version + 1,
      updatedAt: new Date(),
    };
    await this.store.save(instance);
    return instance;
  }

  private async persist(instance: SagaInstance): Promise<SagaInstance> {
    const next: SagaInstance = {
      ...instance,
      version: instance.version + 1,
      updatedAt: new Date(),
    };
    await this.store.save(next);
    return next;
  }

  /**
   * Races a step against a timer.
   *
   * @remarks A step that hangs — a gRPC peer that accepts the connection and never answers —
   * is indistinguishable from a slow step unless something imposes a budget. The timer is the
   * budget; the retry loop then decides whether the timeout is worth another try.
   */
  private async withTimeout<T>(
    work: Promise<T>,
    timeoutMs: number,
    label: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new SagaStepTimeoutError(label, timeoutMs));
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
