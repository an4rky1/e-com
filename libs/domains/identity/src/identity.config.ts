import { z } from 'zod';
import {
  envBoolean,
  envInt,
  envString,
  readNamespacedEnv,
  resolveModuleConfig,
} from '@auth/platform/config';
import { MAX_PAGE_SIZE } from '@auth/contracts/http/api';

export const IDENTITY_PRISMA = Symbol('IDENTITY_PRISMA');

/**
 * Resolved identity configuration.
 *
 * @remarks Lives here rather than beside the module that assembles it, so a domain-side
 * consumer (the guest reaper) can inject the value without importing the module file and
 * creating an import cycle back into its own handlers.
 */
export const IDENTITY_CONFIG = Symbol('IDENTITY_CONFIG');

export const Defaults = {
  CACHE_ENABLED: true,
  CACHE_TTL_SEC: 300,
  DEFAULT_LOCALE: 'en',
  MAX_PAGE_SIZE,
  GUEST_REAP_ENABLED: true,
  GUEST_REAP_MAX_AGE_DAYS: 90,
  GUEST_REAP_INTERVAL_SEC: 86_400,
} as const;

/**
 * Identity's own configuration namespace.
 *
 * @remarks No connection parameters here. `DATABASE_URL` is platform-owned; a module that
 * could reconfigure its own connection would make "one service, one database" unenforceable.
 */
export const identitySchema = z.object({
  CACHE_ENABLED: envBoolean(Defaults.CACHE_ENABLED),
  CACHE_TTL_SEC: envInt(Defaults.CACHE_TTL_SEC, { min: 1 }),
  DEFAULT_LOCALE: envString(Defaults.DEFAULT_LOCALE),
  MAX_PAGE_SIZE: envInt(Defaults.MAX_PAGE_SIZE, { min: 1, max: 1_000 }),
  GUEST_REAP_ENABLED: envBoolean(Defaults.GUEST_REAP_ENABLED),
  GUEST_REAP_MAX_AGE_DAYS: envInt(Defaults.GUEST_REAP_MAX_AGE_DAYS, { min: 1 }),
  GUEST_REAP_INTERVAL_SEC: envInt(Defaults.GUEST_REAP_INTERVAL_SEC, { min: 60 }),
});

export type IdentityEnvConfig = z.infer<typeof identitySchema>;

export interface IdentityConfig {
  cacheEnabled: boolean;
  cacheTtlSec: number;
  defaultLocale: string;
  maxPageSize: number;
  guestReapEnabled: boolean;
  /** Guest rows untouched for this many days are swept: fresh enough for a browser that
   * still shops, generous enough that an active guest's order history outlives the row. */
  guestReapMaxAgeDays: number;
  guestReapIntervalSec: number;
}

export function resolveIdentityConfig(): IdentityConfig {
  const env = readNamespacedEnv('IDENTITY', identitySchema, process.env);
  return resolveModuleConfig(
    {
      cacheEnabled: env.CACHE_ENABLED,
      cacheTtlSec: env.CACHE_TTL_SEC,
      defaultLocale: env.DEFAULT_LOCALE,
      maxPageSize: env.MAX_PAGE_SIZE,
      guestReapEnabled: env.GUEST_REAP_ENABLED,
      guestReapMaxAgeDays: env.GUEST_REAP_MAX_AGE_DAYS,
      guestReapIntervalSec: env.GUEST_REAP_INTERVAL_SEC,
    },
    {},
  );
}