import { DynamicModule, Global, Logger, Module } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';
import {
  RATE_LIMIT_CONFIG,
  resolveRateLimitConfig,
  type RateLimitConfig,
} from './rate-limit.config';
import { RATE_LIMIT_REDIS } from './rate-limit.config';
import { RedisRateLimiter, type RateLimiter, type RateLimitResult } from './sliding-window';

export const RATE_LIMITER = Symbol('RATE_LIMITER');

/** A limiter with no backing store: every request is allowed. */
class NullRateLimiter implements RateLimiter {
  async check(_key: string, limit: number): Promise<RateLimitResult> {
    return { allowed: true, limit, remaining: 0, resetMs: 0, retryAfterSec: 0 };
  }
}

/**
 * Rate limiting for the edge.
 *
 * @remarks Redis is optional at boot and its absence is a warning, not a failure. The edge
 * authenticates every request behind this limiter, so refusing to start because a cache is
 * missing would take the whole API down for a component whose job is to degrade gracefully.
 */
@Global()
@Module({})
export class RateLimitModule {
  private static readonly logger = new Logger(RateLimitModule.name);

  static register(options: { config?: Partial<RateLimitConfig> } = {}): DynamicModule {
    const config = resolveRateLimitConfig();

    return {
      module: RateLimitModule,
      providers: [
        { provide: RATE_LIMIT_CONFIG, useValue: { ...config, ...options } },
        {
          provide: RATE_LIMIT_REDIS,
          useFactory: (): Redis | null => {
            if (!config.redisUrl) {
              RateLimitModule.logger.warn(
                'REDIS_URL is not set; rate limiting is disabled and every request is allowed',
              );
              return null;
            }
            const redis = new Redis(config.redisUrl, {
              maxRetriesPerRequest: 2,
              enableOfflineQueue: false,
            });
            redis.on('error', (error: Error) => {
              // ioredis emits this on every failed reconnect. Without a listener the first
              // blip is an unhandled error event on the client.
              RateLimitModule.logger.warn(`Redis connection error: ${error.message}`);
            });
            return redis;
          },
        },
        {
          provide: RATE_LIMITER,
          inject: [RATE_LIMIT_REDIS],
          useFactory: (redis: Redis | null): RateLimiter =>
            redis === null ? new NullRateLimiter() : new RedisRateLimiter(redis, config),
        },
      ],
      exports: [RATE_LIMITER, RATE_LIMIT_CONFIG],
    };
  }
}
