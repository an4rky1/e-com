import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { DistributedLockingService } from '@auth/infra/distributed-locking';
import { SCHEDULER_CONFIG, type SchedulerConfig } from './scheduler-cron.config';

interface Job {
  name: string;
  intervalMs: number;
  timer: NodeJS.Timeout;
  /** A tick skipped while the previous run is still in flight on this replica. */
  running: boolean;
}

/**
 * Interval jobs that fire exactly once per fleet, not once per replica.
 *
 * @remarks A bare `setInterval` in every replica multiplies side effects by the replica
 * count, and the naive fix — a per-instance flag — only stops self-overlap. The guard is a
 * distributed lock keyed by job name with a TTL equal to the interval: whoever grabs the
 * key runs the tick, everyone else skips. The lock doubles as the overlap guard: while a
 * run holds it, the next tick on the same replica fails `tryLock` and skips.
 */
@Injectable()
export class SchedulerCronService implements OnModuleDestroy {
  private static readonly logger = new Logger(SchedulerCronService.name);
  private readonly jobs = new Map<string, Job>();

  constructor(
    @Inject(DistributedLockingService) private readonly locks: DistributedLockingService,
    @Inject(SCHEDULER_CONFIG) private readonly config: SchedulerConfig,
  ) {}

  /**
   * Schedules `fn` every `intervalMs`, gated by the fleet-wide lock.
   *
   * @remarks The first fire happens one interval from now — a job registered during boot
   * must not race the warm-up of the very resources it intends to manage.
   */
  register(name: string, intervalMs: number, fn: () => Promise<void>): void {
    if (!this.config.enabled) {
      SchedulerCronService.logger.log(`scheduler disabled; job "${name}" will not run`);
      return;
    }
    if (this.jobs.has(name)) {
      throw new Error(`Cron job "${name}" is already registered`);
    }
    if (intervalMs < 1_000) {
      throw new Error(`Cron job "${name}" interval must be at least 1000ms`);
    }

    const job: Job = {
      name,
      intervalMs,
      running: false,
      timer: setInterval(() => void this.tick(job, fn), intervalMs),
    };
    job.timer.unref?.();
    this.jobs.set(name, job);
  }

  private async tick(job: Job, fn: () => Promise<void>): Promise<void> {
    if (job.running) {
      SchedulerCronService.logger.debug(
        `job "${job.name}" still running; skipping this tick`,
      );
      return;
    }

    const lock = await this.locks.tryLock(`${this.config.keyPrefix}:${job.name}`, {
      ttlMs: job.intervalMs,
    });
    if (lock === null) {
      // Another replica owns this tick.
      return;
    }

    job.running = true;
    try {
      await fn();
    } catch (error) {
      // A thrown job is logged and forgotten: the next tick retries by itself, and a
      // failing timer must not take the process down.
      SchedulerCronService.logger.error(`job "${job.name}" failed`, error as Error);
    } finally {
      job.running = false;
      await lock.release();
    }
  }

  onModuleDestroy(): void {
    for (const job of this.jobs.values()) {
      clearInterval(job.timer);
    }
    this.jobs.clear();
  }
}
