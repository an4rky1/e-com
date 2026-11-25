import type { OutboxRecord, OutboxStatus } from './outbox.config';

/**
 * Storage port for the outbox.
 *
 * @remarks Mirrors the live `outbox_events` table. Two columns carry most of the weight:
 * `dedup_key` (unique per `type`) is what makes re-appending the same fact idempotent, and
 * `locked_at` is what a relay writes while it owns a row.
 */
export interface OutboxRepositoryPort {
  /**
   * Inserts a pending row inside the caller's transaction.
   *
   * @remarks A duplicate `dedup_key`/`type` is not an error — it means the same fact was
   * appended twice (a retried command, a redelivered message) and the second write is a
   * no-op. Failing here would turn an at-least-once producer into a lost transaction.
   */
  append(entry: NewOutboxEntry): Promise<void>;

  appendMany(entries: NewOutboxEntry[]): Promise<void>;

  /**
   * Claims a batch for publishing.
   *
   * @remarks Implementations must use `FOR UPDATE SKIP LOCKED`. The relay count equals the
   * pod count, so without it two replicas block on the same rows and throughput collapses to
   * a single relay's rate.
   */
  claimBatch(limit: number): Promise<OutboxRecord[]>;

  markPublished(ids: string[]): Promise<void>;

  markFailed(id: string, error: string, nextAttemptAt: Date): Promise<void>;

  /** Moves the row into `outbox_dead_letters` and marks it `dlq`. */
  markDeadLettered(id: string, error: string): Promise<void>;

  /** Reclaims rows stuck in `processing` after a relay crashed mid-batch. */
  reclaimStale(olderThan: Date): Promise<number>;

  countByStatus(status: OutboxStatus): Promise<number>;
}

export interface NewOutboxEntry {
  id: string;
  /** Integration event name, e.g. `user.registered`. Paired with `dedup_key` for uniqueness. */
  type: string;
  aggregateType: string;
  aggregateId: string;
  topic: string;
  /** Serialised envelope. */
  payload: string;
  /**
   * Stable identity of the fact, e.g. `user.registered:<userId>`. Unique per `type`, so
   * re-running a command cannot enqueue the same event twice.
   */
  dedupKey: string;
  traceId: string;
  nextAttemptAt: Date;
}