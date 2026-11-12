import { type DynamicModule, Global, Module } from '@nestjs/common';
import { REDIS, RedisModule } from '@auth/infra/redis';
import type { Redis } from 'ioredis';
import {
  LOCKING_CONFIG,
  resolveLockingConfig,
  type LockingConfig,
} from './distributed-locking.config';
import { DistributedLockingService } from './distributed-locking.service';

/**
 * A mutex spanning every replica of a service.
 *
 * @remarks Redis is optional at boot: without it the lock degrades to a pass-through and
 * the caller runs unguarded rather than deadlocked — the same degraded mode the rate
 * limiter chooses, because a missing cache should not take a service down. Callers that
 * treat the lock as load-bearing (a cart merge, a double-cron guard) must decide for
 * themselves whether unguarded execution is acceptable for their invariant.
 */
@Global()
@Module({})
export class DistributedLockingModule {
  static register(options: { config?: Partial<LockingConfig> } = {}): DynamicModule {
    const config = resolveLockingConfig();

    return {
      module: DistributedLockingModule,
      imports: [RedisModule.forRoot()],
      providers: [
        { provide: LOCKING_CONFIG, useValue: { ...config, ...options } },
        {
          provide: DistributedLockingService,
          inject: [REDIS, LOCKING_CONFIG],
          useFactory: (redis: Redis | null, resolved: LockingConfig) =>
            new DistributedLockingService(redis, resolved),
        },
      ],
      exports: [DistributedLockingService, LOCKING_CONFIG],
    };
  }
}
