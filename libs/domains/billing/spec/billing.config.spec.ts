/**
 * @fileoverview `BILLING_*` resolution, and the boot failures it is supposed to cause.
 *
 * @remarks Configuration bugs are the ones that ship: a tax table that fails to parse, a
 * default country with no rate, or a PSP name nobody built an adapter for would each
 * surface days later as wrong prices or payments that never move. Every one of them is
 * refused here, at the moment the environment is read — which is the only moment before
 * the first charge.
 *
 * @remarks `taxRateFor` sits in this suite too because the fallback chain *is* part of
 * the configuration contract: an unknown country resolving to the default, and the
 * default never resolving to zero by accident.
 */
import 'reflect-metadata';
import {
  Defaults,
  resolveBillingConfig,
  taxRateFor,
} from '../src/billing.config';

describe('resolveBillingConfig', () => {
  it('reads the documented defaults from an empty environment', () => {
    const config = resolveBillingConfig({});

    expect(config.taxRatesByCountry).toEqual({ US: 0, DE: 1900, FR: 2000, GB: 2000 });
    expect(config.defaultTaxCountry).toBe('US');
    expect(config.pspProvider).toBe('fake');
    expect(config.grpcDeadlineMs).toBe(Defaults.GRPC_DEADLINE_MS);
  });

  it('accepts a well-formed tax table and upper-cases its keys', () => {
    const config = resolveBillingConfig({
      BILLING_TAX_RATES_BY_COUNTRY: '{"jp": 1000, "US": 888}',
      BILLING_DEFAULT_TAX_COUNTRY: 'jp',
    });

    expect(config.taxRatesByCountry).toEqual({ JP: 1000, US: 888 });
    expect(config.defaultTaxCountry).toBe('JP');
  });

  it('refuses a tax table that is not JSON', () => {
    expect(() => resolveBillingConfig({ BILLING_TAX_RATES_BY_COUNTRY: 'US=0' })).toThrow(
      /TAX_RATES_BY_COUNTRY must be a JSON object/,
    );
  });

  it('refuses a tax table that is not an object', () => {
    expect(() => resolveBillingConfig({ BILLING_TAX_RATES_BY_COUNTRY: '[0,1900]' })).toThrow(
      /TAX_RATES_BY_COUNTRY must be a JSON object/,
    );
    expect(() => resolveBillingConfig({ BILLING_TAX_RATES_BY_COUNTRY: 'null' })).toThrow(
      /TAX_RATES_BY_COUNTRY must be a JSON object/,
    );
  });

  it('refuses a rate that is not an integer basis point', () => {
    expect(() =>
      resolveBillingConfig({ BILLING_TAX_RATES_BY_COUNTRY: '{"US": 19.5}' }),
    ).toThrow(/US must be an integer between 0 and 10000/);
    expect(() =>
      resolveBillingConfig({ BILLING_TAX_RATES_BY_COUNTRY: '{"US": -1}' }),
    ).toThrow(/US must be an integer between 0 and 10000/);
    expect(() =>
      resolveBillingConfig({ BILLING_TAX_RATES_BY_COUNTRY: '{"US": "zero"}' }),
    ).toThrow(/US must be an integer between 0 and 10000/);
  });

  it('refuses a default country that carries no rate', () => {
    // The fallback chain has to end somewhere with a number: a default absent from the
    // table would make every unknown jurisdiction resolve to zero tax.
    expect(() =>
      resolveBillingConfig({ BILLING_DEFAULT_TAX_COUNTRY: 'ZZ' }),
    ).toThrow(/DEFAULT_TAX_COUNTRY "ZZ" has no rate/);
  });

  it('refuses an empty default country', () => {
    expect(() => resolveBillingConfig({ BILLING_DEFAULT_TAX_COUNTRY: '   ' })).toThrow(
      /DEFAULT_TAX_COUNTRY must be a non-empty string/,
    );
  });

  it('refuses a PSP provider no adapter was built for', () => {
    // Pointing production at a mis-spelled provider must fail loudly, not fall through to
    // an adapter that answers every charge with `succeeded`.
    expect(() => resolveBillingConfig({ BILLING_PSP_PROVIDER: 'stripe' })).toThrow(
      /PSP_PROVIDER must be one of fake/,
    );
  });

  it('normalises the provider name', () => {
    expect(resolveBillingConfig({ BILLING_PSP_PROVIDER: '  FAKE ' }).pspProvider).toBe('fake');
  });
});

describe('taxRateFor', () => {
  const config = resolveBillingConfig({});

  it('answers the rate for a country the table knows', () => {
    expect(taxRateFor(config, 'DE')).toBe(1_900);
    expect(taxRateFor(config, 'de')).toBe(1_900);
    expect(taxRateFor(config, ' FR ')).toBe(2_000);
  });

  it('falls back to the default for a country it has never heard of', () => {
    // An unknown jurisdiction must not be able to make tax disappear.
    expect(taxRateFor(config, 'ZZ')).toBe(0);
    expect(taxRateFor(config, '')).toBe(0);
    expect(taxRateFor(config, undefined)).toBe(0);
  });

  it('falls back through a non-zero default when configured that way', () => {
    const euFirst = resolveBillingConfig({
      BILLING_TAX_RATES_BY_COUNTRY: '{"US": 0, "DE": 1900}',
      BILLING_DEFAULT_TAX_COUNTRY: 'DE',
    });

    expect(taxRateFor(euFirst, 'ZZ')).toBe(1_900);
  });
});
