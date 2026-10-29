import { type DynamicModule, Global, Logger, Module } from '@nestjs/common';
import { REDIS_CONFIG, RedisModule, type RedisConfig } from '@auth/infra/redis';
import { Queue } from 'bullmq';
import type { JobsOptions } from 'bullmq';
import {
  QUEUE_CONFIG,
  QUEUE_REGISTRY,
  resolveQueueConfig,
  type QueueConfig,
} from './queue.config';
import { BullQueueService } from './queue.service';

export interface QueueModuleOptions {
  /** Queue names this process enqueues into. Workers are registered by the service that owns them. */
  queues: readonly string[];
}

/**
 * BullMQ queues on the platform's Redis.
 *
 * @remarks BullMQ opens its own connections from the same `REDIS_URL`, and that split is
 * deliberate: workers communicate through blocking commands (`BRPOPLPUSH` and friends) that
 * monopolise a connection for as long as they wait. A queue sharing the application's client
 * would park every cache read and rate-limit check behind a blocking pop. One owner per
 * connection — the shared piece is the *configuration*, so both point at the same server
 * without sharing the socket.
 *
 * @remarks Producer-side only. Which jobs exist and what handles them is the enqueuing
 * service's business; what this module owns is the connection posture, the default job
 * options and a registry that closes every queue on shutdown.
 */
@Global()
@Module({})
export class QueueModule {
  private static readonly logger = new Logger(QueueModule.name);

  static register(options: QueueModuleOptions): DynamicModule {
    const config = resolveQueueConfig();

    return {
      module: QueueModule,
      imports: [RedisModule.forRoot()],
      providers: [
        { provide: QUEUE_CONFIG, useValue: config },
        {
          provide: QUEUE_REGISTRY,
          inject: [REDIS_CONFIG],
          useFactory: (redis: RedisConfig): BullQueueService =>
            QueueModule.createRegistry(redis, config, options.queues),
        },
        // `useExisting`, not the class itself: injecting `BullQueueService` directly would make
        // Nest build a second instance whose constructor argument is unresolvable (the registry
        // map is an interface, so there is no token for it) — a service whose workers would then
        // find `queues === undefined`. The registry is the only instance; the alias keeps the
        // class usable as an injection token.
        { provide: BullQueueService, useExisting: QUEUE_REGISTRY },
      ],
      exports: [QUEUE_REGISTRY, QUEUE_CONFIG, BullQueueService],
    };
  }

  private static createRegistry(
    redis: RedisConfig,
    config: QueueConfig,
    names: readonly string[],
  ): BullQueueService {
    if (redis.url === null) {
      // Degraded, not failed: a service that cannot start without its queues is a service
      // that takes the whole process down when a cache is unprovisioned. Enqueuing returns
      // null from `get` and the caller decides — same contract as every other consumer here.
      QueueModule.logger.warn(
        'REDIS_URL is not set; BullMQ queues are not created and enqueuing will find no registry entry',
      );
      return new BullQueueService(new Map());
    }

    const queues = new Map<string, Queue>();
    for (const name of new Set(names)) {
      queues.set(
        name,
        new Queue(name, {
          // `{ url }` and nothing else: BullMQ builds its own client from it, and a second
          // set of tuned knobs here would drift from the shared client's the first time
          // either file is edited.
          connection: { url: redis.url },
          defaultJobOptions: defaultJobOptionsFor(config),
        }),
      );
    }
    return new BullQueueService(queues);
  }
}

/**
 * The retry and retention posture every queue inherits unless the caller overrides it.
 *
 * @remarks Exported as a pure function so the posture is testable without constructing a
 * Queue — which would open a connection to a server the unit suite may not have.
 */
export function defaultJobOptionsFor(
  config: QueueConfig,
  overrides?: Partial<JobsOptions>,
): JobsOptions {
  return {
    attempts: config.attempts,
    backoff: { type: 'exponential', delay: config.backoffMs },
    removeOnComplete: config.removeOnComplete,
    removeOnFail: config.removeOnFail,
    ...overrides,
  };
}
