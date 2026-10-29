import { type DynamicModule, Global, Logger, Module } from '@nestjs/common';
import { REDIS, RedisModule } from '@auth/infra/redis';
import type { Redis } from 'ioredis';
import { RATE_LIMIT_CONFIG, resolveRateLimitConfig, type RateLimitConfig } from './rate-limit.config';
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
 *
 * @remarks The client is the shared one from `@auth/infra/redis`, imported here so a host
 * that only asks for rate limiting still gets a working module. The module's identity is
 * deterministic, so the same client serves the cache and the queues without a second
 * connection — one socket per process, not one per consumer of it.
 */
@Global()
@Module({})
export class RateLimitModule {
  private static readonly logger = new Logger(RateLimitModule.name);

  static register(options: { config?: Partial<RateLimitConfig> } = {}): DynamicModule {
    const config = resolveRateLimitConfig();

    return {
      module: RateLimitModule,
      imports: [RedisModule.forRoot()],
      providers: [
        { provide: RATE_LIMIT_CONFIG, useValue: { ...config, ...options } },
        {
          provide: RATE_LIMITER,
          inject: [REDIS, RATE_LIMIT_CONFIG],
          useFactory: (redis: Redis | null, resolved: RateLimitConfig): RateLimiter => {
            if (redis === null) {
              RateLimitModule.logger.warn(
                'REDIS_URL is not set; rate limiting is disabled and every request is allowed',
              );
              return new NullRateLimiter();
            }
            return new RedisRateLimiter(redis, resolved);
          },
        },
      ],
      exports: [RATE_LIMITER, RATE_LIMIT_CONFIG],
    };
  }
}
