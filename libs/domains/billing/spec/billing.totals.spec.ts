/**
 * @fileoverview The frozen money calculation, asserted as arithmetic.
 *
 * @remarks These are the numbers a storefront displays and a PSP collects, so the suite
 * is deliberately literal: concrete inputs, concrete outputs, no property that could hide
 * a rounding difference. The order — tax before discount, coupon after tax — is the part
 * that silently changes every price if it ever moves, and it is asserted directly rather
 * than inferred.
 *
 * @remarks Per-line rounding is asserted too: the invoice shows a tax *per line*, so the
 * tax the totals carry must equal the sum of the taxes the lines display, or a
 * reconciliation would flag a discrepancy that is invisible in either figure alone.
 */
import 'reflect-metadata';
import { ValidationException } from '@auth/platform/error-handling';
import { computeTotals } from '../src/domain/totals';

describe('computeTotals — the frozen order', () => {
  it('taxes the undiscounted lines, then applies the coupon to the post-tax amount', () => {
    // 2 × 10.00 = 20.00 subtotal, 19% German VAT = 3.80 tax, gross 23.80.
    const totals = computeTotals({
      lines: [{ sku: 'SKU-1', quantity: 2, unitPriceMinor: 1_000 }],
      currency: 'EUR',
      taxRateBps: 1_900,
      coupon: { code: 'SAVE10', percentOff: 10 },
    });

    expect(totals.subtotalMinor).toBe(2_000);
    expect(totals.taxMinor).toBe(380);
    // 10% of the *post-tax* 23.80, not of the 20.00 subtotal: the coupon comes after tax.
    expect(totals.discountMinor).toBe(238);
    expect(totals.totalMinor).toBe(2_142);
  });

  it('keeps the tax whole when a coupon is applied — a discount is not a tax reduction', () => {
    const withoutCoupon = computeTotals({
      lines: [{ sku: 'SKU-1', quantity: 1, unitPriceMinor: 5_000 }],
      currency: 'EUR',
      taxRateBps: 2_000,
    });
    const withCoupon = computeTotals({
      lines: [{ sku: 'SKU-1', quantity: 1, unitPriceMinor: 5_000 }],
      currency: 'EUR',
      taxRateBps: 2_000,
      coupon: { code: 'SAVE50', percentOff: 50 },
    });

    expect(withCoupon.taxMinor).toBe(withoutCoupon.taxMinor);
    expect(withCoupon.totalMinor).toBe(withoutCoupon.totalMinor - withCoupon.discountMinor);
  });

  it('takes a 100% coupon to zero, and never below', () => {
    const totals = computeTotals({
      lines: [{ sku: 'SKU-1', quantity: 3, unitPriceMinor: 333 }],
      currency: 'EUR',
      taxRateBps: 1_900,
      coupon: { code: 'FREE', percentOff: 100 },
    });

    expect(totals.discountMinor).toBe(totals.subtotalMinor + totals.taxMinor);
    expect(totals.totalMinor).toBe(0);
  });

  it('applies no discount when no coupon is given — the charge path', () => {
    const totals = computeTotals({
      lines: [{ sku: 'SKU-1', quantity: 1, unitPriceMinor: 1_000 }],
      currency: 'USD',
      taxRateBps: 0,
    });

    expect(totals.discountMinor).toBe(0);
    expect(totals.totalMinor).toBe(1_000);
  });
});

describe('computeTotals — rounding', () => {
  it('rounds each line, and the totals equal the sum of the lines', () => {
    // 3 × 3.33 = 9.99; 19% of that is 1.8981, which rounds to 1.90 per line.
    const totals = computeTotals({
      lines: [
        { sku: 'SKU-1', quantity: 3, unitPriceMinor: 333 },
        { sku: 'SKU-2', quantity: 1, unitPriceMinor: 1 },
      ],
      currency: 'EUR',
      taxRateBps: 1_900,
    });

    const sumOfLineTaxes = totals.lines.reduce((sum, line) => sum + line.taxMinor, 0);
    expect(totals.lines[0].taxMinor).toBe(190);
    expect(totals.taxMinor).toBe(sumOfLineTaxes);
    expect(totals.subtotalMinor).toBe(
      totals.lines.reduce((sum, line) => sum + line.lineSubtotalMinor, 0),
    );
  });

  it('never produces a fractional figure anywhere', () => {
    const totals = computeTotals({
      lines: [
        { sku: 'SKU-1', quantity: 7, unitPriceMinor: 199 },
        { sku: 'SKU-2', quantity: 3, unitPriceMinor: 50 },
      ],
      currency: 'EUR',
      taxRateBps: 1_900,
      coupon: { code: 'SAVE7', percentOff: 7 },
    });

    for (const figure of [
      totals.subtotalMinor,
      totals.taxMinor,
      totals.discountMinor,
      totals.totalMinor,
      ...totals.lines.flatMap((line) => [
        line.lineSubtotalMinor,
        line.taxMinor,
        line.unitPriceMinor,
      ]),
    ]) {
      expect(Number.isSafeInteger(figure)).toBe(true);
    }
  });

  it('charges no tax in a zero-rate jurisdiction', () => {
    const totals = computeTotals({
      lines: [{ sku: 'SKU-1', quantity: 2, unitPriceMinor: 1_000 }],
      currency: 'USD',
      taxRateBps: 0,
    });

    expect(totals.taxMinor).toBe(0);
    expect(totals.totalMinor).toBe(2_000);
  });
});

describe('computeTotals — refusals', () => {
  const line = { sku: 'SKU-1', quantity: 1, unitPriceMinor: 100 };

  it('refuses an empty line list rather than answering a free order', () => {
    expect(() => computeTotals({ lines: [], currency: 'EUR', taxRateBps: 0 })).toThrow(
      ValidationException,
    );
  });

  it('refuses a missing currency rather than defaulting to one', () => {
    expect(() => computeTotals({ lines: [line], currency: '  ', taxRateBps: 0 })).toThrow(
      ValidationException,
    );
  });

  it('refuses a quantity that is not a positive integer', () => {
    expect(() =>
      computeTotals({ lines: [{ ...line, quantity: 0 }], currency: 'EUR', taxRateBps: 0 }),
    ).toThrow(ValidationException);
    expect(() =>
      computeTotals({ lines: [{ ...line, quantity: 1.5 }], currency: 'EUR', taxRateBps: 0 }),
    ).toThrow(ValidationException);
  });

  it('refuses a negative or fractional unit price', () => {
    expect(() =>
      computeTotals({
        lines: [{ ...line, unitPriceMinor: -1 }],
        currency: 'EUR',
        taxRateBps: 0,
      }),
    ).toThrow(ValidationException);
    expect(() =>
      computeTotals({
        lines: [{ ...line, unitPriceMinor: 10.5 }],
        currency: 'EUR',
        taxRateBps: 0,
      }),
    ).toThrow(ValidationException);
  });

  it('refuses a blank sku', () => {
    expect(() =>
      computeTotals({ lines: [{ ...line, sku: ' ' }], currency: 'EUR', taxRateBps: 0 }),
    ).toThrow(ValidationException);
  });

  it('refuses a rate outside the basis-point range', () => {
    expect(() => computeTotals({ lines: [line], currency: 'EUR', taxRateBps: -1 })).toThrow(
      ValidationException,
    );
    expect(() => computeTotals({ lines: [line], currency: 'EUR', taxRateBps: 10_001 })).toThrow(
      ValidationException,
    );
  });

  it('refuses a coupon that could take the bill below zero', () => {
    expect(() =>
      computeTotals({
        lines: [line],
        currency: 'EUR',
        taxRateBps: 0,
        coupon: { code: 'X', percentOff: 0 },
      }),
    ).toThrow(ValidationException);
    expect(() =>
      computeTotals({
        lines: [line],
        currency: 'EUR',
        taxRateBps: 0,
        coupon: { code: 'X', percentOff: 101 },
      }),
    ).toThrow(ValidationException);
    expect(() =>
      computeTotals({
        lines: [line],
        currency: 'EUR',
        taxRateBps: 0,
        coupon: { code: 'X', percentOff: 12.5 },
      }),
    ).toThrow(ValidationException);
  });
});
