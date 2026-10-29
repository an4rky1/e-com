import type { SagaStatus } from './saga.config';

/**
 * One saga's durable record.
 *
 * @remarks `context` is the accumulated result of the steps that already ran, and it must be
 * JSON-serialisable: the store is a database row or a Redis string, not an object graph. A
 * step that puts a Date or a class instance into the context will have it round-tripped as a
 * string, which is stated here rather than discovered in production.
 *
 * @remarks `version` is the optimistic-concurrency token. Every `save` writes `version + 1`
 * and the store rejects a write whose expected predecessor does not match — that is what
 * stops two recovery sweepers, or a sweeper and the original owner's dying write, from
 * driving the same instance forward at once.
 */
export interface SagaInstance {
  readonly sagaId: string;
  readonly sagaType: string;
  readonly status: SagaStatus;
  /** Index of the next step to execute. Steps `[0, stepIndex)` have completed. */
  readonly stepIndex: number;
  readonly context: Record<string, unknown>;
  /** Attempts spent on the current step. Reset when the step advances. */
  readonly attempts: number;
  readonly lastError: string | null;
  readonly correlationId?: string;
  readonly version: number;
  readonly startedAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
}

/**
 * Raised when a `save` loses the optimistic-concurrency race.
 *
 * @remarks Not an infrastructure accident: it is the signal that another process claimed the
 * instance, and the correct reaction is to stop touching it, not to retry.
 */
export class SagaConflictError extends Error {
  override readonly name = 'SagaConflictError';

  constructor(readonly sagaId: string, readonly storedVersion: number) {
    super(
      `saga ${sagaId}: write expected version ${storedVersion}, store holds a different one`,
    );
  }
}

export interface SagaStorePort {
  /**
   * Writes the instance if its `version` is exactly one greater than the stored version
   * (or the instance is new and starts at version 1). Throws {@link SagaConflictError} otherwise.
   */
  save(instance: SagaInstance): Promise<void>;
  findById(sagaId: string): Promise<SagaInstance | null>;
  /** Non-terminal instances whose `updatedAt` is older than the cutoff. */
  findInterrupted(olderThan: Date): Promise<SagaInstance[]>;
  countByStatus(status: SagaStatus): Promise<number>;
}
