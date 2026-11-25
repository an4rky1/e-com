/**
 * @fileoverview The cart aggregate: the invariants no caller can be trusted to keep.
 *
 * @remarks Two rules live here and nowhere else. A cart is single-currency — the first
 * line fixes it — because a subtotal that adds dollars to euros is not a number any
 * downstream service can interpret. And the version advances on *every* write, which is
 * what makes it usable as the optimistic token `cart.v1` puts on the wire.
 *
 * @remarks The merge gets the most attention because it is the only operation in this
 * service with a genuinely subtle rule: quantities are summed, the *user's* price wins for
 * a SKU both carts hold, and the per-item ceiling is deliberately not re-applied. Each of
 * those is a decision somebody could reasonably have made the other way, so each is pinned.
 */
import { ResourceNotFoundException, ValidationException } from '@auth/platform/error-handling';
import { Cart, type CartLimits } from '../src/domain/cart.aggregate';
import type { CartItemProps, NewCartItemInput } from '../src/domain/cart-item';
import { Money } from '../src/domain/value-objects/money';
import { ProductId } from '../src/domain/value-objects/product-id.vo';
import { Quantity } from '../src/domain/value-objects/quantity.vo';
import { Sku } from '../src/domain/value-objects/sku.vo';
import { USER_ID, storedCart, storedItem } from './support/fakes';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const LATER = new Date('2026-01-02T00:00:00.000Z');

const ADDRESS = { ownerKey: `user:${USER_ID}`, sessionId: '', userId: USER_ID };

const LIMITS: CartLimits = { maxItems: 3, maxQuantityPerItem: 10 };

interface RawLine {
  sku?: string;
  productId?: string;
  name?: string;
  quantity?: number;
  unitPrice?: Money;
}

const line = (overrides: RawLine = {}): NewCartItemInput => ({
  sku: Sku.of(overrides.sku ?? 'SKU-1'),
  productId: ProductId.of(overrides.productId ?? 'product-1'),
  name: overrides.name ?? 'Blue mug',
  quantity: Quantity.of(overrides.quantity ?? 2),
  unitPrice: overrides.unitPrice ?? Money.of(1_000, 'USD'),
});

/** A cart with one line already in it, so a test can start from a non-empty basket. */
const filledCart = (): Cart => {
  const cart = Cart.empty(ADDRESS, NOW);
  cart.addItem(line(), LIMITS, NOW);
  return cart;
};

describe('Cart.empty', () => {
  it('starts at version 0 with nothing in it', () => {
    const cart = Cart.empty(ADDRESS, NOW);

    expect(cart.version).toBe(0);
    expect(cart.itemCount).toBe(0);
    expect(cart.subtotal).toBeNull();
    expect(cart.isEmpty).toBe(true);
    expect(cart.status).toBe('active');
  });

  it('carries no currency until a line gives it one', () => {
    // `''` rather than a guessed default: an empty cart has no currency, and inventing
    // `USD` here would put a code on the wire that no line in the basket uses.
    expect(Cart.empty(ADDRESS, NOW).currency).toBe('');
  });

  it('stamps both timestamps with the clock it was given', () => {
    const cart = Cart.empty(ADDRESS, NOW);

    expect(cart.createdAt).toEqual(NOW);
    expect(cart.updatedAt).toEqual(NOW);
  });
});

describe('Cart.fromStored', () => {
  it('restores the document the store wrote', () => {
    const cart = Cart.fromStored(
      `user:${USER_ID}`,
      storedCart({ version: 4, items: [storedItem()] }),
    );

    expect(cart.version).toBe(4);
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0].sku.value).toBe('SKU-1');
    expect(cart.itemCount).toBe(2);
    expect(cart.subtotal?.amountMinor).toBe(2_000);
    expect(cart.currency).toBe('USD');
  });

  it('takes updatedAt from the document, not from the clock', () => {
    // The TTL slides from this timestamp. Re-stamping it on read would move a cart's
    // expiry forward every time somebody merely looked at it.
    const cart = Cart.fromStored(
      `user:${USER_ID}`,
      storedCart({ updatedAt: '2025-06-15T12:34:56.000Z' }),
    );

    expect(cart.updatedAt.toISOString()).toBe('2025-06-15T12:34:56.000Z');
    expect(cart.updatedAt).not.toEqual(NOW);
  });

  it('falls back to `active` for a status the document should not have', () => {
    const cart = Cart.fromStored(
      `user:${USER_ID}`,
      storedCart({ status: 'nonsense' as never }),
    );

    expect(cart.status).toBe('active');
  });
});

describe('Cart.addItem', () => {
  it('adds a new line and advances the version', () => {
    const cart = Cart.empty(ADDRESS, NOW);

    cart.addItem(line(), LIMITS, NOW);

    expect(cart.items).toHaveLength(1);
    expect(cart.itemCount).toBe(2);
    expect(cart.subtotal?.amountMinor).toBe(2_000);
    expect(cart.version).toBe(1);
  });

  it('tops up an existing line instead of adding a second one', () => {
    const cart = filledCart();

    cart.addItem(line({ quantity: 3 }), LIMITS, LATER);

    expect(cart.items).toHaveLength(1);
    expect(cart.itemCount).toBe(5);
    expect(cart.version).toBe(2);
  });

  it('keeps the price the line was added at when the catalogue has moved', () => {
    // The snapshot is what the shopper agreed to. Rewriting it here is exactly the silent
    // total change `cart.v1.price_changed` exists to prevent.
    const cart = filledCart();

    cart.addItem(line({ quantity: 3, unitPrice: Money.of(2_500, 'USD') }), LIMITS, LATER);

    expect(cart.items[0].unitPrice.amountMinor).toBe(1_000);
    expect(cart.itemCount).toBe(5);
    expect(cart.subtotal?.amountMinor).toBe(5_000);
  });

  it('refuses a second currency, whether or not the SKU is already in the cart', () => {
    const cart = filledCart();

    expect(() => cart.addItem(line({ sku: 'SKU-2' }), LIMITS, NOW)).not.toThrow();
    expect(() =>
      cart.addItem(line({ sku: 'SKU-3', unitPrice: Money.of(1_000, 'EUR') }), LIMITS, NOW),
    ).toThrow(/a cart holds one currency only/);
    expect(() =>
      cart.addItem(line({ unitPrice: Money.of(1_000, 'EUR') }), LIMITS, NOW),
    ).toThrow(/a cart holds one currency only/);
  });

  it('refuses a new SKU once the cart is full', () => {
    const cart = Cart.empty(ADDRESS, NOW);
    cart.addItem(line({ sku: 'SKU-1' }), LIMITS, NOW);
    cart.addItem(line({ sku: 'SKU-2' }), LIMITS, NOW);
    cart.addItem(line({ sku: 'SKU-3' }), LIMITS, NOW);

    expect(() => cart.addItem(line({ sku: 'SKU-4' }), LIMITS, NOW)).toThrow(
      /the cart is full/,
    );
  });

  it('still tops up a line the cart already holds when it is full', () => {
    // The limit bounds the document's *shape*, not how much of one thing may be bought:
    // a full cart that cannot take one more unit of something already in it would refuse
    // the most ordinary request there is.
    const cart = Cart.empty(ADDRESS, NOW);
    cart.addItem(line({ sku: 'SKU-1' }), LIMITS, NOW);
    cart.addItem(line({ sku: 'SKU-2' }), LIMITS, NOW);
    cart.addItem(line({ sku: 'SKU-3' }), LIMITS, NOW);

    expect(() => cart.addItem(line({ quantity: 1 }), LIMITS, NOW)).not.toThrow();
  });

  it.each<[string, RawLine]>([
    ['an empty sku', { sku: '   ' }],
    ['a missing productId', { productId: '' }],
    ['a zero quantity', { quantity: 0 }],
    ['a fractional quantity', { quantity: 1.5 }],
  ])('refuses %s at the line, not at the call site', (_label, overrides) => {
    const cart = Cart.empty(ADDRESS, NOW);

    expect(() => cart.addItem(line(overrides), LIMITS, NOW)).toThrow(
      ValidationException,
    );
    expect(cart.version).toBe(0);
    expect(cart.isEmpty).toBe(true);
  });

  it('refuses a quantity above the per-item ceiling', () => {
    const cart = Cart.empty(ADDRESS, NOW);

    expect(() => cart.addItem(line({ quantity: 11 }), LIMITS, NOW)).toThrow(
      /exceeds the per-item limit/,
    );
  });

  it('applies the ceiling to a top-up, not only to a new line', () => {
    const cart = Cart.empty(ADDRESS, NOW);
    cart.addItem(line({ quantity: 10 }), LIMITS, NOW);

    expect(() => cart.addItem(line({ quantity: 1 }), LIMITS, NOW)).toThrow(
      /exceeds the per-item limit/,
    );
    expect(cart.items[0].quantity.value).toBe(10);
    expect(cart.version).toBe(1);
  });
});

describe('Cart.updateQuantity', () => {
  it('sets an absolute quantity and advances the version', () => {
    const cart = filledCart();

    cart.updateQuantity(Sku.of('SKU-1'), Quantity.of(7), LIMITS, LATER);

    expect(cart.itemCount).toBe(7);
    expect(cart.version).toBe(2);
    expect(cart.items[0].updatedAt).toEqual(LATER);
  });

  it('refuses a SKU the cart does not hold rather than pretending to change it', () => {
    const cart = filledCart();

    expect(() =>
      cart.updateQuantity(Sku.of('SKU-9'), Quantity.of(2), LIMITS, NOW),
    ).toThrow(ResourceNotFoundException);
    expect(cart.version).toBe(1);
  });

  it('refuses zero, because RemoveItem is the call that means that', () => {
    // A number that means two different things depending on whether it is zero is the
    // kind of overloading that survives a rewrite of the client and then removes
    // something on a decrement that was meant to be a decrement.
    const cart = filledCart();

    expect(() =>
      cart.updateQuantity(Sku.of('SKU-1'), Quantity.of(0), LIMITS, NOW),
    ).toThrow(/quantity must be a positive integer/);
  });

  it('refuses a quantity above the per-item ceiling', () => {
    const cart = filledCart();

    expect(() =>
      cart.updateQuantity(Sku.of('SKU-1'), Quantity.of(11), LIMITS, NOW),
    ).toThrow(/exceeds the per-item limit/);
  });
});

describe('Cart.removeItem', () => {
  it('drops the line and advances the version', () => {
    const cart = filledCart();

    cart.removeItem(Sku.of('SKU-1'), LATER);

    expect(cart.isEmpty).toBe(true);
    expect(cart.version).toBe(2);
    expect(cart.currency).toBe('');
  });

  it('refuses a SKU that is not there rather than reporting success', () => {
    // Answering "done" would make a stale screen and a correct one indistinguishable.
    const cart = filledCart();

    expect(() => cart.removeItem(Sku.of('SKU-9'), NOW)).toThrow(
      ResourceNotFoundException,
    );
    expect(cart.version).toBe(1);
  });
});

describe('Cart.clear', () => {
  it('empties the cart but keeps the document', () => {
    const cart = filledCart();

    cart.clear(LATER);

    expect(cart.isEmpty).toBe(true);
    expect(cart.version).toBe(2);
    expect(cart.sessionId).toBe(ADDRESS.sessionId);
    expect(cart.userId).toBe(ADDRESS.userId);
  });

  it('spends no version on a cart that is already empty', () => {
    // "Make this basket empty" is satisfied by an empty basket, so a retry after a
    // dropped connection answers exactly as the first call did.
    const cart = Cart.empty(ADDRESS, NOW);

    cart.clear(LATER);

    expect(cart.version).toBe(0);
    expect(cart.updatedAt).toEqual(NOW);
  });
});

describe('Cart.mergeGuest', () => {
  const guestLine = (overrides: RawLine = {}): CartItemProps => ({
    sku: Sku.of(overrides.sku ?? 'SKU-G'),
    productId: ProductId.of(overrides.productId ?? 'product-g'),
    name: overrides.name ?? 'Guest item',
    quantity: Quantity.of(overrides.quantity ?? 1),
    unitPrice: overrides.unitPrice ?? Money.of(500, 'USD'),
    addedAt: NOW,
    updatedAt: NOW,
  });

  it('adds lines the user cart does not hold', () => {
    const cart = filledCart();

    cart.mergeGuest([guestLine()], LATER);

    expect(cart.items.map((item) => item.sku.value)).toEqual(['SKU-1', 'SKU-G']);
    expect(cart.subtotal?.amountMinor).toBe(2_500);
    expect(cart.version).toBe(2);
  });

  it('sums quantities for a SKU both carts hold', () => {
    const cart = filledCart();

    cart.mergeGuest(
      [guestLine({ sku: 'SKU-1', quantity: 3, unitPrice: Money.of(999, 'USD') })],
      LATER,
    );

    expect(cart.items).toHaveLength(1);
    expect(cart.itemCount).toBe(5);
  });

  it('keeps the user\'s price for a SKU both carts hold', () => {
    // The price they saw when they added it is the price they agreed to; replacing it
    // with the guest's figure would be the silent rewrite this service exists to avoid.
    const cart = filledCart();

    cart.mergeGuest(
      [guestLine({ sku: 'SKU-1', quantity: 3, unitPrice: Money.of(999, 'USD') })],
      LATER,
    );

    expect(cart.items[0].unitPrice.amountMinor).toBe(1_000);
    expect(cart.itemCount).toBe(5);
    expect(cart.subtotal?.amountMinor).toBe(5_000);
  });

  it('spends no version on a guest cart with nothing in it', () => {
    const cart = filledCart();

    cart.mergeGuest([], LATER);

    expect(cart.version).toBe(1);
    expect(cart.updatedAt).toEqual(NOW);
  });

  it('does not re-apply the per-item ceiling, because a merge is not a request', () => {
    // Refusing would mean signing in could fail because two carts together hold more of
    // something than one cart may hold; clamping would silently drop units the shopper
    // can never get back. The sum may overshoot, and they can always lower it.
    const cart = Cart.empty(ADDRESS, NOW);
    cart.addItem(line({ quantity: 10 }), LIMITS, NOW);

    cart.mergeGuest(
      [guestLine({ sku: 'SKU-1', quantity: 10, unitPrice: Money.of(1_000, 'USD') })],
      LATER,
    );

    expect(cart.itemCount).toBe(20);
  });

  it('refuses a guest cart in another currency before changing anything', () => {
    // A cart is single-currency. Folding a USD guest line into a EUR cart would produce a
    // subtotal no downstream service can charge, and half-applying the merge would leave
    // a cart that is neither the old one nor the guest one.
    const cart = Cart.empty({ ...ADDRESS, ownerKey: 'user:eur' }, NOW);
    cart.addItem(line({ unitPrice: Money.of(1_000, 'EUR') }), LIMITS, NOW);

    expect(() =>
      cart.mergeGuest([guestLine({ unitPrice: Money.of(500, 'USD') })], LATER),
    ).toThrow(/a cart holds one currency only/);
    expect(cart.items).toHaveLength(1);
    expect(cart.version).toBe(1);
  });

  it('stamps a guest line with the merge time, not with when the guest added it', () => {
    const cart = Cart.empty(ADDRESS, NOW);

    cart.mergeGuest([guestLine()], LATER);

    expect(cart.items[0].updatedAt).toEqual(LATER);
    expect(cart.items[0].addedAt).toEqual(NOW);
  });
});

describe('Cart.toStored', () => {
  it('writes the document the store validates, with ISO dates', () => {
    const cart = filledCart();

    expect(cart.toStored()).toEqual({
      sessionId: '',
      userId: USER_ID,
      status: 'active',
      version: 1,
      updatedAt: NOW.toISOString(),
      items: [
        {
          sku: 'SKU-1',
          productId: 'product-1',
          name: 'Blue mug',
          quantity: 2,
          unitPriceMinor: 1_000,
          currency: 'USD',
          addedAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        },
      ],
    });
  });

  it('round-trips through fromStored without changing a figure', () => {
    const cart = filledCart();
    cart.updateQuantity(Sku.of('SKU-1'), Quantity.of(5), LIMITS, LATER);

    const restored = Cart.fromStored(`user:${USER_ID}`, cart.toStored());

    expect(restored.toStored()).toEqual(cart.toStored());
    expect(restored.itemCount).toBe(5);
    expect(restored.subtotal?.amountMinor).toBe(5_000);
    expect(restored.version).toBe(2);
  });
});
