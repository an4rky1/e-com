import { type DynamicModule, Global, Logger, Module } from '@nestjs/common';
import { REDIS, RedisModule } from '@auth/infra/redis';
import type { Redis } from 'ioredis';
import { CACHE_CONFIG, CACHE_SERVICE, resolveCacheConfig } from './cache.config';
import { CacheService } from './cache.service';

/**
 * A key/value cache on the shared Redis connection.
 *
 * @remarks `RedisModule.forRoot()` is listed in the imports rather than left to the host: the
 * module's identity is deterministic, so the host app listing it too still yields one
 * provider set and one connection. A host that forgets it is not what breaks this module —
 * an unresolvable token fails the boot with a message naming it.
 *
 * @remarks A null client from `infra/redis` (no `REDIS_URL`) is passed through to
 * `CacheService`, which degrades to always-miss. Booting the cache against no server is a
 * supported state: a service must be able to run where Redis has not been provisioned yet.
 */
@Global()
@Module({})
export class CacheModule {
  private static readonly logger = new Logger(CacheModule.name);

  static forRoot(): DynamicModule {
    const config = resolveCacheConfig();

    return {
      module: CacheModule,
      imports: [RedisModule.forRoot()],
      providers: [
        { provide: CACHE_CONFIG, useValue: config },
        {
          provide: CACHE_SERVICE,
          inject: [REDIS],
          useFactory: (client: Redis | null): CacheService => {
            if (client === null && config.enabled) {
              CacheModule.logger.warn(
                'Redis is not configured; the cache will miss on every read (set CACHE_ENABLED=false to silence this)',
              );
            }
            return new CacheService(config, client);
          },
        },
      ],
      exports: [CACHE_SERVICE, CACHE_CONFIG],
    };
  }
}
