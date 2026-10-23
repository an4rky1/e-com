import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { PrismaClientLike, PrismaService } from '@auth/infra/prisma';
import { calculateBackoff, type OutboxRecord, type OutboxStatus } from './outbox.config';
import type {
  NewOutboxEntry,
  OutboxRepositoryPort,
} from './outbox.repository.port';
import {
  OUTBOX_CONFIG,
  OUTBOX_PUBLISHER,
  OUTBOX_REPOSITORY,
  type OutboxConfig,
} from './outbox.tokens';
import type { EventPublisher } from './publisher.port';

/** Minimal shape of the generated outbox delegate; keeps this lib client-agnostic. */
interface OutboxDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  createMany(args: {
    data: Record<string, unknown>[];
    skipDuplicates: boolean;
  }): Promise<unknown>;
  findMany(args: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
}

const DEAD_LETTER_STALE_MS = 60_000;

/** DI token for the service's Prisma-backed outbox storage. */
export const OUTBOX_REPOSITORY_CONFIG = Symbol('OUTBOX_REPOSITORY_CONFIG');

/**
 * The slice of a generated client this repository needs.
 *
 * @remarks Structural on purpose: the outbox lib must not import any service's generated
 * client, or every service would be coupled to every other one's schema.
 */
interface OutboxClient extends PrismaClientLike {
  outbox_events: OutboxDelegate;
  outbox_dead_letters: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

/**
 * Narrows an arbitrary generated client to the two delegates this repository touches.
 *
 * @remarks Each service's Prisma types the `createMany`/`update` arguments differently, so an
 * exact structural match is impossible across nine clients. The narrow surface below is the
 * contract this repository actually depends on, and it is what the tests pin down.
 */
const asOutboxClient = (client: PrismaClientLike): OutboxClient =>
  client as unknown as OutboxClient;

type NewOutboxEntryLike = NewOutboxEntry;

/**
 * Prisma-backed outbox storage.
 *
 * @remarks The claim query is the heart of this class. `SKIP LOCKED` is what lets N replicas
 * poll concurrently without contending, and `locked_at` gives crashed relays a way to be
 * reclaimed — without it, a pod that dies mid-batch leaves rows in `processing` forever.
 */
@Injectable()
export class PrismaOutboxRepository implements OutboxRepositoryPort {
  private readonly logger = new Logger(PrismaOutboxRepository.name);

  constructor(
    @Inject(OUTBOX_REPOSITORY_CONFIG) private readonly prisma: PrismaService<PrismaClientLike>,
  ) {}

  private get outbox(): OutboxClient {
    return asOutboxClient(this.prisma.tx as PrismaClientLike);
  }

  private get delegate(): OutboxDelegate {
    return this.outbox.outbox_events;
  }

  async append(entry: NewOutboxEntryLike): Promise<void> {
    await this.appendMany([entry]);
  }

  /**
   * `skipDuplicates` is the whole point of `dedup_key`.
   *
   * @remarks A command that runs twice (retry, redelivery) must not enqueue the same fact
   * twice. `ON CONFLICT DO NOTHING` turns that into a no-op instead of either a duplicate
   * event or a failed transaction.
   */
  async appendMany(entries: NewOutboxEntryLike[]): Promise<void> {
    await this.delegate.createMany({
      data: entries.map((entry) => ({
        id: entry.id,
        type: entry.type,
        aggregate_type: entry.aggregateType,
        aggregate_id: entry.aggregateId,
        topic: entry.topic,
        payload: JSON.parse(entry.payload),
        dedup_key: entry.dedupKey,
        status: 'pending',
        attempts: 0,
        next_attempt_at: entry.nextAttemptAt,
        trace_id: entry.traceId,
      })),
      skipDuplicates: true,
    });
  }

  /**
   * Takes the next batch of due events, claiming them atomically.
   *
   * @remarks Claimed with a single `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)
   * ... RETURNING`, because the lock has to be part of the selection. The previous shape
   * selected pending rows and then updated them in a second statement — two transactions, with
   * nothing holding the rows between them. Two relays therefore selected the same rows, and
   * since both updates matched on `status = 'pending'`, both published the batch: exactly-once
   * became at-most-twice. Filtering on `locked_at` in the select did not help, for the same
   * reason a queue client that checks "is this message locked?" before locking it loses races.
   *
   * @remarks The statement auto-commits, so the row locks are released as soon as it returns.
   * `locked_at` is not the lock — it is the lease. A relay that dies mid-batch leaves rows
   * marked rather than locked forever, and {@link reclaimStale} hands them to the next replica.
   */
  async claimBatch(limit: number): Promise<OutboxRecord[]> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - DEAD_LETTER_STALE_MS);

    const rows = (await this.outbox.$queryRaw`
      UPDATE outbox_events
      SET locked_at = ${now}
      WHERE id IN (
        SELECT id
        FROM outbox_events
        WHERE status = 'pending'
          AND next_attempt_at <= ${now}
          AND (locked_at IS NULL OR locked_at < ${staleBefore})
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, type, aggregate_id, topic, payload, status, attempts,
                next_attempt_at, trace_id, last_error, created_at, published_at
    `) as unknown as Record<string, unknown>[];

    return rows.map((row) => this.toRecord(row));
  }

  async markPublished(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.delegate.updateMany({
      where: { id: { in: ids } },
      data: { status: 'published', published_at: new Date(), locked_at: null, last_error: null },
    });
  }

  async markFailed(id: string, error: string, nextAttemptAt: Date): Promise<void> {
    await this.delegate.update({
      where: { id },
      data: {
        status: 'pending',
        last_error: error.slice(0, 2_000),
        next_attempt_at: nextAttemptAt,
        locked_at: null,
        attempts: { increment: 1 },
      },
    });
  }

  /**
   * Dead-letters the row and copies it to `outbox_dead_letters`.
   *
   * @remarks Both writes are in one transaction: a dead-letter row without the status change
   * would be replayed forever, and a status change without the copy would lose the payload
   * that an operator needs to diagnose it.
   */
  async markDeadLettered(id: string, error: string): Promise<void> {
    const row = await this.delegate.findMany({ where: { id }, take: 1 });
    const record = row[0];
    if (!record) return;

    await this.prisma.runInTransaction(async (client) => {
      await asOutboxClient(client as unknown as PrismaClientLike).outbox_events.update({
        where: { id },
        data: {
          status: 'dlq',
          last_error: error.slice(0, 2_000),
          locked_at: null,
          published_at: new Date(),
        },
      });

      await asOutboxClient(client as unknown as PrismaClientLike).outbox_dead_letters.create({
        data: {
          outbox_id: id,
          reason: String(record.type),
          payload: record.payload,
          last_error: error.slice(0, 2_000),
          attempts: Number(record.attempts ?? 0) + 1,
          trace_id: record.trace_id ? String(record.trace_id) : null,
        },
      });
    });
  }

  async reclaimStale(olderThan: Date): Promise<number> {
    const { count } = await this.delegate.updateMany({
      where: { status: 'pending', locked_at: { lt: olderThan } },
      data: { locked_at: null },
    });
    return count;
  }

  async cleanup(retentionHours: number): Promise<number> {
    const cutoff = new Date(Date.now() - retentionHours * 3_600_000);
    const { count } = await this.delegate.deleteMany({
      where: { status: 'published', published_at: { lt: cutoff } },
    });
    return count;
  }

  async countByStatus(status: OutboxStatus): Promise<number> {
    return this.delegate.count({ where: { status } });
  }

  private toRecord(row: Record<string, unknown>): OutboxRecord {
    // `payload` is `jsonb`, which the driver hands back as an already-parsed object. Raw SQL does
    // not promise that — the same column can arrive as a string — so the shape is checked rather
    // than assumed, and a string is used as-is instead of being re-quoted into a JSON literal.
    const payload = row.payload;
    return {
      id: String(row.id),
      topic: String(row.topic),
      partitionKey: String(row.aggregate_id),
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      status: String(row.status) as OutboxStatus,
      attempts: Number(row.attempts ?? 0),
      nextAttemptAt: new Date(row.next_attempt_at as string),
      traceId: row.trace_id ? String(row.trace_id) : undefined,
      lastError: row.last_error ? String(row.last_error) : undefined,
      createdAt: new Date(row.created_at as string),
      publishedAt: row.published_at ? new Date(row.published_at as string) : undefined,
    };
  }
}

/**
 * Drains the outbox into the broker.
 *
 * @remarks Uses a self-rescheduling `setTimeout` rather than `setInterval`: with an interval
 * a slow batch overlaps the next tick, and a broker outage accumulates unbounded overlapping
 * sends against an already-stalled connection.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private draining = false;

  constructor(
    @Inject(OUTBOX_REPOSITORY) private readonly repository: OutboxRepositoryPort,
    @Inject(OUTBOX_PUBLISHER) private readonly publisher: EventPublisher,
    @Inject(OUTBOX_CONFIG) private readonly config: OutboxConfig,
  ) {}

  /**
   * Starts the loop.
   *
   * @remarks Hooked to `onApplicationBootstrap`, not the constructor: a provider whose
   * startup hook nothing injects is never instantiated, and a relay that never starts is
   * indistinguishable from an outbox silently swallowing every event.
   */
  onApplicationBootstrap(): void {
    if (!this.config.enabled) {
      this.logger.warn('Outbox relay is disabled; events will accumulate unpublished');
      return;
    }
    this.start();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stop();
    this.draining = true;

    try {
      const pending = await this.repository.countByStatus('pending');
      if (pending > 0) {
        this.logger.warn(
          `Shutdown with ${pending} unpublished event(s); they stay in the outbox for the next replica`,
        );
      }
    } catch (error) {
      this.logger.error('Failed to count pending outbox events during shutdown', error);
    }
  }

  /** Processes one batch. Public so tests can drive the relay deterministically. */
  async tick(): Promise<number> {
    await this.repository.reclaimStale(new Date(Date.now() - DEAD_LETTER_STALE_MS));

    const batch = await this.repository.claimBatch(this.config.batchSize);
    for (const record of batch) {
      await this.deliver(record);
    }
    return batch.length;
  }

  private async deliver(record: OutboxRecord): Promise<void> {
    try {
      await this.publisher.send(record.topic, record.payload, {
        partitionKey: record.partitionKey,
        traceId: record.traceId,
        eventId: record.id,
      });
      await this.repository.markPublished([record.id]);
    } catch (error) {
      // One bad event must not stop the batch: the rest were already claimed and would
      // otherwise sit locked until the next restart.
      const message = error instanceof Error ? error.message : String(error);
      const attempts = record.attempts + 1;

      if (attempts >= this.config.maxRetries) {
        await this.repository.markDeadLettered(record.id, message);
        this.logger.error(
          `Outbox event ${record.id} (${record.topic}) exhausted ${attempts} attempts; dead-lettered`,
        );
        return;
      }

      const delay = calculateBackoff(
        attempts,
        this.config.baseRetryDelayMs,
        this.config.maxRetryDelayMs,
      );
      await this.repository.markFailed(record.id, message, new Date(Date.now() + delay));
      this.logger.warn(
        `Outbox event ${record.id} (${record.topic}) failed (attempt ${attempts}); retry in ${delay}ms`,
      );
    }
  }

  private schedule(delayMs: number): void {
    if (!this.running || this.draining) return;

    this.timer = setTimeout(() => {
      void this.tick()
        .then((processed) => {
          // An empty or partial batch means the backlog is drained: back off to the base
          // interval. A full batch means work is waiting, so poll again immediately.
          this.schedule(
            processed === 0 || processed < this.config.batchSize
              ? this.config.pollIntervalMs
              : 0,
          );
        })
        .catch((error) => {
          // A relay that stops on the first unexpected error stops publishing for the
          // lifetime of the process, with nothing to signal it.
          this.logger.error('Outbox relay tick failed; continuing', error);
          this.schedule(this.config.pollIntervalMs);
        });
    }, delayMs);

    // Never let the poll timer hold the event loop open.
    this.timer.unref?.();
  }
}

/**
 * Reports backlog depth.
 *
 * @remarks Deliberately a plain class rather than a `HealthIndicator` subclass: it is
 * constructed through the module factory, not by Nest's decorator scan, and the base class's
 * `withStatus` helper is not needed at a single call site.
 */
export class OutboxHealthIndicator {
  constructor(private readonly repository: OutboxRepositoryPort) {}

  async check(): Promise<Record<string, { status: string; [key: string]: unknown }>> {
    const [pending, deadLettered] = await Promise.all([
      this.repository.countByStatus('pending'),
      this.repository.countByStatus('dlq'),
    ]);

    // A non-zero dead-letter count is a real problem but does not stop the service serving
    // traffic, so this reports `degraded` rather than `down`.
    return {
      outbox: {
        status: deadLettered > 0 ? 'degraded' : 'up',
        pending,
        deadLettered,
      },
    };
  }
}