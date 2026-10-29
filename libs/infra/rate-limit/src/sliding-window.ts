import { Inject, Injectable, Logger } from '@nestjs/common';
import { REDIS } from '@auth/infra/redis';
import type { Redis } from 'ioredis';
import { RATE_LIMIT_CONFIG, type RateLimitConfig } from './rate-limit.config';

/** The verdict for one request against one key. */
export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  /** Requests left in the current window. Zero on rejection. */
  remaining: number;
  /** Epoch milliseconds when the oldest in-window entry expires. Zero when allowed. */
  resetMs: number;
  /** Seconds to wait before retrying. Zero when allowed. */
  retryAfterSec: number;
}

export interface RateLimiter {
  check(key: string, limit: number, windowSec: number): Promise<RateLimitResult>;
}

/**
 * The whole limiter, as one Lua script.
 *
 * @remarks Atomicity is the point. Counting and then deciding in two round trips is a race: two
 * requests that both read `count = limit - 1` both conclude they are the last allowed one, and
 * the limit is exceeded by exactly the concurrency that rate limiting exists to absorb. Inside
 * the script the read, the eviction and the write happen with no other command interleaved.
 *
 * @remarks A sorted set of timestamps rather than a counter. A fixed counter resets on a boundary,
 * so a client that fires a window's worth of requests straddling two boundaries gets twice the
 * budget; a bucketed counter approximates the window and is wrong at the edges. The set is
 * exact, and its size is bounded by the limit because nothing is added once the window is full.
 */
const SLIDING_WINDOW_SCRIPT = `
local now      = tonumber(ARGV[1])
local window   = tonumber(ARGV[2])
local limit    = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)

local count = redis.call('ZCARD', KEYS[1])

if count >= limit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local resetMs = 0
  if oldest[2] then
    resetMs = tonumber(oldest[2]) + window
  end
  return { 0, count, resetMs }
end

-- The member has to be unique: two requests inside the same millisecond would otherwise
-- collapse into a single entry and undercount. The score stays the timestamp, which is what the
-- eviction above and the reset computation below both read.
redis.call('ZADD', KEYS[1], now, now .. ':' .. math.random())
redis.call('PEXPIRE', KEYS[1], window)
return { 1, count + 1, 0 }
`;

/**
 * Redis-backed sliding-window limiter.
 *
 * @remarks `math.random()` is used only to disambiguate members inside one millisecond; it is
 * never a security control, and Redis seeds its own PRNG per script invocation.
 */
@Injectable()
export class RedisRateLimiter implements RateLimiter {
  private readonly logger = new Logger(RedisRateLimiter.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(RATE_LIMIT_CONFIG) private readonly config: RateLimitConfig,
  ) {}

  async check(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
    const windowMs = windowSec * 1_000;

    let outcome: [number, number, number];
    try {
      outcome = (await this.redis.eval(
        SLIDING_WINDOW_SCRIPT,
        1,
        key,
        Date.now(),
        windowMs,
        limit,
      )) as [number, number, number];
    } catch (error) {
      // Fail open by default: an edge that stops serving because a cache is unreachable has
      // traded a degraded rate limit for no service. The alternative is a hard failure, which
      // is a one-line config change for a deployment that would rather be closed than open.
      if (!this.config.failOpen) throw error;
      this.logger.warn(
        `Rate limiter unreachable; allowing the request. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { allowed: true, limit, remaining: 0, resetMs: 0, retryAfterSec: 0 };
    }

    const [allowed, count, resetMs] = outcome;

    return {
      allowed: allowed === 1,
      limit,
      remaining: allowed === 1 ? Math.max(0, limit - count) : 0,
      resetMs,
      retryAfterSec: allowed === 1 ? 0 : Math.max(0, Math.ceil((resetMs - Date.now()) / 1_000)),
    };
  }
}
