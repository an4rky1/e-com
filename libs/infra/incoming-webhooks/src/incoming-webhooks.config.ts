import { z } from 'zod';
import { envInt, readNamespacedEnv } from '@auth/platform/config';

export const WEBHOOKS_CONFIG = Symbol('WEBHOOKS_CONFIG');

export const Defaults = {
  /** Allowed clock skew on a signed delivery's timestamp, in seconds. */
  TOLERANCE_SEC: 300,
  /** How long a processed event id is remembered as a duplicate. */
  DEDUP_TTL_MS: 300_000,
  /** Hard ceiling on remembered ids; oldest are evicted first. */
  DEDUP_MAX: 10_000,
} as const;

const schema = z.object({
  TOLERANCE_SEC: envInt(Defaults.TOLERANCE_SEC, { min: 1, max: 3_600 }),
  DEDUP_TTL_MS: envInt(Defaults.DEDUP_TTL_MS, { min: 1_000, max: 86_400_000 }),
  DEDUP_MAX: envInt(Defaults.DEDUP_MAX, { min: 16, max: 1_000_000 }),
});

export type IncomingWebhooksEnvConfig = z.infer<typeof schema>;

export interface IncomingWebhooksConfig {
  toleranceSec: number;
  dedupTtlMs: number;
  dedupMax: number;
}

/**
 * incoming-webhooks' own configuration namespace.
 *
 * @remarks Per-route secrets are *not* here: a handler receives them the way every other
 * secret enters this codebase — from the service's own config schema. This module only
 * owns the tolerances that are properties of the protocol, not of any single sender.
 */
export function resolveIncomingWebhooksConfig(
  env: NodeJS.ProcessEnv = process.env,
): IncomingWebhooksConfig {
  const parsed = readNamespacedEnv('WEBHOOKS', schema, env);
  return {
    toleranceSec: parsed.TOLERANCE_SEC,
    dedupTtlMs: parsed.DEDUP_TTL_MS,
    dedupMax: parsed.DEDUP_MAX,
  };
}
