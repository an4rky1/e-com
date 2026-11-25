import { z } from 'zod';
import { envBoolean, envInt, envString, readNamespacedEnv, resolveModuleConfig } from '@auth/platform/config';
import { MAX_PAGE_SIZE } from '@auth/contracts/http/api';
import { ApiKeyPrefix } from './domain/value-objects/api-key-prefix.vo';

/** This service's own Prisma client. Never shared with another domain lib. */
export const API_KEY_PRISMA = Symbol('API_KEY_PRISMA');

/** DI token for the resolved configuration. */
export const API_KEY_CONFIG = Symbol('API_KEY_CONFIG');

export const Defaults = {
  /**
   * How long a key lives when the caller does not say.
   *
   * @remarks Not "never": an unbounded default turns every key that is never rotated into a
   * permanent credential, which is the failure mode this whole service exists to prevent.
   */
  DEFAULT_TTL_SEC: 2_592_000,
  /**
   * Ceiling on a requested lifetime.
   *
   * @remarks The caller may ask for less than the default; it may not ask for more. Without a
   * ceiling "expires in 10 years" is a valid-looking request that quietly removes expiry.
   */
  MAX_TTL_SEC: 31_536_000,
  /**
   * Which family new keys are minted in.
   *
   * @remarks Separate environments must not be able to accept each other's credentials, so the
   * family is configuration rather than a request parameter a client could choose.
   */
  KEY_FAMILY: ApiKeyPrefix.TEST,
  /**
   * Whether successful authentications write `last_used_at`.
   *
   * @remarks One extra indexed update per machine request, which is real on a hot integration
   * and worthless to a key that has just been issued. Operators can turn it off.
   */
  TRACK_LAST_USED: true,
  MAX_PAGE_SIZE,
} as const;

/**
 * Api key's own configuration namespace (`API_KEY_*`).
 *
 * @remarks No connection parameters here. `DATABASE_URL` is platform-owned; a module that
 * could reconfigure its own connection would make "one service, one database" unenforceable.
 */
export const apiKeySchema = z.object({
  DEFAULT_TTL_SEC: envInt(Defaults.DEFAULT_TTL_SEC, { min: 60, max: 31_536_000 }),
  MAX_TTL_SEC: envInt(Defaults.MAX_TTL_SEC, { min: 60, max: 31_536_000 }),
  KEY_FAMILY: envString(Defaults.KEY_FAMILY),
  TRACK_LAST_USED: envBoolean(Defaults.TRACK_LAST_USED),
  MAX_PAGE_SIZE: envInt(Defaults.MAX_PAGE_SIZE, { min: 1, max: 1_000 }),
});

export type ApiKeyEnvConfig = z.infer<typeof apiKeySchema>;

export interface ApiKeyConfig {
  defaultTtlSec: number;
  maxTtlSec: number;
  keyFamily: 'live' | 'test';
  trackLastUsed: boolean;
  maxPageSize: number;
}

/**
 * Reads `API_KEY_*` into a validated config.
 *
 * @remarks Lives here rather than in the module so `process.env` is touched in exactly one
 * file: the namespace, its schema and its defaults then sit next to each other, and a new
 * setting has one obvious home.
 *
 * @remarks An unrecognised family is a boot failure rather than a silent fallback to `test`.
 * Defaulting downwards here would issue staging keys in production and reject every real one
 * — the failure would look like "my key does not work", hours later, in someone's CI.
 */
export function resolveApiKeyConfig(
  env: NodeJS.ProcessEnv = process.env,
): ApiKeyConfig {
  const parsed = readNamespacedEnv('API_KEY', apiKeySchema, env);
  const family = parsed.KEY_FAMILY.trim().toLowerCase();

  if (family !== ApiKeyPrefix.LIVE && family !== ApiKeyPrefix.TEST) {
    throw new Error(
      `Invalid API_KEY configuration: KEY_FAMILY must be "${ApiKeyPrefix.LIVE}" or "${ApiKeyPrefix.TEST}", received "${parsed.KEY_FAMILY}"`,
    );
  }

  if (parsed.DEFAULT_TTL_SEC > parsed.MAX_TTL_SEC) {
    throw new Error(
      'Invalid API_KEY configuration: DEFAULT_TTL_SEC must not exceed MAX_TTL_SEC',
    );
  }

  // Annotated rather than inlined: without it TypeScript widens `family` to `string` at the
  // object literal, and the result of `resolveModuleConfig` — which is the literal's own type —
  // no longer satisfies {@link ApiKeyConfig}.
  const config: ApiKeyConfig = {
    defaultTtlSec: parsed.DEFAULT_TTL_SEC,
    maxTtlSec: parsed.MAX_TTL_SEC,
    keyFamily: family,
    trackLastUsed: parsed.TRACK_LAST_USED,
    maxPageSize: parsed.MAX_PAGE_SIZE,
  };

  return resolveModuleConfig(config, {});
}