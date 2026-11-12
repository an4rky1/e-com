/**
 * @fileoverview Conversion between integer minor units and the `ShopMoney` wire shape.
 *
 * @remarks The wire carries money as a *string*, and every rule about that string is a
 * rule about not silently losing a unit: `Number("12.34")` is `12`, `Number("1e3")` is
 * `1000`, and a JSON number cannot hold an int64 past 53 bits. So parsing refuses
 * anything that is not an exact integer literal, and formatting refuses anything that is
 * not an integer — both directions pinned here, because a price that is wrong in this
 * conversion is wrong everywhere it is displayed.
 *
 * @remarks This copy is deliberately independent of `@shop/domains/catalog`'s: a domain
 * lib must not depend on a sibling domain, so the two are pinned by tests in both
 * libraries rather than by a shared import.
 */
import 'reflect-metadata';
import { ValidationException } from '@auth/platform/error-handling';
import { parseShopMoney, toShopMoney } from '../src/presentation/money';

describe('toShopMoney', () => {
  it('spells an integer of minor units as a string, with its currency', () => {
    expect(toShopMoney(2_380, 'EUR')).toEqual({ amountMinor: '2380', currency: 'EUR' });
  });

  it('carries zero as a price, not as an absence', () => {
    expect(toShopMoney(0, 'USD')).toEqual({ amountMinor: '0', currency: 'USD' });
  });

  it('carries the largest exact figure as a string, where JSON would not', () => {
    // The wire spells int64 as a string for a reason: a JSON number cannot hold the
    // full range, and the largest safe integer is where the exactly-representable
    // figures stop. Past it the literal itself rounds, so `toShopMoney` refuses rather
    // than pretending to carry a figure it has already lost.
    expect(toShopMoney(Number.MAX_SAFE_INTEGER, 'EUR').amountMinor).toBe('9007199254740991');
    expect(() => toShopMoney(Number.MAX_SAFE_INTEGER + 2, 'EUR')).toThrow(ValidationException);
  });

  it('refuses a fractional, negative or unsafe amount', () => {
    for (const amountMinor of [10.5, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => toShopMoney(amountMinor, 'EUR')).toThrow(ValidationException);
    }
  });
});

describe('parseShopMoney', () => {
  it('reads an exact integer literal back into minor units', () => {
    expect(parseShopMoney({ amountMinor: '2380', currency: 'EUR' }, 'amount')).toBe(2_380);
    expect(parseShopMoney({ amountMinor: '0', currency: 'EUR' }, 'amount')).toBe(0);
  });

  it('tolerates the whitespace a formatter sometimes leaves behind', () => {
    expect(parseShopMoney({ amountMinor: ' 42 ', currency: 'EUR' }, 'amount')).toBe(42);
  });

  it('refuses a decimal, because Number would silently truncate it', () => {
    // `Number("12.34")` is 12: a price of 12.34 stored as 12 is money that disappears
    // on the way into the domain.
    expect(() => parseShopMoney({ amountMinor: '12.34', currency: 'EUR' }, 'amount')).toThrow(
      ValidationException,
    );
  });

  it('refuses exponent notation, because Number would silently scale it', () => {
    expect(() => parseShopMoney({ amountMinor: '1e3', currency: 'EUR' }, 'amount')).toThrow(
      ValidationException,
    );
    expect(() => parseShopMoney({ amountMinor: '1E3', currency: 'EUR' }, 'amount')).toThrow(
      ValidationException,
    );
  });

  it('refuses a signed literal — a negative price is not a price', () => {
    expect(() => parseShopMoney({ amountMinor: '-5', currency: 'EUR' }, 'amount')).toThrow(
      ValidationException,
    );
    expect(() => parseShopMoney({ amountMinor: '+5', currency: 'EUR' }, 'amount')).toThrow(
      ValidationException,
    );
  });

  it('refuses a figure past the safe integer range rather than rounding it', () => {
    expect(() =>
      parseShopMoney({ amountMinor: '9007199254740993', currency: 'EUR' }, 'amount'),
    ).toThrow(ValidationException);
    // Exactly at the boundary it still answers: the range check is not conservative.
    expect(parseShopMoney({ amountMinor: '9007199254740991', currency: 'EUR' }, 'amount')).toBe(
      9_007_199_254_740_991,
    );
  });

  it('refuses an absent or malformed message rather than defaulting to free', () => {
    // A caller that forgot to send a price did not mean "free": a product listed at
    // zero because of a missing field is a discount nobody authorised.
    expect(() => parseShopMoney(undefined, 'amount')).toThrow(ValidationException);
    expect(() => parseShopMoney(null, 'amount')).toThrow(ValidationException);
    expect(() => parseShopMoney({ currency: 'EUR' } as never, 'amount')).toThrow(
      ValidationException,
    );
    expect(() => parseShopMoney({ amountMinor: '', currency: 'EUR' }, 'amount')).toThrow(
      ValidationException,
    );
    expect(() => parseShopMoney({ amountMinor: '12.0', currency: 'EUR' }, 'amount')).toThrow(
      ValidationException,
    );
    expect(() => parseShopMoney({ amountMinor: ' ', currency: 'EUR' }, 'amount')).toThrow(
      ValidationException,
    );
  });

  it('names the field it refused, so a caller can fix the right one', () => {
    try {
      parseShopMoney({ amountMinor: '1.5', currency: 'EUR' }, 'lines[0].unitPrice');
      throw new Error('expected the parse to be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationException);
      expect((error as ValidationException).context['field']).toBe('lines[0].unitPrice');
    }
  });

  it('round-trips every figure it can hold', () => {
    for (const amountMinor of [0, 1, 99, 2_380, 9_007_199_254_740_991]) {
      const wire = toShopMoney(amountMinor, 'EUR');
      expect(parseShopMoney(wire, 'amount')).toBe(amountMinor);
    }
  });
});
