import { z } from 'zod';
import { envInt, envString, readNamespacedEnv } from '@auth/platform/config';

export const QUEUE_REGISTRY = Symbol('QUEUE_REGISTRY');
export const QUEUE_CONFIG = Symbol('QUEUE_CONFIG');

export const Defaults = {
  /** Attempts per job, including the first. Three is the platform's retry posture everywhere. */
  ATTEMPTS: 3,
  /** First backoff delay; doubles per attempt under the exponential policy. */
  BACKOFF_MS: 5_000,
  /** Keep the last 100 completed jobs for inspection; older ones expire. */
  REMOVE_ON_COMPLETE: 100,
  /** Failed jobs are the ones you come back to — kept ten times longer than successes. */
  REMOVE_ON_FAIL: 1_000,
  /**
   * How long a stalled job stays locked before BullMQ reschedules it.
   *
   * @remarks Too short and a genuinely slow provider call is killed; too long and a dead worker
   * holds its jobs until a human notices. The default is long enough for a provider that times
   * out the platform's usual way, and short enough that a crash is visible.
   */
  DEFAULT_LOCK_DURATION_MS: 60_000,
} as const;

const schema = z.object({
  ATTEMPTS: envInt(Defaults.ATTEMPTS, { min: 1, max: 20 }),
  BACKOFF_MS: envInt(Defaults.BACKOFF_MS, { min: 100, max: 3_600_000 }),
  REMOVE_ON_COMPLETE: envInt(Defaults.REMOVE_ON_COMPLETE, { min: 1, max: 10_000 }),
  REMOVE_ON_FAIL: envInt(Defaults.REMOVE_ON_FAIL, { min: 1, max: 100_000 }),
  DEFAULT_LOCK_DURATION_MS: envInt(
    Defaults.DEFAULT_LOCK_DURATION_MS,
    { min: 1_000, max: 600_000 },
  ),
});

export type QueueEnvConfig = z.infer<typeof schema>;

export interface QueueConfig {
  attempts: number;
  backoffMs: number;
  removeOnComplete: number;
  removeOnFail: number;
  defaultLockDurationMs: number;
}

/**
 * queue's own configuration namespace.
 *
 * @remarks Job *names* are not here. Which queues exist is a property of the service — passed
 * to `QueueModule.register` by the code that will enqueue into them — while how long a job
 * may retry is a deployment decision. Mixing the two would put a domain's vocabulary into
 * an environment file.
 */
export function resolveQueueConfig(
  env: NodeJS.ProcessEnv = process.env,
): QueueConfig {
  const parsed = readNamespacedEnv('QUEUE', schema, env);
  return {
    attempts: parsed.ATTEMPTS,
    backoffMs: parsed.BACKOFF_MS,
    removeOnComplete: parsed.REMOVE_ON_COMPLETE,
    removeOnFail: parsed.REMOVE_ON_FAIL,
    defaultLockDurationMs: parsed.DEFAULT_LOCK_DURATION_MS,
  };
}
