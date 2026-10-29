import { type DynamicModule, Global, Logger, Module } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS, REDIS_CONFIG, resolveRedisConfig, type RedisConfig } from './redis.config';
import { RedisService } from './redis.service';
import { RedisHealthIndicator } from './redis.health';

/**
 * The process-wide Redis client.
 *
 * @remarks `forRoot()` takes no options and reads the environment when Nest evaluates the
 * dynamic module. Deterministic metadata means several consumers (`RateLimitModule`,
 * `CacheModule`, `QueueModule`, the host app) can each list `RedisModule.forRoot()` in their
 * imports and Nest still builds exactly one module — one provider set, one connection.
 *
 * @remarks Redis being absent is a warning, not a boot failure. The consumers of this client
 * all have defined degraded behaviours — the limiter allows, the cache misses, the queue does
 * not start — and taking a whole service down because a shared cache is missing would trade
 * a degraded component for no service at all. The warning exists so the degradation is
 * visible at boot rather than discovered in a dashboard.
 */
@Global()
@Module({})
export class RedisModule {
  private static readonly logger = new Logger(RedisModule.name);

  static forRoot(): DynamicModule {
    const config = resolveRedisConfig();

    return {
      module: RedisModule,
      providers: [
        { provide: REDIS_CONFIG, useValue: config },
        {
          provide: REDIS,
          useFactory: (): Redis | null => RedisModule.createClient(config),
        },
        RedisService,
        RedisHealthIndicator,
      ],
      exports: [REDIS, REDIS_CONFIG, RedisService, RedisHealthIndicator],
    };
  }

  private static createClient(config: RedisConfig): Redis | null {
    if (config.url === null) {
      RedisModule.logger.warn(
        'REDIS_URL is not set; the shared Redis client is absent and its consumers will degrade',
      );
      return null;
    }

    const client = new Redis(config.url, {
      maxRetriesPerRequest: config.maxRetriesPerRequest,
      enableOfflineQueue: config.enableOfflineQueue,
      connectTimeout: config.connectTimeoutMs,
    });
    // ioredis emits `error` on every failed reconnect. Without a listener the first blip is
    // an unhandled error event, and an unhandled error event is a dead process.
    client.on('error', (error: Error) => {
      RedisModule.logger.warn(`Redis connection error: ${error.message}`);
    });
    return client;
  }
}
