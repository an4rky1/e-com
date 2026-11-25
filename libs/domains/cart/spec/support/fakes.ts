/**
 * @fileoverview In-memory doubles for the cart's ports.
 *
 * @remarks Hand-written rather than auto-mocked: a mock asserts on the calls a test
 * *expects*, while the question these suites keep asking is "what would be stored, and
 * what would the catalogue have answered" — and only the resulting state answers that.
 *
 * @remarks The store mirrors `RedisCartStore`'s contract on purpose — a `save` that both
 * writes and drops its `discardKey`, a `load` that returns `null` rather than throwing —
 * because a suite that only ever exercised the real store could not run without a Redis,
 * and one that only ever exercised this double could not tell whether the real one kept
 * its rules.
 */
import type { CartConfig } from '../../src/cart.config';
import type { StoredCart } from '../../src/domain/cart.aggregate';
import type {
  CartLockPort,
} from '../../src/domain/ports/cart-lock.port';
import type {
  CartStorePort,
  SaveCartInput,
} from '../../src/domain/ports/cart-store.port';
import type {
  CurrentPrice,
  ProductPricingPort,
  SellableSku,
} from '../../src/domain/ports/product-pricing.port';

export const SESSION_ID = '9f2c7a10-0000-4000-8000-000000000001';
export const USER_ID = 'user-42';

/** A config object for tests: the real defaults, without touching `process.env`. */
export const testCartConfig = (overrides: Partial<CartConfig> = {}): CartConfig => ({
  ttlSeconds: 86_400,
  maxItems: 100,
  maxQuantityPerItem: 999,
  autoMerge: true,
  grpcDeadlineMs: 5_000,
  keyPrefix: 'cart',
  ...overrides,
});

export class InMemoryCartStore implements CartStorePort {
  /** Stored documents, keyed by owner key — the shape Redis holds them under. */
  readonly documents = new Map<string, StoredCart>();

  /** Every `save` in order, so a suite can assert what was written and with what TTL. */
  readonly saves: SaveCartInput[] = [];

  /** Set to make every call reject, as an unreachable Redis would. */
  failure: Error | null = null;

  async load(key: string): Promise<StoredCart | null> {
    if (this.failure) throw this.failure;
    return this.documents.get(key) ?? null;
  }

  async save(input: SaveCartInput): Promise<void> {
    if (this.failure) throw this.failure;
    this.documents.set(input.key, input.cart);
    if (input.discardKey !== undefined) this.documents.delete(input.discardKey);
    this.saves.push(input);
  }

  async ping(): Promise<void> {
    if (this.failure) throw this.failure;
  }
}

/**
 * The catalogue, as a list the test controls.
 *
 * @remarks A SKU left out of `prices` is one the catalogue does not answer for at all —
 * which is how a delisted line is told apart from one whose price has simply not moved.
 */
export class FakePricing implements ProductPricingPort {
  readonly catalogue = new Map<string, SellableSku>();

  /** SKUs listed but not sellable (`active: false`). */
  readonly inactive = new Set<string>();

  /** Set to make every call reject, as an unreachable peer would. */
  failure: Error | null = null;

  /** Every `findPrices` input, so a suite can prove the catalogue was not consulted. */
  readonly priceLookups: string[][] = [];

  list(entry: SellableSku): this {
    this.catalogue.set(entry.sku, entry);
    return this;
  }

  async findSellable(sku: string): Promise<SellableSku | null> {
    if (this.failure) throw this.failure;
    const wanted = sku.trim();
    const hit = this.catalogue.get(wanted);
    if (!hit || this.inactive.has(wanted)) return null;
    return hit;
  }

  async findPrices(skus: readonly string[]): Promise<CurrentPrice[]> {
    if (this.failure) throw this.failure;
    this.priceLookups.push([...skus]);

    return skus
      .filter((sku) => this.catalogue.has(sku))
      .map((sku) => {
        const hit = this.catalogue.get(sku) as SellableSku;
        return {
          sku,
          price: hit.price,
          active: !this.inactive.has(sku),
        };
      });
  }
}

/** Records the name-sets it was asked to hold, and runs the section unguarded. */
export class RecordingLock implements CartLockPort {
  readonly acquisitions: string[][] = [];

  async withLock<T>(names: readonly string[], fn: () => Promise<T>): Promise<T> {
    this.acquisitions.push([...names]);
    return fn();
  }
}

/** A stored document, for a test that only needs the store to hold one. */
export const storedCart = (
  overrides: Partial<StoredCart> = {},
): StoredCart => ({
  sessionId: '',
  userId: '',
  status: 'active',
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  items: [],
  ...overrides,
});

export const storedItem = (
  overrides: Partial<NonNullable<StoredCart['items']>[number]> = {},
): NonNullable<StoredCart['items']>[number] => ({
  sku: 'SKU-1',
  productId: 'product-1',
  name: 'Blue mug',
  quantity: 2,
  unitPriceMinor: 1_000,
  currency: 'USD',
  addedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});
