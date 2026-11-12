/**
 * @fileoverview Catalog's own configuration namespace (`CATALOG_*`).
 *
 * @remarks Two knobs only, both about the product document rather than about plumbing:
 * the currency a product is minted in when the caller does not name one, and the ceiling on
 * how many variants one product may carry. Connection parameters live elsewhere on purpose —
 * `DATABASE_URL` is platform-owned, and a module that could reconfigure its own connection
 * would make "one service, one database" unenforceable.
 *
 * @remarks `process.env` is touched in exactly one file. The namespace, its schema and its
 * defaults sit next to each other, so a new setting has one obvious home and a test can
 * build a config object without touching the environment.
 */
import { z } from 'zod';
import { envInt, envString, readNamespacedEnv } from '@auth/platform/config';

/** This service's own Prisma client. Never shared with another domain lib. */
export const CATALOG_PRISMA = Symbol('CATALOG_PRISMA');

/** DI token for the resolved configuration. */
export const CATALOG_CONFIG = Symbol('CATALOG_CONFIG');

export const Defaults = {
  /**
   * Currency a product is created in when the request does not say.
   *
   * @remarks A default rather than a required field: most catalogues are single-currency,
   * and forcing every seeding script to repeat `USD` would only push the constant into N
   * call sites where it can drift.
   */
  DEFAULT_CURRENCY: 'USD',
  /**
   * Ceiling on variants per product.
   *
   * @remarks Not a database limit but a shape limit: a product with 500 variants is a
   * different document (a different card, a different price-range computation, a different
   * payload on every topic it produces) and should be modelled as several products.
   */
  MAX_VARIANTS: 50,
} as const;

/**
 * Catalog's configuration schema.
 *
 * @remarks No connection parameters here, and no secrets: everything in this namespace is
 * a policy number an operator may read out loud.
 */
export const catalogSchema = z.object({
  DEFAULT_CURRENCY: envString(Defaults.DEFAULT_CURRENCY),
  MAX_VARIANTS: envInt(Defaults.MAX_VARIANTS, { min: 1, max: 1_000 }),
});

export type CatalogEnvConfig = z.infer<typeof catalogSchema>;

export interface CatalogConfig {
  defaultCurrency: string;
  maxVariants: number;
}

/**
 * Reads `CATALOG_*` into a validated config.
 *
 * @remarks An unrecognised currency is a boot failure rather than a silent fallback to
 * `USD`. Defaulting downwards here would mint products in a currency nobody asked for, and
 * the failure would surface days later as a price that is wrong by a factor of 100 in
 * somebody else's reconciliation — far from the mistake that caused it.
 */
export function resolveCatalogConfig(
  env: NodeJS.ProcessEnv = process.env,
): CatalogConfig {
  const parsed = readNamespacedEnv('CATALOG', catalogSchema, env);
  const currency = parsed.DEFAULT_CURRENCY.trim().toUpperCase();

  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error(
      `Invalid CATALOG configuration: DEFAULT_CURRENCY must be a 3-letter ISO-4217 code, received "${parsed.DEFAULT_CURRENCY}"`,
    );
  }

  const config: CatalogConfig = {
    defaultCurrency: currency,
    maxVariants: parsed.MAX_VARIANTS,
  };

  return config;
}
