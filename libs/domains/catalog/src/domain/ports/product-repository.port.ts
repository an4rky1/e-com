/**
 * @fileoverview Storage port for the Product aggregate.
 *
 * @remarks Declared in the domain and implemented in infrastructure so the aggregate can ask
 * to be persisted without knowing that Postgres exists — and so the unit tests can use a
 * plain object instead of a database.
 *
 * @remarks The three purpose-built reads (`findManyBySkus`, `findManyByCategory`,
 * `existsBySku`) exist next to the generic specification pair on purpose. A specification
 * has to be evaluable in a unit test without a database, but a bulk price lookup that loads
 * the whole catalogue to filter it in memory would turn one indexed query into a table scan
 * on the hottest path the cart owns.
 */
import type { ISpecification } from '@auth/core';
import type { Product } from '../product.aggregate';

export const PRODUCT_REPOSITORY = Symbol('PRODUCT_REPOSITORY');

export interface ProductRepositoryPort {
  /**
   * Persists one product and writes its pending domain events in the same transaction.
   *
   * @remarks Both halves must commit together. Writing the row and the events separately
   * leaves a window where the product exists but `product.created` never fires, and no
   * consumer ever learns it was listed.
   */
  save(product: Product): Promise<void>;

  /** Persists several products atomically, with their events, in one transaction. */
  saveMany(products: readonly Product[]): Promise<void>;

  findById(id: string): Promise<Product | null>;

  /**
   * Whether any product already holds this sku.
   *
   * @remarks The unique index on `product_variants.sku` is the real guarantee; this is the
   * check that turns a collision into a clean 409 instead of a driver-level error code
   * surfacing as a 500 on the caller's first import.
   */
  existsBySku(sku: string): Promise<boolean>;

  /**
   * Every product carrying at least one of `skus`, with its variants.
   *
   * @remarks Skus that no product holds are simply absent from the result: a bulk price
   * lookup is answered from what exists, and a caller that asked for twelve identifiers and
   * found eleven is told which eleven by the response itself.
   */
  findManyBySkus(skus: readonly string[]): Promise<Product[]>;

  /**
   * Products whose `category_path` contains every segment of `categoryPath`.
   *
   * @remarks A *candidate* set, not the answer: Postgres array containment (`@>`, which
   * backs Prisma's `hasEvery`) cannot express an ordered prefix — `["running", "shoes"]`
   * contains `["running"]` even though it is not a descendant of `running`. The repository
   * narrows with `hasEvery` because it is index-assisted and cheap, and the caller applies
   * the exact prefix rule in JavaScript, where the rule is readable and cannot drift from
   * the aggregate's own notion of a category path.
   */
  findManyByCategory(categoryPath: readonly string[]): Promise<Product[]>;

  find(spec: ProductSpecification): Promise<Product[]>;

  count(spec: ProductSpecification): Promise<number>;
}

/**
 * Predicate over products.
 *
 * @remarks In-memory predicates rather than query-builder fragments: a specification has to
 * be evaluable in a unit test without a database, which is the only way the domain rules
 * stay honest.
 */
export abstract class ProductSpecification implements ISpecification<Product> {
  abstract isSatisfiedBy(product: Product): boolean;

  and(other: ProductSpecification): ProductSpecification {
    return new CompositeProductSpecification(
      (product) => this.isSatisfiedBy(product),
      (product) => other.isSatisfiedBy(product),
      (left, right) => left && right,
    );
  }

  or(other: ProductSpecification): ProductSpecification {
    return new CompositeProductSpecification(
      (product) => this.isSatisfiedBy(product),
      (product) => other.isSatisfiedBy(product),
      (left, right) => left || right,
    );
  }

  not(): ProductSpecification {
    return new CompositeProductSpecification(
      (product) => this.isSatisfiedBy(product),
      () => true,
      (left) => !left,
    );
  }
}

/**
 * Two predicates and how to join them.
 *
 * @remarks Predicates rather than a pair of specifications, so the combination closes over its
 * operands instead of aliasing `this` into a local — which reads better and keeps the
 * composition reusable for a predicate that is not itself a specification.
 */
class CompositeProductSpecification extends ProductSpecification {
  constructor(
    private readonly left: (product: Product) => boolean,
    private readonly right: (product: Product) => boolean,
    private readonly combine: (left: boolean, right: boolean) => boolean,
  ) {
    super();
  }

  isSatisfiedBy(product: Product): boolean {
    return this.combine(this.left(product), this.right(product));
  }
}

/**
 * Products still on sale.
 *
 * @remarks The storefront's question, and the one a "what can I still buy?" filter asks.
 * Deliberately *not* what the health probe runs: `count` over this predicate loads the whole
 * catalogue, and a readiness check has to cost the same at ten products as at ten million.
 */
export class ActiveProducts extends ProductSpecification {
  isSatisfiedBy(product: Product): boolean {
    return product.isActive;
  }
}

/** One sku, wherever it lives. Used as a cheap "did the query path work?" probe. */
export class BySku extends ProductSpecification {
  constructor(private readonly sku: string) {
    super();
  }

  isSatisfiedBy(product: Product): boolean {
    return product.variant(this.sku) !== undefined;
  }
}
