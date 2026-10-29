import { resolveRedisConfig } from '../src/redis.config';

describe('resolveRedisConfig', () => {
  it('treats a missing REDIS_URL as no Redis, not as an error', () => {
    const config = resolveRedisConfig({});

    expect(config.url).toBeNull();
  });

  it('reads REDIS_URL from the platform namespace, not a lookalike of its own', () => {
    const config = resolveRedisConfig({
      REDIS_URL: 'redis://cache.internal:6379',
      INFRA_REDIS_URL: 'redis://somewhere.else:6379',
    });

    expect(config.url).toBe('redis://cache.internal:6379');
  });

  it('treats a blank URL as absent — an empty string is how a rotation leaves a variable', () => {
    const config = resolveRedisConfig({ REDIS_URL: '   ' });

    expect(config.url).toBeNull();
  });

  it('exposes the connection posture that makes the limiter fail fast', () => {
    const config = resolveRedisConfig({ REDIS_URL: 'redis://localhost:6379' });

    expect(config.maxRetriesPerRequest).toBe(2);
    expect(config.enableOfflineQueue).toBe(false);
    expect(config.connectTimeoutMs).toBe(5_000);
  });

  it('honours the REDIS_* overrides', () => {
    const config = resolveRedisConfig({
      REDIS_URL: 'redis://localhost:6379',
      REDIS_MAX_RETRIES_PER_REQUEST: '5',
      REDIS_ENABLE_OFFLINE_QUEUE: 'true',
      REDIS_CONNECT_TIMEOUT_MS: '1500',
    });

    expect(config.maxRetriesPerRequest).toBe(5);
    expect(config.enableOfflineQueue).toBe(true);
    expect(config.connectTimeoutMs).toBe(1_500);
  });
});
