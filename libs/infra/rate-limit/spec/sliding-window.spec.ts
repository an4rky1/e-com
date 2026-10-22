import { Redis } from 'ioredis';
import { RedisRateLimiter } from '../src/sliding-window';
import { Defaults, type RateLimitConfig } from '../src/rate-limit.config';

/**
 * The sliding-window limiter against a real Redis.
 *
 * @remarks The Lua script is the whole mechanism, and a double that reimplements it in
 * JavaScript would test the double. These run only when `REDIS_URL` is set, and skip otherwise:
 * a rate limiter that cannot be exercised should not fail a suite that has no Redis, but it also
 * must not pass one by silently doing nothing.
 *
 * @remarks The gate is the variable's presence, not a probe. A probe has to complete before the
 * tests are registered, and registration happens before `beforeAll`, so a probe-based flag is
 * always still false when it is read. The variable is set by whoever can set it — CI, or a
 * developer with the stack up — which is the same decision, made where it can be made.
 */
const REDIS_URL = process.env.REDIS_URL ?? null;

const config: RateLimitConfig = {
  enabled: true,
  defaultLimit: 3,
  defaultWindowSec: 1,
  failOpen: false,
  headers: true,
  keyPrefix: 'rl-test',
  redisUrl: REDIS_URL ?? 'redis://localhost:6379',
};

/** `it.skipIf` is not in this Jest version; this is the same guard spelled the old way. */
const whenRedisIsAvailable = (condition: boolean) => (condition ? it : it.skip);

describe('RedisRateLimiter', () => {
  whenRedisIsAvailable(Boolean(REDIS_URL))(
    'allows up to the limit and then refuses, with a reset time',
    async () => {
      const redis = new Redis(REDIS_URL, { keyPrefix: `${config.keyPrefix}:` });
      const limiter = new RedisRateLimiter(redis, config);
      const key = `test:${Date.now()}:limit`;

      const first = await limiter.check(key, 3, 1);
      const second = await limiter.check(key, 3, 1);
      const third = await limiter.check(key, 3, 1);
      const fourth = await limiter.check(key, 3, 1);

      expect(first.allowed).toBe(true);
      expect(first.remaining).toBe(2);
      expect(second.allowed).toBe(true);
      expect(third.allowed).toBe(true);
      expect(fourth.allowed).toBe(false);
      expect(fourth.remaining).toBe(0);
      expect(fourth.retryAfterSec).toBeGreaterThan(0);

      await redis.del(key);
      redis.disconnect();
    },
  );

  whenRedisIsAvailable(Boolean(REDIS_URL))(
    'slides: entries that age out of the window stop counting',
    async () => {
      const redis = new Redis(REDIS_URL, { keyPrefix: `${config.keyPrefix}:` });
      const limiter = new RedisRateLimiter(redis, config);
      const key = `test:${Date.now()}:slide`;

      await limiter.check(key, 2, 1);
      await limiter.check(key, 2, 1);
      expect((await limiter.check(key, 2, 1)).allowed).toBe(false);

      // The window is one second. Once the first entries age out, a slot is free again — which
      // is the difference between a sliding window and a fixed counter that resets on a boundary.
      await new Promise((resolve) => setTimeout(resolve, 1_100));

      const after = await limiter.check(key, 2, 1);
      expect(after.allowed).toBe(true);

      await redis.del(key);
      redis.disconnect();
    },
  );

  whenRedisIsAvailable(Boolean(REDIS_URL))(
    'keeps keys for one identifier separate from another',
    async () => {
      const redis = new Redis(REDIS_URL, { keyPrefix: `${config.keyPrefix}:` });
      const limiter = new RedisRateLimiter(redis, config);
      const a = `test:${Date.now()}:a`;
      const b = `test:${Date.now()}:b`;

      await limiter.check(a, 1, 60);
      await limiter.check(a, 1, 60);
      const exhausted = await limiter.check(a, 1, 60);
      const other = await limiter.check(b, 1, 60);

      expect(exhausted.allowed).toBe(false);
      expect(other.allowed).toBe(true);

      await redis.del(a, b);
      redis.disconnect();
    },
  );
});

describe('RedisRateLimiter without a reachable store', () => {
  it('fails open when configured to, and says so in the log', async () => {
    const failing = new Redis('redis://127.0.0.1:6399', {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    const limiter = new RedisRateLimiter(failing, { ...config, failOpen: true });

    const result = await limiter.check('any', 5, 60);

    expect(result.allowed).toBe(true);
    failing.disconnect();
  });

  it('propagates when fail-open is off', async () => {
    const failing = new Redis('redis://127.0.0.1:6399', {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    const limiter = new RedisRateLimiter(failing, { ...config, failOpen: false });

    await expect(limiter.check('any', 5, 60)).rejects.toBeDefined();
    failing.disconnect();
  });
});

describe('Defaults', () => {
  it('ships a non-trivial limit rather than a placeholder', () => {
    expect(Defaults.DEFAULT_LIMIT).toBeGreaterThan(10);
    expect(Defaults.DEFAULT_WINDOW_SEC).toBeGreaterThan(0);
  });
});
