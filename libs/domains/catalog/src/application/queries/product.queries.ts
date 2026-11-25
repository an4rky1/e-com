/**
 * @fileoverview The three reads this service offers: one document, a category page, a
 * bulk price lookup.
 *
 * @remarks Like every query in this workspace it is a class: `QueryBus.execute` resolves a
 * handler from `query.constructor`, and `@QueryHandler('Name')` throws at import because
 * `Reflect.hasOwnMetadata` rejects a non-object.
 *
 * @remarks Money stays an integer on the way out. The gRPC layer converts to `ShopMoney`
 * strings at the edge; a query that had already stringified a price would make the
 * presentation layer the place where the *domain's* number format is decided.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Query, QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { ResourceNotFoundException, ValidationException } from '@auth/platform/error-handling';
import {
  PRODUCT_REPOSITORY,
  type ProductRepositoryPort,
} from '../../domain/ports/product-repository.port';
import type { Product } from '../../domain/product.aggregate';
import {
  toProductView,
  type PricedSkuView,
  type ProductView,
} from '../commands/product.command';

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '@auth/contracts/http/api';

export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE };

/** One page of a category listing, with the size of the whole match set. */
export interface ProductListPage {
  readonly products: ProductView[];
  /** How many products match the category prefix, ignoring the page window. */
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export class GetProductQuery extends Query<ProductView> {
  readonly queryId: string = globalThis.crypto.randomUUID();

  constructor(readonly id: string) {
    super();
  }
}

export class ListByCategoryQuery extends Query<ProductListPage> {
  readonly queryId: string = globalThis.crypto.randomUUID();

  constructor(
    readonly categoryPath: readonly string[],
    readonly page = 1,
    readonly pageSize = DEFAULT_PAGE_SIZE,
  ) {
    super();
  }
}

export class GetPricingQuery extends Query<PricedSkuView[]> {
  readonly queryId: string = globalThis.crypto.randomUUID();

  constructor(readonly skus: readonly string[]) {
    super();
  }
}

@Injectable()
@QueryHandler(GetProductQuery)
export class GetProductHandler implements IQueryHandler<GetProductQuery, ProductView> {
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepositoryPort,
  ) {}

  async execute(query: GetProductQuery): Promise<ProductView> {
    const product = await this.products.findById(query.id);
    if (!product) {
      throw new ResourceNotFoundException('product not found', { productId: query.id });
    }
    return toProductView(product);
  }
}

@Injectable()
@QueryHandler(ListByCategoryQuery)
export class ListByCategoryHandler
  implements IQueryHandler<ListByCategoryQuery, ProductListPage>
{
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepositoryPort,
  ) {}

  async execute(query: ListByCategoryQuery): Promise<ProductListPage> {
    const page = Math.trunc(query.page);
    const requested = Math.trunc(query.pageSize);

    if (!Number.isFinite(page) || page < 1) {
      throw new ValidationException('page must be a positive integer', { page: query.page });
    }
    if (!Number.isFinite(requested) || requested < 1) {
      throw new ValidationException('pageSize must be a positive integer', {
        pageSize: query.pageSize,
      });
    }
    const pageSize = Math.min(requested, MAX_PAGE_SIZE);

    // Trimmed here so `["shoes", " running"]` and `["shoes", "running"]` are the same query;
    // the segments are compared against stored paths element by element below.
    const prefix = query.categoryPath.map((segment) => segment.trim());

    // `findManyByCategory` narrows with `hasEvery` (index-assisted, order-blind). The
    // ordered-prefix rule is applied here, in JavaScript, because Postgres array containment
    // cannot express "these segments, in this order, starting at the root": without this
    // pass, `["running", "shoes"]` would match a product filed under `shoes → running`.
    const candidates = await this.products.findManyByCategory(prefix);
    const matches = candidates
      .filter((product) => isCategoryPrefix(product, prefix))
      // Newest first, so a re-listing after a seed or an import shows what just arrived.
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());

    const start = (page - 1) * pageSize;

    return {
      products: matches.slice(start, start + pageSize).map(toProductView),
      total: matches.length,
      page,
      pageSize,
    };
  }
}

@Injectable()
@QueryHandler(GetPricingQuery)
export class GetPricingHandler
  implements IQueryHandler<GetPricingQuery, PricedSkuView[]>
{
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepositoryPort,
  ) {}

  async execute(query: GetPricingQuery): Promise<PricedSkuView[]> {
    // Empty strings are not skus; dropping them keeps a caller that filtered badly from
    // asking the database for a value no row can hold.
    const requested = [...new Set(query.skus.map((sku) => sku.trim()).filter((sku) => sku.length > 0))];
    if (requested.length === 0) return [];

    const found = await this.products.findManyBySkus(requested);
    const wanted = new Set(requested);

    const bySku = new Map<string, PricedSkuView>();
    for (const product of found) {
      for (const variant of product.variants) {
        if (!wanted.has(variant.sku)) continue;
        bySku.set(variant.sku, {
          sku: variant.sku,
          productId: product.id,
          priceMinor: variant.priceMinor,
          currency: product.currency,
          // A withdrawn product or a withdrawn variant is both "not for sale"; the price is
          // still answered so a cart holding the line can show what it would have cost.
          active: product.isActive && variant.active,
        });
      }
    }

    // Answered in the caller's order, and a sku nobody holds is simply absent: a bulk
    // lookup reports what exists rather than padding the response with zeroes, which a
    // caller would read as "free".
    return requested.flatMap((sku) => {
      const match = bySku.get(sku);
      return match ? [match] : [];
    });
  }
}

/**
 * Whether a product's category path starts with `prefix`.
 *
 * @remarks Segment-wise, not string-wise: a string prefix check would let `["shoes"]` match
 * `["shoesales"]`, and an empty prefix matches everything — which is what makes "list the
 * whole catalogue" a category query with no path rather than a second endpoint.
 */
function isCategoryPrefix(product: Product, prefix: readonly string[]): boolean {
  if (prefix.length === 0) return true;
  if (product.categoryPath.length < prefix.length) return false;
  return prefix.every((segment, index) => product.categoryPath[index] === segment);
}
