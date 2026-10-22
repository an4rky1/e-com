import { z } from 'zod';
import { envBoolean, envInt, envString } from '@auth/platform/config';

export const IDENTITY_PRISMA = Symbol('IDENTITY_PRISMA');

export const Defaults = {
  CACHE_ENABLED: true,
  CACHE_TTL_SEC: 300,
  DEFAULT_LOCALE: 'en',
  MAX_PAGE_SIZE: 100,
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
});

export type IdentityEnvConfig = z.infer<typeof identitySchema>;

export interface IdentityConfig {
  cacheEnabled: boolean;
  cacheTtlSec: number;
  defaultLocale: string;
  maxPageSize: number;
}