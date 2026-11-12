/**
 * @fileoverview The product aggregate: what makes a product a product.
 *
 * @remarks These are the rules that must hold no matter who built the document — the gRPC
 * handler, a seeding script, an importer — so they are asserted against the aggregate itself
 * rather than through a handler, where a second entry point could bypass them.
 */
import 'reflect-metadata';
import { DomainError } from '@auth/core';
import {
  Product,
  PRODUCT_NAME_MAX_LENGTH,
  PRODUCT_NAME_MIN_LENGTH,
} from '../src/domain/product.aggregate';
import { thrown, payloadFor } from './support/helpers';
import { makeProduct } from './support/fakes';

describe('Product.create', () => {
  it('mints an active product at version 1 with its creation event buffered', () => {
    const product = Product.create({
      id: '11111111-1111-1111-1111-111111111111',
      name: '  Trail Runner  ',
      currency: 'USD',
      categoryPath: ['shoes', 'running'],
      variants: [{ sku: ' TR-RED-9 ', priceMinor: 12_500 }],
      mediaKeys: ['hero.jpg'],
      now: new Date('2024-01-01T00:00:00.000Z'),
    });

    expect(product.id).toBe('11111111-1111-1111-1111-111111111111');
    expect(product.name).toBe('Trail Runner');
    expect(product.isActive).toBe(true);
    expect(product.version).toBe(1);
    expect(product.createdAt.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(product.categoryPath).toEqual(['shoes', 'running']);
    expect(product.mediaKeys).toEqual(['hero.jpg']);
    expect(product.currency).toBe('USD');

    expect(product.domainEvents.map((event) => event.eventType)).toEqual(['product.created']);
    const created = payloadFor<{ priceMinor?: number }>(
      product.domainEvents,
      'product.created',
    );
    expect(created).toMatchObject({
      productId: product.id,
      skus: ['TR-RED-9'],
      currency: 'USD',
    });
    // The price is deliberately absent: see the payload's own documentation.
    expect(created.priceMinor).toBeUndefined();
  });

  it('rejects a product nobody can buy', () => {
    const error = thrown(() =>
      Product.create({ name: 'Bare', currency: 'USD', variants: [] }),
    ) as DomainError;

    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe('INVARIANT_VIOLATION');
    expect(error.message).toContain('at least one variant');
  });

  it('rejects duplicate skus inside one product', () => {
    const error = thrown(() =>
      Product.create({
        name: 'Twice',
        currency: 'USD',
        variants: [
          { sku: 'SAME', priceMinor: 1 },
          { sku: ' SAME ', priceMinor: 2 },
        ],
      }),
    ) as DomainError;

    expect(error.code).toBe('INVARIANT_VIOLATION');
    expect(error.message).toContain('duplicate sku');
  });

  it.each([
    ['negative', -1],
    ['fractional', 10.5],
    ['beyond safe integer', Number.MAX_SAFE_INTEGER + 2],
  ])('rejects a %s price', (_label, priceMinor) => {
    const error = thrown(() =>
      Product.create({
        name: 'Priced',
        currency: 'USD',
        variants: [{ sku: 'SKU', priceMinor }],
      }),
    ) as DomainError;

    expect(error.code).toBe('OUT_OF_RANGE');
    expect(error.message).toContain('non-negative integer');
  });

  it('rejects a name outside the documented bounds', () => {
    const short = thrown(() =>
      Product.create({ name: 'x', currency: 'USD', variants: [{ sku: 'A', priceMinor: 1 }] }),
    ) as DomainError;
    const long = thrown(() =>
      Product.create({
        name: 'x'.repeat(PRODUCT_NAME_MAX_LENGTH + 1),
        currency: 'USD',
        variants: [{ sku: 'A', priceMinor: 1 }],
      }),
    ) as DomainError;

    expect(short.message).toContain(String(PRODUCT_NAME_MIN_LENGTH));
    expect(long.message).toContain(String(PRODUCT_NAME_MAX_LENGTH));
  });

  it('trims every sku and every category segment as written', () => {
    const product = Product.create({
      name: 'Trimmed',
      currency: ' USD ',
      categoryPath: [' shoes ', 'running'],
      variants: [{ sku: ' TR-1 ', priceMinor: 100 }],
    });

    expect(product.currency).toBe('USD');
    expect(product.categoryPath).toEqual(['shoes', 'running']);
    expect(product.variants.map((variant) => variant.sku)).toEqual(['TR-1']);
  });
});

describe('Product.setVariantPrice', () => {
  it('moves the price, the version and the event together', () => {
    const product = makeProduct();
    product.clearDomainEvents();

    product.setVariantPrice('TR-RED-9', 14_000, new Date('2024-02-01T00:00:00.000Z'));

    expect(product.variant('TR-RED-9')?.priceMinor).toBe(14_000);
    expect(product.version).toBe(2);
    expect(product.updatedAt.toISOString()).toBe('2024-02-01T00:00:00.000Z');
    expect(payloadFor(product.domainEvents, 'product.price_changed')).toMatchObject({
      productId: product.id,
      sku: 'TR-RED-9',
      before: { amountMinor: 12_500, currency: 'USD' },
      after: { amountMinor: 14_000, currency: 'USD' },
    });
    // The event carries the version it was emitted at, so a consumer ordering by version sees
    // the same number the row will store.
    expect(product.domainEvents[0]?.version).toBe(2);
  });

  it('is silent when the price did not move', () => {
    const product = makeProduct();
    product.clearDomainEvents();

    product.setVariantPrice('TR-RED-9', 12_500);

    expect(product.domainEvents).toHaveLength(0);
    expect(product.version).toBe(1);
  });

  it('refuses an archived product', () => {
    const product = makeProduct();
    product.archive('discontinued');
    product.clearDomainEvents();

    const error = thrown(() => product.setVariantPrice('TR-RED-9', 1)) as DomainError;

    expect(error.code).toBe('CONFLICTING_STATE');
    expect(product.variant('TR-RED-9')?.priceMinor).toBe(12_500);
  });

  it('refuses a sku the product does not hold', () => {
    const product = makeProduct();

    expect(() => product.setVariantPrice('NOPE', 1)).toThrow(DomainError);
    expect(() => product.setVariantPrice('nope', 1)).toThrow(/variant "nope"/);
  });

  it('refuses a price that is not a non-negative integer', () => {
    const product = makeProduct();

    expect(() => product.setVariantPrice('TR-RED-9', -1)).toThrow(/non-negative integer/);
    expect(() => product.setVariantPrice('TR-RED-9', 1.5)).toThrow(/non-negative integer/);
  });
});

describe('Product.archive', () => {
  it('withdraws the product and records why', () => {
    const product = makeProduct();
    product.clearDomainEvents();

    product.archive('discontinued', new Date('2024-03-01T00:00:00.000Z'));

    expect(product.isActive).toBe(false);
    expect(product.version).toBe(2);
    expect(payloadFor(product.domainEvents, 'product.archived')).toMatchObject({
      productId: product.id,
      name: 'Trail Runner',
      reason: 'discontinued',
    });
  });

  it('is idempotent: a retried job announces nothing twice', () => {
    const product = makeProduct();
    product.clearDomainEvents();

    product.archive('discontinued');
    product.archive('discontinued');

    expect(product.domainEvents).toHaveLength(1);
    expect(product.version).toBe(2);
  });

  it('leaves the document in place so an old order still resolves', () => {
    const product = makeProduct();
    product.archive('discontinued');

    expect(product.name).toBe('Trail Runner');
    expect(product.variants).toHaveLength(1);
    expect(product.variant('TR-RED-9')?.priceMinor).toBe(12_500);
  });
});

describe('Product.fromRow / toRow', () => {
  it('rehydrates without replaying history', () => {
    const original = makeProduct({
      variants: [
        { sku: 'TR-BLUE-9', priceMinor: 13_000, attrs: { colour: 'blue' } },
        { sku: 'TR-RED-9', priceMinor: 12_500 },
      ],
    });
    const rows = original.toRow();
    original.clearDomainEvents();

    const rehydrated = Product.fromRow(rows.product, rows.variants);

    expect(rehydrated.domainEvents).toHaveLength(0);
    expect(rehydrated.id).toBe(original.id);
    expect(rehydrated.version).toBe(original.version);
    expect(rehydrated.createdAt).toEqual(original.createdAt);
    expect(rehydrated.isActive).toBe(true);
    // Sorted by sku, so two reads of the same document always present the same list.
    expect(rehydrated.variants.map((variant) => variant.sku)).toEqual([
      'TR-BLUE-9',
      'TR-RED-9',
    ]);
    expect(rehydrated.variant('TR-BLUE-9')?.attrs).toEqual({ colour: 'blue' });
  });

  it('carries a coerced attribute map rather than a raw JSON column', () => {
    const original = makeProduct({
      variants: [{ sku: 'A', priceMinor: 1, attrs: { size: '9' } }],
    });
    const rows = original.toRow();

    // What Prisma would hand back: a `JsonValue`, which is not a `Record<string, string>`.
    const fromDatabase = Product.fromRow(rows.product, [
      { ...rows.variants[0]!, attrs: { size: 9 } as unknown as Record<string, string> },
    ]);

    expect(fromDatabase.variant('A')?.attrs).toEqual({ size: '9' });
  });

  it('survives a round trip without drifting', () => {
    const original = makeProduct();
    const once = original.toRow();
    const twice = Product.fromRow(once.product, once.variants).toRow();

    expect(twice.product).toEqual(once.product);
    expect(twice.variants).toEqual(once.variants);
  });

  it('keeps `version` as the persisted event position, not the buffered count', () => {
    const product = makeProduct();
    product.setVariantPrice('TR-RED-9', 20_000);
    const rows = product.toRow();

    // The aggregate has drained nothing here, so a naive `version` would be the buffered
    // events (1) rather than the document's position (2).
    expect(product.version).toBe(2);
    expect(rows.product.version).toBe(2);

    const rehydrated = Product.fromRow(rows.product, rows.variants);
    rehydrated.setVariantPrice('TR-RED-9', 21_000);
    expect(rehydrated.version).toBe(3);
  });
});

describe('Product.priceRange', () => {
  it('spans the cheapest and dearest variant', () => {
    const product = makeProduct({
      variants: [
        { sku: 'A', priceMinor: 900 },
        { sku: 'B', priceMinor: 1_900 },
        { sku: 'C', priceMinor: 1_200 },
      ],
    });

    expect(product.priceRange).toEqual({ min: 900, max: 1_900 });
  });
});
