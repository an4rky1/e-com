/**
 * @fileoverview `CART_*` resolution, and the boot failures it is supposed to cause.
 *
 * @remarks Configuration bugs are the ones that ship: a TTL that never expires so carts
 * accumulate forever, a key prefix that collapses onto a bare namespace so two deployments
 * sharing one Redis read each other's baskets, or a limit set to zero so the first add is
 * refused. Every one of them is refused here, at the moment the environment is read —
 * which is the only moment before the first request.
 *
 * @remarks The bounds are asserted as well as the parsing: `envInt` carries the range, and
 * a range that quietly widened would turn a typo into a cart of two million units.
 */
import 'reflect-metadata';
import { Defaults, resolveCartConfig } from '../src/cart.config';

describe('resolveCartConfig', () => {
  it('reads the documented defaults from an empty environment', () => {
    const config = resolveCartConfig({});

    expect(config.ttlSeconds).toBe(Defaults.TTL_SECONDS);
    expect(config.maxItems).toBe(Defaults.MAX_ITEMS);
    expect(config.maxQuantityPerItem).toBe(Defaults.MAX_QUANTITY_PER_ITEM);
    expect(config.autoMerge).toBe(Defaults.AUTO_MERGE);
    expect(config.grpcDeadlineMs).toBe(Defaults.GRPC_DEADLINE_MS);
    expect(config.keyPrefix).toBe(Defaults.KEY_PREFIX);
  });

  it('reads each setting from its namespaced key', () => {
    const config = resolveCartConfig({
      CART_TTL_SECONDS: '3600',
      CART_MAX_ITEMS: '5',
      CART_MAX_QUANTITY_PER_ITEM: '12',
      CART_AUTO_MERGE: 'false',
      CART_GRPC_DEADLINE_MS: '1500',
      CART_KEY_PREFIX: 'cart-staging',
    });

    expect(config).toEqual({
      ttlSeconds: 3_600,
      maxItems: 5,
      maxQuantityPerItem: 12,
      autoMerge: false,
      grpcDeadlineMs: 1_500,
      keyPrefix: 'cart-staging',
    });
  });

  it('ignores every key outside the CART_ namespace', () => {
    // A sibling service's settings must not leak in: `TTL_SECONDS` alone is not a cart's
    // to read, and silently accepting it would make two services share one setting.
    const config = resolveCartConfig({
      REDIS_URL: 'redis://elsewhere',
      SESSION_TTL_SECONDS: '60',
    });

    expect(config.ttlSeconds).toBe(Defaults.TTL_SECONDS);
  });

  it('refuses a TTL below the floor rather than expiring carts immediately', () => {
    expect(() => resolveCartConfig({ CART_TTL_SECONDS: '5' })).toThrow(
      /Invalid CART configuration: CART_TTL_SECONDS/,
    );
  });

  it('refuses a quantity limit that is not a positive integer', () => {
    expect(() => resolveCartConfig({ CART_MAX_QUANTITY_PER_ITEM: '0' })).toThrow(
      /CART_MAX_QUANTITY_PER_ITEM/,
    );
    expect(() => resolveCartConfig({ CART_MAX_QUANTITY_PER_ITEM: 'many' })).toThrow(
      /CART_MAX_QUANTITY_PER_ITEM/,
    );
  });

  it('refuses an empty key prefix rather than falling back to a bare namespace', () => {
    // `":data:user:42"` and `"cart:data:user:42"` are different keys. A deployment that
    // quietly collapsed onto the bare prefix would start reading another environment's
    // carts the first time both were pointed at one Redis.
    expect(() => resolveCartConfig({ CART_KEY_PREFIX: '   ' })).toThrow(
      /KEY_PREFIX must be a non-empty string/,
    );
  });

  it('trims the key prefix, so a padded value still names one namespace', () => {
    expect(resolveCartConfig({ CART_KEY_PREFIX: '  cart  ' }).keyPrefix).toBe('cart');
  });

  it('accepts the boundary values its own ranges declare', () => {
    const config = resolveCartConfig({
      CART_TTL_SECONDS: '60',
      CART_MAX_ITEMS: '1',
      CART_GRPC_DEADLINE_MS: '100',
    });

    expect(config.ttlSeconds).toBe(60);
    expect(config.maxItems).toBe(1);
    expect(config.grpcDeadlineMs).toBe(100);
  });
});
