/**
 * @fileoverview Money conversion between minor units and the `ShopMoney` wire shape.
 *
 * @remarks Pinned independently of the cart's and billing's copies: a domain lib must not
 * depend on a sibling, so each copy is tested where it lives. The rules are asymmetric on
 * purpose — writing a negative amount is refused even though the wire could carry the
 * characters, because a minus sign on a price is a credit nobody asked for.
 */
import 'reflect-metadata';
import { ValidationException } from '@auth/platform/error-handling';
import { parseShopMoney, toShopMoney } from '../src/money';
import { thrown, thrownAsync } from './support/helpers';

describe('toShopMoney', () => {
  it('serialises a non-negative integer as a string', () => {
    expect(toShopMoney(0, 'USD')).toEqual({ amountMinor: '0', currency: 'USD' });
    expect(toShopMoney(12_34, 'EUR')).toEqual({ amountMinor: '1234', currency: 'EUR' });
  });

  it('refuses a negative amount', () => {
    expect(thrown(() => toShopMoney(-1, 'USD'))).toBeInstanceOf(ValidationException);
  });

  it('refuses a non-integer', () => {
    expect(thrown(() => toShopMoney(1.5, 'USD'))).toBeInstanceOf(ValidationException);
  });

  it('refuses a value beyond 2^53 - 1', () => {
    expect(thrown(() => toShopMoney(Number.MAX_SAFE_INTEGER + 2, 'USD'))).toBeInstanceOf(
      ValidationException,
    );
  });
});

describe('parseShopMoney', () => {
  it('reads an exact integer literal', () => {
    expect(parseShopMoney({ amountMinor: '1000', currency: 'USD' }, 'total')).toBe(1000);
  });

  it('refuses a missing field rather than defaulting to free', () => {
    expect(thrown(() => parseShopMoney(undefined, 'total'))).toBeInstanceOf(ValidationException);
    expect(thrown(() => parseShopMoney(null, 'total'))).toBeInstanceOf(ValidationException);
  });

  it('refuses a decimal or scientific notation', () => {
    expect(
      thrown(() => parseShopMoney({ amountMinor: '12.34', currency: 'USD' }, 'p')),
    ).toBeInstanceOf(ValidationException);
    expect(
      thrown(() => parseShopMoney({ amountMinor: '1e3', currency: 'USD' }, 'p')),
    ).toBeInstanceOf(ValidationException);
  });

  it('refuses a negative literal', () => {
    expect(
      thrown(() => parseShopMoney({ amountMinor: '-5', currency: 'USD' }, 'p')),
    ).toBeInstanceOf(ValidationException);
  });

  it('refuses a value beyond 2^53 - 1', () => {
    expect(
      thrown(() =>
        parseShopMoney({ amountMinor: '9007199254740993', currency: 'USD' }, 'p'),
      ),
    ).toBeInstanceOf(ValidationException);
  });

  it('round-trips what toShopMoney wrote', () => {
    const wire = toShopMoney(42_00, 'GBP');
    expect(parseShopMoney(wire, 'total')).toBe(42_00);
  });
});
