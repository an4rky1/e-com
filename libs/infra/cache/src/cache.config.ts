import { z } from 'zod';
import { envBoolean, envInt, envString, readNamespacedEnv } from '@auth/platform/config';

export const CACHE_SERVICE = Symbol('CACHE_SERVICE');
export const CACHE_CONFIG = Symbol('CACHE_CONFIG');

export const Defaults = {
  /** Whether the cache answers at all. Off means every `get` is a miss and every `set` is dropped. */
  ENABLED: true,
  /** Default time-to-live in seconds when a caller does not name one. */
  TTL_SEC: 300,
  /**
   * Key prefix applied to every operation.
   *
   * @remarks A prefix belongs here, not on the shared client: this is the concern writing the
   * keys, and a client-level prefix would move the namespacing of every consumer into one
   * file nobody associates with them. Five minutes is long enough to matter and short enough
   * that a stale entry costs one recompute.
   */
  PREFIX: 'cache',
} as const;

const schema = z.object({
  ENABLED: envBoolean(Defaults.ENABLED),
  TTL_SEC: envInt(Defaults.TTL_SEC, { min: 1, max: 86_400 }),
  PREFIX: envString(Defaults.PREFIX),
});

export type CacheEnvConfig = z.infer<typeof schema>;

export interface CacheConfig {
  enabled: boolean;
  ttlSec: number;
  prefix: string;
}

/** cache's own configuration namespace. The connection itself belongs to `@auth/infra/redis`. */
export function resolveCacheConfig(env: NodeJS.ProcessEnv = process.env): CacheConfig {
  const parsed = readNamespacedEnv('CACHE', schema, env);
  return {
    enabled: parsed.ENABLED,
    ttlSec: parsed.TTL_SEC,
    prefix: parsed.PREFIX,
  };
}
