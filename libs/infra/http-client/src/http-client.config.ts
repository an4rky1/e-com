import { z } from 'zod';
import { envInt, readNamespacedEnv } from '@auth/platform/config';

export const HTTP_CLIENT_CONFIG = Symbol('HTTP_CLIENT_CONFIG');

export const Defaults = {
  TIMEOUT_MS: 10_000,
  RETRIES: 2,
  RETRY_BASE_MS: 200,
  /** Consecutive failures that trip the per-origin circuit breaker. */
  BREAKER_THRESHOLD: 5,
  /** How long an open breaker refuses calls before a probe is allowed through. */
  BREAKER_RESET_MS: 30_000,
} as const;

const schema = z.object({
  TIMEOUT_MS: envInt(Defaults.TIMEOUT_MS, { min: 100, max: 120_000 }),
  RETRIES: envInt(Defaults.RETRIES, { min: 0, max: 10 }),
  RETRY_BASE_MS: envInt(Defaults.RETRY_BASE_MS, { min: 1, max: 10_000 }),
  BREAKER_THRESHOLD: envInt(Defaults.BREAKER_THRESHOLD, { min: 1, max: 100 }),
  BREAKER_RESET_MS: envInt(Defaults.BREAKER_RESET_MS, { min: 100, max: 600_000 }),
});

export type HttpClientEnvConfig = z.infer<typeof schema>;

export interface HttpClientConfig {
  timeoutMs: number;
  retries: number;
  retryBaseMs: number;
  breakerThreshold: number;
  breakerResetMs: number;
}

/**
 * http-client's own configuration namespace.
 *
 * @remarks Deliberately no base-URL registry: callers pass absolute URLs, because a
 * platform-wide `FOO_URL` for every downstream turns this module into a config index that
 * grows by one line per dependency and hides the fact that a single client now owns every
 * retry policy in the fleet.
 */
export function resolveHttpClientConfig(env: NodeJS.ProcessEnv = process.env): HttpClientConfig {
  const parsed = readNamespacedEnv('HTTP', schema, env);
  return {
    timeoutMs: parsed.TIMEOUT_MS,
    retries: parsed.RETRIES,
    retryBaseMs: parsed.RETRY_BASE_MS,
    breakerThreshold: parsed.BREAKER_THRESHOLD,
    breakerResetMs: parsed.BREAKER_RESET_MS,
  };
}
