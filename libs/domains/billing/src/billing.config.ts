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
import {
  GRPC_DEADLINE_MAX_MS,
  GRPC_DEADLINE_MIN_MS,
  GRPC_DEADLINE_MS,
} from '@auth/contracts/grpc/deadline';

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
   * Flat delivery charge by ISO country code, in minor units.
   *
   * @remarks Same shape as the tax map on purpose: one jurisdiction lookup style for both
   * money rules a checkout adds, so an operator who learns to override one learns to
   * override the other. `standard` is the only method this build ships; a second method
   * would extend this map's values rather than invent a second lookup.
   */
  SHIPPING_RATES_BY_COUNTRY: { US: 500, DE: 499, FR: 499, GB: 399 } as Readonly<Record<string, number>>,
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
  GRPC_DEADLINE_MS,
  /**
   * Clock-skew tolerance for the webhook timestamp, in seconds.
   *
   * @remarks Five minutes: wide enough for a slow queue, narrow enough that a replayed
   * capture ages out before an attacker can grind through it.
   */
  WEBHOOK_TOLERANCE_SEC: 300,
} as const;

/**
 * Parses a `*_RATES_BY_COUNTRY` env var out of its JSON string form.
 *
 * @remarks A JSON blob is the only shape that fits an env var, and the only shape that
 * survives "an operator edits one number". Every failure mode — malformed JSON, a
 * non-object, a non-integer rate, a negative rate — is refused at boot rather than
 * silently reading `NaN` into a money calculation on the first request.
 */
function parseRates(raw: string, setting: string, max: number): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Invalid BILLING configuration: ${setting} must be a JSON object`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Invalid BILLING configuration: ${setting} must be a JSON object`,
    );
  }

  const rates: Record<string, number> = {};
  for (const [country, rate] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof rate !== 'number' || !Number.isSafeInteger(rate) || rate < 0 || rate > max) {
      throw new Error(
        `Invalid BILLING configuration: ${setting}.${country} must be an integer between 0 and ${max}`,
      );
    }
    rates[country.trim().toUpperCase()] = rate;
  }

  return rates;
}

export const billingSchema = z.object({
  TAX_RATES_BY_COUNTRY: envString(JSON.stringify(Defaults.TAX_RATES_BY_COUNTRY)),
  SHIPPING_RATES_BY_COUNTRY: envString(JSON.stringify(Defaults.SHIPPING_RATES_BY_COUNTRY)),
  DEFAULT_TAX_COUNTRY: envString(Defaults.DEFAULT_TAX_COUNTRY),
  PSP_PROVIDER: envString(Defaults.PSP_PROVIDER),
  GRPC_DEADLINE_MS: envInt(Defaults.GRPC_DEADLINE_MS, {
    min: GRPC_DEADLINE_MIN_MS,
    max: GRPC_DEADLINE_MAX_MS,
  }),
  /**
   * Shared secret the provider signs webhooks with. Empty means "verify nothing succeeds":
   * a missing secret must reject every delivery, never accept one, so an operator who
   * forgets it gets loud failures on the webhook path rather than an open endpoint.
   */
  WEBHOOK_SECRET: envString(''),
  WEBHOOK_TOLERANCE_SEC: envInt(Defaults.WEBHOOK_TOLERANCE_SEC, { min: 1, max: 3_600 }),
});

export type BillingEnvConfig = z.infer<typeof billingSchema>;

export interface BillingConfig {
  /** Country code (upper-case) -> tax rate in basis points. */
  readonly taxRatesByCountry: Readonly<Record<string, number>>;
  /** Country code (upper-case) -> flat delivery charge in minor units. */
  readonly shippingRatesByCountry: Readonly<Record<string, number>>;
  readonly defaultTaxCountry: string;
  readonly pspProvider: PspProviderName;
  readonly grpcDeadlineMs: number;
  /** HMAC secret for provider webhooks; empty rejects every delivery. */
  readonly webhookSecret: string;
  readonly webhookToleranceSec: number;
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

  const taxRatesByCountry = parseRates(parsed.TAX_RATES_BY_COUNTRY, 'TAX_RATES_BY_COUNTRY', 10_000);
  // Minor units, not basis points: the ceiling is a delivery price ($10 000), not a percentage.
  const shippingRatesByCountry = parseRates(
    parsed.SHIPPING_RATES_BY_COUNTRY,
    'SHIPPING_RATES_BY_COUNTRY',
    1_000_000,
  );
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
  if (!(defaultTaxCountry in shippingRatesByCountry)) {
    // Same boot-failure rule as tax: every request that omits a jurisdiction resolves
    // through the default, and a default with no shipping rate would make that fallback
    // chain end at an undefined lookup.
    throw new Error(
      `Invalid BILLING configuration: DEFAULT_TAX_COUNTRY "${defaultTaxCountry}" has no rate in SHIPPING_RATES_BY_COUNTRY`,
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
    shippingRatesByCountry,
    defaultTaxCountry,
    pspProvider: provider as PspProviderName,
    grpcDeadlineMs: parsed.GRPC_DEADLINE_MS,
    webhookSecret: parsed.WEBHOOK_SECRET,
    webhookToleranceSec: parsed.WEBHOOK_TOLERANCE_SEC,
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

/**
 * The flat delivery charge a jurisdiction is charged, falling back to the configured default.
 *
 * @remarks Same unknown-country rule as {@link taxRateFor}: a storefront that sends a
 * country code this build has not heard of must not be able to make shipping free.
 */
export function shippingRateFor(config: BillingConfig, country: string | undefined): number {
  const normalised = (country ?? '').trim().toUpperCase();
  if (normalised.length > 0 && normalised in config.shippingRatesByCountry) {
    return config.shippingRatesByCountry[normalised];
  }
  return config.shippingRatesByCountry[config.defaultTaxCountry];
}
