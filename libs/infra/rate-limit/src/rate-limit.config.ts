import { z } from 'zod';
import {
  envBoolean,
  envInt,
  envString,
  readNamespacedEnv,
} from '@auth/platform/config';

export const RATE_LIMIT_CONFIG = Symbol('RATE_LIMIT_CONFIG');

export const Defaults = {
  ENABLED: true,
  /** Requests permitted per key per window before the limiter answers 429. */
  DEFAULT_LIMIT: 100,
  /** Window length in seconds. */
  DEFAULT_WINDOW_SEC: 60,
  /**
   * Fail open when Redis is unreachable.
   *
   * @remarks Deliberately not a hard failure. This limiter sits in front of an edge that
   * already authenticates every request; taking the edge down because a cache went away trades
   * a degraded rate limit for no service at all. The trade is recorded in the log so a silent
   * fail-open is at least a visible one.
   */
  FAIL_OPEN: true,
  /** Emit `X-RateLimit-*` on every response, not only on rejection. */
  HEADERS: true,
  KEY_PREFIX: 'rl',
} as const;

const schema = z.object({
  ENABLED: envBoolean(Defaults.ENABLED),
  DEFAULT_LIMIT: envInt(Defaults.DEFAULT_LIMIT),
  DEFAULT_WINDOW_SEC: envInt(Defaults.DEFAULT_WINDOW_SEC),
  FAIL_OPEN: envBoolean(Defaults.FAIL_OPEN),
  HEADERS: envBoolean(Defaults.HEADERS),
  KEY_PREFIX: envString(Defaults.KEY_PREFIX),
});

export type RateLimitEnvConfig = z.infer<typeof schema>;

export interface RateLimitConfig {
  enabled: boolean;
  defaultLimit: number;
  defaultWindowSec: number;
  failOpen: boolean;
  headers: boolean;
  keyPrefix: string;
}

/**
 * rate-limit's own configuration namespace.
 *
 * @remarks No connection settings: the client comes from `@auth/infra/redis`, which owns
 * `REDIS_URL` platform-wide. A second owner for the same variable is how two consumers end
 * up pointing at different instances after a rotation nobody coordinated.
 */
export function resolveRateLimitConfig(
  env: NodeJS.ProcessEnv = process.env,
): RateLimitConfig {
  const parsed = readNamespacedEnv('RATE_LIMIT', schema, env);
  return {
    enabled: parsed.ENABLED,
    defaultLimit: parsed.DEFAULT_LIMIT,
    defaultWindowSec: parsed.DEFAULT_WINDOW_SEC,
    failOpen: parsed.FAIL_OPEN,
    headers: parsed.HEADERS,
    keyPrefix: parsed.KEY_PREFIX,
  };
}
