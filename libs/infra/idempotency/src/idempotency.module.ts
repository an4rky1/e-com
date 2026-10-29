/**
 * @fileoverview Turns the idempotency mechanics into a module the edge can import.
 *
 * @remarks The storage is chosen here rather than in the service: Redis being present is a
 * deployment fact, and a module factory is the one place that fact can change which
 * implementation the container builds. Without Redis the module still boots — it hands out
 * the null storage, and every request passes through unguarded rather than failing.
 */
import { type DynamicModule, Global, Logger, Module } from '@nestjs/common';
import { REDIS, RedisModule } from '@auth/infra/redis';
import type { Redis } from 'ioredis';
import {
  IDEMPOTENCY_CONFIG,
  resolveIdempotencyConfig,
  type IdempotencyConfig,
} from './idempotency.config';
import { IdempotencyService } from './idempotency.service';
import {
  IDEMPOTENCY_STORAGE,
  NullIdempotencyStorage,
  RedisIdempotencyStorage,
  type IdempotencyStorage,
} from './idempotency.storage';

@Global()
@Module({})
export class IdempotencyModule {
  private static readonly logger = new Logger(IdempotencyModule.name);

  static register(
    options: { config?: Partial<IdempotencyConfig> } = {},
  ): DynamicModule {
    const config = { ...resolveIdempotencyConfig(), ...options.config };

    return {
      module: IdempotencyModule,
      // Deterministic metadata, so listing it alongside `RateLimitModule`'s own import of
      // the Redis module still builds exactly one connection for the process.
      imports: [RedisModule.forRoot()],
      providers: [
        { provide: IDEMPOTENCY_CONFIG, useValue: config },
        {
          provide: IDEMPOTENCY_STORAGE,
          inject: [REDIS],
          useFactory: (redis: Redis | null): IdempotencyStorage => {
            if (redis === null) {
              IdempotencyModule.logger.warn(
                'REDIS_URL is not set; idempotency protection is disabled and duplicate requests will run as they arrive',
              );
              return new NullIdempotencyStorage();
            }
            return new RedisIdempotencyStorage(redis, config);
          },
        },
        IdempotencyService,
      ],
      exports: [IDEMPOTENCY_CONFIG, IDEMPOTENCY_STORAGE, IdempotencyService],
    };
  }
}
