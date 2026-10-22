import { z } from 'zod';
import {
  envBoolean,
  envInt,
  envString,
  readNamespacedEnv,
  resolveModuleConfig,
} from '@auth/platform/config';

/** This service's own Prisma client. Never shared with another domain lib. */
export const ACCESS_CONTROL_PRISMA = Symbol('ACCESS_CONTROL_PRISMA');

export const Defaults = {
  CACHE_ENABLED: true,
  CACHE_TTL_SEC: 60,
  MAX_PAGE_SIZE: 100,
  /**
   * Highest `policies.priority` a rule may declare.
   *
   * @remarks Bounded because priority is only a tie-break for the rule cited in the audit
   * trail — deny still beats allow at any priority — so an unbounded value would let an
   * operator believe they can out-prioritise a deny rule.
   */
  MAX_POLICY_PRIORITY: 1_000,
  /** Names that may never be used for a role; deleting one of these would break the platform. */
  PROTECTED_ROLE_NAMES: 'admin,user',
} as const;

/**
 * Access control's own configuration namespace.
 *
 * @remarks No connection parameters here. `DATABASE_URL` is platform-owned; a module that
 * could reconfigure its own connection would make "one service, one database" unenforceable.
 */
export const accessControlSchema = z.object({
  CACHE_ENABLED: envBoolean(Defaults.CACHE_ENABLED),
  CACHE_TTL_SEC: envInt(Defaults.CACHE_TTL_SEC, { min: 1 }),
  MAX_PAGE_SIZE: envInt(Defaults.MAX_PAGE_SIZE, { min: 1, max: 1_000 }),
  MAX_POLICY_PRIORITY: envInt(Defaults.MAX_POLICY_PRIORITY, { min: 1, max: 100_000 }),
  PROTECTED_ROLE_NAMES: envString(Defaults.PROTECTED_ROLE_NAMES),
});

export type AccessControlEnvConfig = z.infer<typeof accessControlSchema>;

export interface AccessControlConfig {
  cacheEnabled: boolean;
  cacheTtlSec: number;
  maxPageSize: number;
  maxPolicyPriority: number;
  protectedRoleNames: string[];
}
/**
 * Reads `ACCESS_CONTROL_*` into a validated config.
 *
 * @remarks Lives here rather than in the module so `process.env` is touched in exactly one
 * file: the namespace, its schema and its defaults then sit next to each other, and a new
 * setting has one obvious home.
 */
export function resolveAccessControlConfig(
  env: NodeJS.ProcessEnv = process.env,
): AccessControlConfig {
  const parsed = readNamespacedEnv('ACCESS_CONTROL', accessControlSchema, env);

  return resolveModuleConfig(
    {
      cacheEnabled: parsed.CACHE_ENABLED,
      cacheTtlSec: parsed.CACHE_TTL_SEC,
      maxPageSize: parsed.MAX_PAGE_SIZE,
      maxPolicyPriority: parsed.MAX_POLICY_PRIORITY,
      protectedRoleNames: parsed.PROTECTED_ROLE_NAMES.split(',')
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0),
    },
    {},
  );
}
