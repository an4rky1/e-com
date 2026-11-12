import { z } from 'zod';
import { envBoolean, envString, readNamespacedEnv } from '@auth/platform/config';

export const SCHEDULER_CONFIG = Symbol('SCHEDULER_CONFIG');

export const Defaults = {
  KEY_PREFIX: 'cron',
  ENABLED: true,
} as const;

const schema = z.object({
  KEY_PREFIX: envString(Defaults.KEY_PREFIX),
  ENABLED: envBoolean(Defaults.ENABLED),
});

export type SchedulerEnvConfig = z.infer<typeof schema>;

export interface SchedulerConfig {
  keyPrefix: string;
  enabled: boolean;
}

/**
 * scheduler-cron's own configuration namespace.
 *
 * @remarks No connection settings — the lock that keeps two replicas from running the same
 * job belongs to `@auth/infra/distributed-locking`, which owns `REDIS_URL`. `ENABLED` is
 * the kill switch a deploy turns before draining a replica that would otherwise race its
 * replacement on a shared cron key.
 */
export function resolveSchedulerConfig(env: NodeJS.ProcessEnv = process.env): SchedulerConfig {
  const parsed = readNamespacedEnv('SCHEDULER', schema, env);
  return {
    keyPrefix: parsed.KEY_PREFIX,
    enabled: parsed.ENABLED,
  };
}
