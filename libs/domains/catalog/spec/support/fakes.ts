/**
 * @fileoverview In-memory doubles for the catalog ports.
 *
 * @remarks Hand-written rather than auto-mocked, for the same reason its siblings are: a mock
 * asserts on the calls a test *expects*, while the question these suites keep asking is "what
 * would be stored, and what would be published" — and only the resulting state answers that.
 *
 * @remarks The repository stores **rehydrated rows**, not the aggregates it was handed. That is
 * load-bearing: an assertion about `active` or `version` then proves the change reached
 * storage, rather than proving it is sitting in an object the handler still holds. It also runs
 * `fromRow` on every read, which is where a column renamed on one side only would show up.
 */
import type { IDomainEvent } from '@auth/core';
import type {
  ProductRepositoryPort,
  ProductSpecification,
} from '../../src/domain/ports/product-repository.port';
import {
  Product,
  type ProductRow,
  type ProductVariantRow,
} from '../../src/domain/product.aggregate';

/** One row the repository would have written to `outbox_events`. */
export interface CapturedOutboxEvent {
  readonly eventType: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly eventId: string;
  readonly dedupKey: string;
  readonly topic: string | null;
  readonly payload: unknown;
}

/** What a product looks like once it has been written: the document plus its variants. */
export interface StoredProduct {
  readonly product: ProductRow;
  readonly variants: ProductVariantRow[];
}

export class InMemoryProductRepository implements ProductRepositoryPort {
  /** Stored rows, rehydrated — what a later request would actually load. */
  readonly rows = new Map<string, StoredProduct>();

  /** Every aggregate handed to `save`, in call order. */
  readonly saved: Product[] = [];

  /** Transaction boundaries. A multi-product save must add exactly one. */
  commits = 0;

  readonly outbox: CapturedOutboxEvent[] = [];

  constructor(
    seed: readonly Product[] = [],
    private readonly topics: Readonly<Record<string, string>> = {},
  ) {
    for (const product of seed) {
      // A seeded product stands for a row that is already in the database, so its events have
      // already been published. Draining them keeps assertions about "what did *this* command
      // announce" from being polluted by the fixture.
      product.clearDomainEvents();
      const rows = product.toRow();
      this.rows.set(product.id, { product: rows.product, variants: rows.variants });
    }
  }

  async save(product: Product): Promise<void> {
    await this.saveMany([product]);
  }

  /**
   * Mirrors the real repository: one boundary for the whole batch, events drained on write.
   *
   * @remarks The drain order is the real one — buffered events go to the outbox, then the row
   * lands — because a repository that wrote the row and kept the events would produce a product
   * no consumer ever hears about.
   */
  async saveMany(products: readonly Product[]): Promise<void> {
    if (products.length === 0) return;
    this.commits += 1;

    for (const product of products) {
      const events = product.clearDomainEvents();
      this.saved.push(product);

      const rows = product.toRow();
      this.rows.set(product.id, { product: rows.product, variants: rows.variants });

      for (const event of events) {
        this.outbox.push(capture(event, this.topics));
      }
    }
  }

  async findById(id: string): Promise<Product | null> {
    const stored = this.rows.get(id);
    return stored ? hydrate(stored) : null;
  }

  async existsBySku(sku: string): Promise<boolean> {
    return [...this.rows.values()].some((stored) =>
      stored.variants.some((variant) => variant.sku === sku),
    );
  }

  async findManyBySkus(skus: readonly string[]): Promise<Product[]> {
    const wanted = new Set(skus);
    return [...this.rows.values()]
      .filter((stored) => stored.variants.some((variant) => wanted.has(variant.sku)))
      .map(hydrate);
  }

  /**
   * Mirrors `hasEvery` — order-blind containment, exactly like Postgres array `@>`.
   *
   * @remarks Not the ordered prefix rule on purpose: the handler applies that itself, and a
   * fake that already answered it would let a broken handler pass by accidentally duplicating
   * the rule in the double.
   */
  async findManyByCategory(categoryPath: readonly string[]): Promise<Product[]> {
    return [...this.rows.values()]
      .filter((stored) =>
        categoryPath.every((segment) => stored.product.category_path.includes(segment)),
      )
      .map(hydrate);
  }

  async find(spec: ProductSpecification): Promise<Product[]> {
    return [...this.rows.values()].map(hydrate).filter((product) => spec.isSatisfiedBy(product));
  }

  async count(spec: ProductSpecification): Promise<number> {
    return (await this.find(spec)).length;
  }
}

const hydrate = (stored: StoredProduct): Product =>
  Product.fromRow(stored.product, stored.variants);

function capture(event: IDomainEvent, topics: Readonly<Record<string, string>>): CapturedOutboxEvent {
  const candidate = event as unknown as { payload?: unknown };
  return {
    eventType: event.eventType,
    aggregateId: event.aggregateId,
    version: event.version,
    eventId: event.eventId,
    dedupKey: `${event.eventType}:${event.aggregateId}:${event.version}`,
    topic: topics[event.eventType] ?? null,
    payload: candidate.payload ?? {},
  };
}

/** Builds a product without every test restating the minimum a product needs. */
export const makeProduct = (
  overrides: {
    id?: string;
    name?: string;
    description?: string;
    categoryPath?: readonly string[];
    variants?: readonly {
      sku: string;
      priceMinor: number;
      attrs?: Record<string, string>;
    }[];
    mediaKeys?: readonly string[];
    currency?: string;
    now?: Date;
  } = {},
): Product =>
  Product.create({
    name: 'Trail Runner',
    currency: 'USD',
    categoryPath: ['shoes', 'running'],
    variants: [{ sku: 'TR-RED-9', priceMinor: 12_500 }],
    ...overrides,
  });
