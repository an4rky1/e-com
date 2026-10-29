import { isTerminal, type SagaStatus } from './saga.config';
import {
  SagaConflictError,
  type SagaInstance,
  type SagaStorePort,
} from './saga.store.port';

/**
 * Process-local saga store, for tests and for deployments that opted out of durability.
 *
 * @remarks Same posture as the outbox's in-memory sibling: a Map and a version check. The
 * version check is implemented here too, not skipped, because the runner's correctness —
 * including its behaviour when two owners race — is exercised against this store in the unit
 * suite, and a lax in-memory double would let a real concurrency bug pass green.
 */
export class InMemorySagaStore implements SagaStorePort {
  private readonly instances = new Map<string, SagaInstance>();

  async save(instance: SagaInstance): Promise<void> {
    const stored = this.instances.get(instance.sagaId) ?? null;
    const expected = stored === null ? 1 : stored.version + 1;
    if (instance.version !== expected) {
      throw new SagaConflictError(instance.sagaId, expected);
    }
    this.instances.set(instance.sagaId, { ...instance });
  }

  async findById(sagaId: string): Promise<SagaInstance | null> {
    return this.instances.get(sagaId) ?? null;
  }

  async findInterrupted(olderThan: Date): Promise<SagaInstance[]> {
    return [...this.instances.values()].filter(
      (instance) =>
        !isTerminal(instance.status) && instance.updatedAt < olderThan,
    );
  }

  async countByStatus(status: SagaStatus): Promise<number> {
    return [...this.instances.values()].filter(
      (instance) => instance.status === status,
    ).length;
  }
}
