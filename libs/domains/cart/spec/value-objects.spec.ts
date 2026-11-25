/**
 * @fileoverview The cart's identity and quantity value objects.
 *
 * @remarks These are the rules that used to be copied into two handlers and the aggregate:
 * what a SKU is, what a product id is, and what counts as a quantity. Pinning them here is
 * what lets every caller treat a constructed value as already valid.
 */
import { ValidationException } from '@auth/platform/error-handling';
import { CART_STATUSES, isCartStatus } from '../src/domain/value-objects/cart-status.vo';
import { ProductId } from '../src/domain/value-objects/product-id.vo';
import { Quantity } from '../src/domain/value-objects/quantity.vo';
import { Sku } from '../src/domain/value-objects/sku.vo';

describe('Sku', () => {
  it('trims the whitespace a transport may add', () => {
    expect(Sku.of('  SKU-1  ').value).toBe('SKU-1');
  });

  it('compares by canonical value', () => {
    expect(Sku.of('SKU-1').equals(Sku.of(' SKU-1 '))).toBe(true);
    expect(Sku.of('SKU-1').equals(Sku.of('SKU-2'))).toBe(false);
  });

  it.each([
    ['an empty string', ''],
    ['only whitespace', '   '],
    ['a missing value', undefined],
    ['a number', 42],
  ])('refuses %s', (_label, raw) => {
    expect(() => Sku.of(raw)).toThrow(ValidationException);
  });
});

describe('ProductId', () => {
  it('trims and exposes the identifier', () => {
    expect(ProductId.of(' product-1 ').value).toBe('product-1');
  });

  it.each([
    ['an empty string', ''],
    ['only whitespace', '   '],
    ['a missing value', undefined],
  ])('refuses %s', (_label, raw) => {
    expect(() => ProductId.of(raw)).toThrow(/productId is required/);
  });
});

describe('Quantity', () => {
  it('keeps a positive whole number', () => {
    expect(Quantity.of(3).value).toBe(3);
  });

  it.each([
    ['zero', 0],
    ['a negative number', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['a string', '2'],
  ])('refuses %s', (_label, raw) => {
    expect(() => Quantity.of(raw)).toThrow(/positive integer/);
  });

  it('adds two counts exactly', () => {
    expect(Quantity.of(2).plus(Quantity.of(3)).value).toBe(5);
  });

  it('refuses an addition beyond the safe integer range', () => {
    expect(() =>
      Quantity.of(Number.MAX_SAFE_INTEGER).plus(Quantity.of(1)),
    ).toThrow(/positive integer/);
  });

  it('reports whether it fits a ceiling without changing itself', () => {
    const quantity = Quantity.of(10);

    expect(quantity.isAtMost(10)).toBe(true);
    expect(quantity.isAtMost(9)).toBe(false);
    expect(quantity.value).toBe(10);
  });

  it('raises the validation error a cart add owes the caller above the ceiling', () => {
    expect(() => Quantity.of(11).assertAtMost(10, { sku: 'SKU-1' })).toThrow(
      /exceeds the per-item limit/,
    );
    expect(() => Quantity.of(10).assertAtMost(10)).not.toThrow();
  });
});

describe('CartStatus', () => {
  it('accepts every state the contract names', () => {
    for (const status of CART_STATUSES) {
      expect(isCartStatus(status)).toBe(true);
    }
  });

  it('refuses anything else', () => {
    expect(isCartStatus('nonsense')).toBe(false);
    expect(isCartStatus('')).toBe(false);
    expect(isCartStatus(undefined)).toBe(false);
  });
});
