import { z } from 'zod';
import {
  envBoolean,
  envInt,
  envString,
  readNamespacedEnv,
} from '@auth/platform/config';

export const IDEMPOTENCY_CONFIG = Symbol('IDEMPOTENCY_CONFIG');

export const Defaults = {
  ENABLED: true,
  KEY_HEADER: 'x-idempotency-key',
  /** Key namespace in Redis. One deployment's records never collide with another's. */
  PREFIX: 'idem',
  /** How long a replayed response body stays available. */
  TTL_SEC: 300,
  /**
   * How long a body-less "already ran" marker stays up.
   *
   * @remarks Much longer than the replay TTL: the marker costs three fields, and its whole
   * job is to catch a client that retries minutes later — a refresh request retried after
   * five minutes is normal, and answering it with a second rotation is not.
   */
  MARKER_TTL_SEC: 86_400,
  /**
   * How long a claim blocks later attempts before the record counts as abandoned.
   *
   * @remarks Comfortably longer than any handler can take (`PEER_DEADLINE_MS` is 3s per call),
   * because a claim that expires under a live request lets two duplicates run at once —
   * the exact failure this module exists to prevent. The cost of the longer window is a
   * waiter that outlives a crashed request, and that waiter times out too.
   */
  LOCK_TIMEOUT_MS: 30_000,
  MAX_KEY_LENGTH: 256,
  MAX_RESPONSE_SIZE_KB: 1_024,
} as const;

/**
 * How long a caller told "already in flight" is asked to wait, in seconds.
 *
 * @remarks A constant rather than an env var: it is retry policy, not deployment topology,
 * and five seconds is shorter than any plausible handler while long enough that a retry loop
 * does not become a second load generator. A retry that arrives early simply gets the same
 * answer again — the claim is still held, so nothing runs twice.
 */
export const IN_FLIGHT_RETRY_AFTER_SEC = 5;

const schema = z.object({
  ENABLED: envBoolean(Defaults.ENABLED),
  KEY_HEADER: envString(Defaults.KEY_HEADER),
  PREFIX: envString(Defaults.PREFIX),
  TTL_SEC: envInt(Defaults.TTL_SEC, { min: 60, max: 2_592_000 }),
  MARKER_TTL_SEC: envInt(Defaults.MARKER_TTL_SEC, { min: 60, max: 2_592_000 }),
  LOCK_TIMEOUT_MS: envInt(Defaults.LOCK_TIMEOUT_MS, { min: 1_000, max: 300_000 }),
  MAX_KEY_LENGTH: envInt(Defaults.MAX_KEY_LENGTH, { min: 16, max: 4_096 }),
  MAX_RESPONSE_SIZE_KB: envInt(Defaults.MAX_RESPONSE_SIZE_KB, {
    min: 1,
    max: 10_240,
  }),
});

export type IdempotencyEnvConfig = z.infer<typeof schema>;

export interface IdempotencyConfig {
  enabled: boolean;
  keyHeader: string;
  prefix: string;
  ttlSec: number;
  markerTtlSec: number;
  lockTimeoutMs: number;
  maxKeyLength: number;
  maxResponseSizeKb: number;
}

/**
 * idempotency's own configuration namespace.
 *
 * @remarks No connection settings: the client comes from `@auth/infra/redis`, which owns
 * `REDIS_URL` platform-wide — a second owner for the same variable is how two consumers end
 * up on different instances after a rotation nobody coordinated. When that client is absent
 * the module does not fail: it turns itself off, because an edge that refuses every POST
 * because Redis is missing is a worse outage than a duplicate request.
 */
export function resolveIdempotencyConfig(
  env: NodeJS.ProcessEnv = process.env,
): IdempotencyConfig {
  const parsed = readNamespacedEnv('IDEMPOTENCY', schema, env);
  return {
    enabled: parsed.ENABLED,
    keyHeader: parsed.KEY_HEADER,
    prefix: parsed.PREFIX,
    ttlSec: parsed.TTL_SEC,
    markerTtlSec: parsed.MARKER_TTL_SEC,
    lockTimeoutMs: parsed.LOCK_TIMEOUT_MS,
    maxKeyLength: parsed.MAX_KEY_LENGTH,
    maxResponseSizeKb: parsed.MAX_RESPONSE_SIZE_KB,
  };
}
