import { z } from 'zod';
import { envInt, envString, readNamespacedEnv } from '@auth/platform/config';

export const LOCKING_CONFIG = Symbol('LOCKING_CONFIG');

export const Defaults = {
  /** How long a held lock survives without being renewed. */
  TTL_MS: 5_000,
  /** Pause between acquisition attempts. */
  RETRY_MS: 50,
  /** Attempts before the acquisition gives up with a timeout. */
  MAX_RETRIES: 20,
  KEY_PREFIX: 'lock',
} as const;

const schema = z.object({
  TTL_MS: envInt(Defaults.TTL_MS, { min: 100, max: 60_000 }),
  RETRY_MS: envInt(Defaults.RETRY_MS, { min: 1, max: 5_000 }),
  MAX_RETRIES: envInt(Defaults.MAX_RETRIES, { min: 1, max: 1_000 }),
  KEY_PREFIX: envString(Defaults.KEY_PREFIX),
});

export type LockingEnvConfig = z.infer<typeof schema>;

export interface LockingConfig {
  ttlMs: number;
  retryMs: number;
  maxRetries: number;
  keyPrefix: string;
}

/**
 * distributed-locking's own configuration namespace.
 *
 * @remarks No connection settings: the client comes from `@auth/infra/redis`, which owns
 * `REDIS_URL` platform-wide. The retry parameters belong to the *algorithm* and default in
 * code, not env — a module whose tuning knobs live in `.env` accumulates copy-pasted
 * values that nobody can later explain.
 */
export function resolveLockingConfig(env: NodeJS.ProcessEnv = process.env): LockingConfig {
  const parsed = readNamespacedEnv('LOCKING', schema, env);
  return {
    ttlMs: parsed.TTL_MS,
    retryMs: parsed.RETRY_MS,
    maxRetries: parsed.MAX_RETRIES,
    keyPrefix: parsed.KEY_PREFIX,
  };
}
