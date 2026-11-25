/**
 * @fileoverview The cart's Money value object: validation and exact arithmetic.
 *
 * @remarks These are the cases a loose `{ amountMinor, currency }` pair could not catch:
 * an amount that is not a safe integer, a currency that is not ISO-4217, and an operation
 * that would quietly mix two currencies. Pinning them here is what lets `CartItem` and
 * `Cart` treat a `Money` as already valid.
 */
import { ValidationException } from '@auth/platform/error-handling';
import { Money } from '../src/domain/value-objects/money';

describe('Money.of', () => {
  it('keeps an exact integer of minor units and the currency code', () => {
    const money = Money.of(2_000, 'EUR');

    expect(money.amountMinor).toBe(2_000);
    expect(money.currency).toBe('EUR');
    expect(money.isZero).toBe(false);
  });

  it('treats zero as a real amount, not as missing money', () => {
    const money = Money.of(0, 'USD');

    expect(money.amountMinor).toBe(0);
    expect(money.isZero).toBe(true);
  });

  it('trims padding around the currency but does not case-fold it', () => {
    expect(Money.of(1, ' USD ').currency).toBe('USD');
    expect(() => Money.of(1, 'usd')).toThrow(/ISO-4217/);
  });

  it.each([
    ['a negative amount', -1],
    ['a fractional amount', 10.5],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['an amount beyond the safe integer range', Number.MAX_SAFE_INTEGER + 2],
  ])('refuses %s', (_label, amountMinor) => {
    expect(() => Money.of(amountMinor, 'USD')).toThrow(ValidationException);
  });

  it.each([
    ['an empty code', ''],
    ['a lowercase code', 'usd'],
    ['four letters', 'USDD'],
    ['digits', 'US1'],
    ['a missing code', undefined as unknown as string],
  ])('refuses %s', (_label, currency) => {
    expect(() => Money.of(1, currency)).toThrow(/ISO-4217/);
  });
});

describe('Money.add', () => {
  it('adds amounts in the same currency', () => {
    expect(Money.of(1_000, 'USD').add(Money.of(250, 'USD'))).toEqual(
      Money.of(1_250, 'USD'),
    );
  });

  it('refuses to add different currencies', () => {
    expect(() => Money.of(1_000, 'USD').add(Money.of(1_000, 'EUR'))).toThrow(
      /different currencies cannot be added/,
    );
  });

  it('refuses an overflow instead of rounding it', () => {
    expect(() =>
      Money.of(Number.MAX_SAFE_INTEGER, 'USD').add(Money.of(1, 'USD')),
    ).toThrow(/non-negative integer/);
  });
});

describe('Money.multiply', () => {
  it('multiplies by a whole quantity', () => {
    expect(Money.of(1_250, 'EUR').multiply(3)).toEqual(Money.of(3_750, 'EUR'));
  });

  it('allows zero units', () => {
    expect(Money.of(1_250, 'EUR').multiply(0).isZero).toBe(true);
  });

  it.each([
    ['a negative quantity', -1],
    ['a fractional quantity', 1.5],
    ['NaN', Number.NaN],
  ])('refuses %s', (_label, quantity) => {
    expect(() => Money.of(100, 'USD').multiply(quantity)).toThrow(
      /non-negative integer/,
    );
  });

  it('refuses an overflow instead of rounding it', () => {
    expect(() =>
      Money.of(Number.MAX_SAFE_INTEGER, 'USD').multiply(2),
    ).toThrow(/non-negative integer/);
  });
});

describe('Money.equals', () => {
  it('compares amount and currency together', () => {
    expect(Money.of(100, 'USD').equals(Money.of(100, 'USD'))).toBe(true);
    expect(Money.of(100, 'USD').equals(Money.of(100, 'EUR'))).toBe(false);
    expect(Money.of(100, 'USD').equals(Money.of(101, 'USD'))).toBe(false);
  });
});
