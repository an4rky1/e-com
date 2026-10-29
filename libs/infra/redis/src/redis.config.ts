import { z } from 'zod';
import { envBoolean, envInt, readNamespacedEnv } from '@auth/platform/config';

export const REDIS = Symbol('REDIS');
export const REDIS_CONFIG = Symbol('REDIS_CONFIG');

export const Defaults = {
  /**
   * Two retries per command.
   *
   * @remarks Small on purpose. This client serves a rate limiter that fails open and a cache
   * that degrades to a miss: both need the command to *fail* quickly so their own fallbacks
   * can run, not to sit in ioredis's retry loop while the request already timed out. A
   * consumer that wants to wait is a consumer that should say so on its own connection.
   */
  MAX_RETRIES_PER_REQUEST: 2,
  /**
   * Commands issued while disconnected are rejected rather than buffered.
   *
   * @remarks An offline queue turns "Redis is down" into "every request is slow" — the buffer
   * grows until reconnect and then replays a thundering herd at a server that is still
   * recovering. Rejected commands surface the outage at the call site, where the fail-open
   * and degrade-to-miss paths already exist.
   */
  ENABLE_OFFLINE_QUEUE: false,
  CONNECT_TIMEOUT_MS: 5_000,
} as const;

const schema = z.object({
  MAX_RETRIES_PER_REQUEST: envInt(Defaults.MAX_RETRIES_PER_REQUEST, { min: 1, max: 20 }),
  ENABLE_OFFLINE_QUEUE: envBoolean(Defaults.ENABLE_OFFLINE_QUEUE),
  CONNECT_TIMEOUT_MS: envInt(Defaults.CONNECT_TIMEOUT_MS, { min: 100, max: 60_000 }),
  REDIS_URL: z.string().optional(),
});

export type RedisEnvConfig = z.infer<typeof schema>;

export interface RedisConfig {
  /** Connection string, or null when the platform has no Redis for this process. */
  url: string | null;
  maxRetriesPerRequest: number;
  enableOfflineQueue: boolean;
  connectTimeoutMs: number;
}

/**
 * Connection settings for the process-wide Redis client.
 *
 * @remarks `REDIS_URL` is platform-owned, like `DATABASE_URL`: one Redis serves several
 * concerns (rate limiting, caching, queues, domain counters) across several services, and a
 * second owner for the same variable is how two consumers end up on different instances
 * after a rotation nobody coordinated. Key namespacing is each consumer's job — `rl:`,
 * `account-security:`, `cache:` — so the client itself applies no prefix and a key always
 * names the concern that wrote it.
 */
export function resolveRedisConfig(env: NodeJS.ProcessEnv = process.env): RedisConfig {
  const parsed = readNamespacedEnv('REDIS', schema, env, {
    REDIS_URL: env.REDIS_URL,
  });
  return {
    url: parsed.REDIS_URL?.trim() || null,
    maxRetriesPerRequest: parsed.MAX_RETRIES_PER_REQUEST,
    enableOfflineQueue: parsed.ENABLE_OFFLINE_QUEUE,
    connectTimeoutMs: parsed.CONNECT_TIMEOUT_MS,
  };
}
