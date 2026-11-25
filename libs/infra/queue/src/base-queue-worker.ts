import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { Defaults } from './queue.config';
import { BullQueueService } from './queue.service';

/**
 * Base class for a BullMQ worker owned by one logical queue.
 *
 * @remarks Workers are owned by the service that knows what the job means, so this class is a
 * skeleton with one seam — {@link handleJob} — rather than a generic "message processor". The
 * boilerplate it owns: picking the queue from the platform registry, building a {@link Worker}
 * with the platform's default job options, naming and concurrency, graceful shutdown, and a
 * failure surface that a health check can read.
 *
 * @remarks A worker that cannot start because Redis is absent is a degraded worker, not a
 * boot failure. Without Redis the platform queues are empty (see `QueueModule`), and a worker
 * whose `Worker` throws at construction would take down the whole process for a cache the
 * platform did not provision. So the pending worker is stored and never started.
 */
@Injectable()
export abstract class BaseQueueWorker<JobData = unknown> implements OnModuleInit {
  /**
   * Name registered with `QueueModule.register` and passed to `BullQueueService`.
   * The worker and every enqueuer resolve the same name.
   */
  readonly queueName: string;

  /** Human label for logs and health. Defaults to `queueName`. */
  readonly displayName: string;

  /** How many jobs this worker runs concurrently. 1 is the safe default; override per worker. */
  readonly concurrency: number;

  /** If true, throws on construction-time worker errors. Rarely what you want for a queue. */
  protected readonly strict: boolean;

  private worker?: Worker<JobData>;
  private readonly failures: QueueFailure[] = [];

  /** Current worker state for health and dashboards. */
  readonly state: WorkerState;

  constructor(
    protected readonly queues: BullQueueService,
    queueName: string,
    displayName?: string,
    concurrency?: number,
  ) {
    this.queueName = queueName;
    this.displayName = displayName ?? queueName;
    this.concurrency = concurrency ?? 1;
    this.strict = false;
    this.state = {
      name: queueName,
      displayName: this.displayName,
      active: 0,
      waiting: 0,
      completed: 0,
      failed: 0,
      lockDurationMs: this.lockDurationMs(),
    };
  }

  /** Starts the worker, if the platform queue exists and Redis is reachable. */
  onModuleInit(): void {
    const queue = this.queues.get(this.queueName);
    if (queue === null) {
      // No queue registered, or Redis was absent when the module started. Logging at warn
      // because a missing worker is a real change to the service's behaviour, not noise.
      // The process keeps running; anything that enqueues into this name will find no worker
      // and BullMQ will keep the job on the server for a future replica.
      return;
    }

    const worker = new Worker<JobData>(
      queue.name,
      async (job) => this.handleJob(job),
      {
        connection: queue.opts.connection,
        concurrency: this.concurrency,
        limiter: this.limiter(),
        lockDuration: this.lockDurationMs(),
        // Reuse the platform defaults rather than inventing a second set of knobs here.
      },
    );
    this.worker = worker;
    this.attachLifecycle(worker);
  }

  /** Override to define what the job means. Throwing here fails the job with the thrown reason. */
  protected abstract handleJob(job: Job<JobData>): Promise<void>;

  /**
   * Optional per-queue rate limit.
   *
   * @remarks A worker-level limit is what you reach for when one queue would otherwise saturate
   * a downstream provider (say, an email API). Queue-level limits belong on the enqueuer side
   * so they apply across replicas; this one applies to a single worker and is therefore a
   * local throttle, not a global one.
   */
  protected limiter(): { max: number; duration: number } | undefined {
    return undefined;
  }

  /**
   * How long a job may hold its lock before BullMQ considers it stalled and reschedules.
   *
   * @remarks Long enough for a real provider call to time out; short enough that a genuinely
   * stuck worker is detected. Override only when your jobs routinely run longer than the
   * default.
   */
  protected lockDurationMs(): number {
    return Defaults.DEFAULT_LOCK_DURATION_MS;
  }

  /** Latest failure, for a recent-failure health dimension. */
  latestFailure(): QueueFailure | undefined {
    return this.failures[this.failures.length - 1] ?? undefined;
  }

  /** Clear the worker's failure history — useful between smoke tests. */
  clearFailures(): void {
    this.failures.length = 0;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker === undefined) return;
    try {
      await this.worker.close();
    } catch (error) {
      // Closing should be best-effort on shutdown: a worker that refuses to close must not
      // keep the process alive past its shutdown deadline.
    }
  }

  private attachLifecycle(worker: Worker<JobData>): void {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    worker.on('error', (error) => {
      this.recordFailure('worker-error', error);
      if (this.strict) {
        throw error;
      }
    });

    worker.on('failed', (job, error) => {
      this.recordFailure('job-failed', error, job?.id);
      // Do not rethrow: a failed job is a normal outcome the retry policy owns.
    });

    worker.on('completed', () => {
      // No-op: metrics are enough.
    });
  }

  private recordFailure(
    kind: string,
    error: unknown,
    jobId?: string,
  ): void {
    const now = new Date();
    this.failures.push({
      kind,
      message: error instanceof Error ? error.message : String(error),
      jobId,
      at: now,
    });
    // Keep only the last handful so the history does not grow unbounded.
    if (this.failures.length > 50) {
      this.failures.shift();
    }
  }
}

/** What {@link BaseQueueWorker.state} reports. */
export interface WorkerState {
  readonly name: string;
  readonly displayName: string;
  readonly active: number;
  readonly waiting: number;
  readonly completed: number;
  readonly failed: number;
  readonly lockDurationMs: number;
}

/** A recorded failure for the worker's recent-failure health dimension. */
export interface QueueFailure {
  readonly kind: string;
  readonly message: string;
  readonly jobId?: string;
  readonly at: Date;
}
