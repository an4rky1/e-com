/**
 * @fileoverview Billing's own configuration namespace (`BILLING_*`).
 *
 * @remarks Lives in one file rather than at each use site so the namespace, its schema and
 * its defaults sit next to each other: a new setting has one obvious home, and a test can
 * build a config object without touching `process.env`.
 *
 * @remarks No connection parameters here. `DATABASE_URL` is platform-owned; a module that
 * could reconfigure its own connection would make "one service, one database"
 * unenforceable.
 */
import { z } from 'zod';
import { envInt, envString, readNamespacedEnv, resolveModuleConfig } from '@auth/platform/config';

/** This service's own Prisma client. Never shared with another domain lib. */
export const BILLING_PRISMA = Symbol('BILLING_PRISMA');

/** DI token for the resolved configuration. */
export const BILLING_CONFIG = Symbol('BILLING_CONFIG');

/** The only payment-service-provider adapter this build ships. */
export const KNOWN_PSP_PROVIDERS = ['fake'] as const;
export type PspProviderName = (typeof KNOWN_PSP_PROVIDERS)[number];

export const Defaults = {
  /**
   * Tax rates by ISO country code, in basis points (1900 = 19%).
   *
   * @remarks Basis points rather than a percent float: `19.0` cannot be stored in a money
   * column, and a rate that is parsed from a float is a rate that disagrees with itself
   * after enough multiplications.
   */
  TAX_RATES_BY_COUNTRY: { US: 0, DE: 1900, FR: 2000, GB: 2000 } as Readonly<Record<string, number>>,
  /**
   * Country used when a request does not name one.
   *
   * @remarks A charge with no jurisdiction is not "no tax" — it is a jurisdiction the
   * caller forgot, and defaulting to zero would under-charge every caller that omits the
   * field. The default country must itself carry a rate, or boot fails.
   */
  DEFAULT_TAX_COUNTRY: 'US',
  /** Which PSP adapter to construct. An unknown name is a boot failure, not a silent fake. */
  PSP_PROVIDER: 'fake' as PspProviderName,
  /** Deadline applied to outbound gRPC calls by callers that honour it. */
  GRPC_DEADLINE_MS: 5_000,
} as const;

/**
 * Parses `BILLING_TAX_RATES_BY_COUNTRY` out of its JSON string form.
 *
 * @remarks A JSON blob is the only shape that fits an env var, and the only shape that
 * survives "an operator edits one number". Every failure mode — malformed JSON, a
 * non-object, a non-integer rate, a negative rate — is refused at boot rather than
 * silently reading `NaN` into a tax calculation on the first request.
 */
function parseTaxRates(raw: string): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'Invalid BILLING configuration: TAX_RATES_BY_COUNTRY must be a JSON object',
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      'Invalid BILLING configuration: TAX_RATES_BY_COUNTRY must be a JSON object',
    );
  }

  const rates: Record<string, number> = {};
  for (const [country, rate] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof rate !== 'number' || !Number.isSafeInteger(rate) || rate < 0 || rate > 10_000) {
      throw new Error(
        `Invalid BILLING configuration: TAX_RATES_BY_COUNTRY.${country} must be an integer between 0 and 10000`,
      );
    }
    rates[country.trim().toUpperCase()] = rate;
  }

  return rates;
}

export const billingSchema = z.object({
  TAX_RATES_BY_COUNTRY: envString(JSON.stringify(Defaults.TAX_RATES_BY_COUNTRY)),
  DEFAULT_TAX_COUNTRY: envString(Defaults.DEFAULT_TAX_COUNTRY),
  PSP_PROVIDER: envString(Defaults.PSP_PROVIDER),
  GRPC_DEADLINE_MS: envInt(Defaults.GRPC_DEADLINE_MS, { min: 100, max: 60_000 }),
});

export type BillingEnvConfig = z.infer<typeof billingSchema>;

export interface BillingConfig {
  /** Country code (upper-case) -> tax rate in basis points. */
  readonly taxRatesByCountry: Readonly<Record<string, number>>;
  readonly defaultTaxCountry: string;
  readonly pspProvider: PspProviderName;
  readonly grpcDeadlineMs: number;
}

/**
 * Reads `BILLING_*` into a validated config.
 *
 * @remarks An unknown PSP provider is a boot failure rather than a fallback: pointing a
 * production deployment at a fake by mis-spelling `stripe` would take payments that never
 * move money and answer every charge with `succeeded` — a failure that looks like success
 * until reconciliation.
 *
 * @remarks The default tax country must carry a rate, because every request that omits a
 * jurisdiction resolves through it; a default that is absent from the map would make the
 * fallback chain end at zero.
 */
export function resolveBillingConfig(env: NodeJS.ProcessEnv = process.env): BillingConfig {
  const parsed = readNamespacedEnv('BILLING', billingSchema, env);

  const taxRatesByCountry = parseTaxRates(parsed.TAX_RATES_BY_COUNTRY);
  const defaultTaxCountry = parsed.DEFAULT_TAX_COUNTRY.trim().toUpperCase();

  if (defaultTaxCountry.length === 0) {
    throw new Error(
      'Invalid BILLING configuration: DEFAULT_TAX_COUNTRY must be a non-empty string',
    );
  }
  if (!(defaultTaxCountry in taxRatesByCountry)) {
    throw new Error(
      `Invalid BILLING configuration: DEFAULT_TAX_COUNTRY "${defaultTaxCountry}" has no rate in TAX_RATES_BY_COUNTRY`,
    );
  }

  const provider = parsed.PSP_PROVIDER.trim().toLowerCase();
  if (!(KNOWN_PSP_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(
      `Invalid BILLING configuration: PSP_PROVIDER must be one of ${KNOWN_PSP_PROVIDERS.join(', ')}, received "${parsed.PSP_PROVIDER}"`,
    );
  }

  // Annotated rather than inlined: TypeScript would otherwise widen the object literal at
  // the call to `resolveModuleConfig` and the result would no longer satisfy
  // {@link BillingConfig} by construction.
  const config: BillingConfig = {
    taxRatesByCountry,
    defaultTaxCountry,
    pspProvider: provider as PspProviderName,
    grpcDeadlineMs: parsed.GRPC_DEADLINE_MS,
  };

  return resolveModuleConfig(config, {});
}

/**
 * The rate a jurisdiction is charged, falling back to the configured default.
 *
 * @remarks An unknown country resolves through {@link BillingConfig.defaultTaxCountry}
 * rather than to zero: a storefront that sends a country code this build has not heard of
 * must not be able to make tax disappear.
 */
export function taxRateFor(config: BillingConfig, country: string | undefined): number {
  const normalised = (country ?? '').trim().toUpperCase();
  if (normalised.length > 0 && normalised in config.taxRatesByCountry) {
    return config.taxRatesByCountry[normalised];
  }
  return config.taxRatesByCountry[config.defaultTaxCountry];
}
