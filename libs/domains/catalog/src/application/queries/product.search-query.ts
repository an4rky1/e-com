/**
 * The search read of the catalog: products whose name or description mentions a text.
 *
 * @remarks Its own file rather than a branch inside {@link ListByCategoryHandler}: search
 * and listing are two different questions to the engine — one by text, one by category —
 * and mixing their validation and paging into one handler would make both harder to
 * read for one extra query class.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Query, QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { ValidationException } from '@auth/platform/error-handling';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@auth/contracts/http/api';
import { PRODUCT_SEARCH, type ProductSearchPort } from '../../domain/ports/product-search.port';
import { toProductView } from '../commands/product.command';
import type { ProductListPage } from './product.queries';

export class SearchProductsQuery extends Query<ProductListPage> {
  readonly queryId: string = globalThis.crypto.randomUUID();

  constructor(readonly text: string, readonly page = 1, readonly pageSize = DEFAULT_PAGE_SIZE) {
    super();
  }
}

@Injectable()
@QueryHandler(SearchProductsQuery)
export class SearchProductsHandler implements IQueryHandler<SearchProductsQuery, ProductListPage> {
  constructor(@Inject(PRODUCT_SEARCH) private readonly search: ProductSearchPort) {}

  async execute(query: SearchProductsQuery): Promise<ProductListPage> {
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

    // Trimmed like the category prefix, so `" shoe "` and `"shoe"` are the same query, and
    // an empty string is never a query — it would match everything, which is what "list
    // the catalogue" is for with a category, not with a search box.
    const text = query.text.trim();
    if (text.length === 0) {
      throw new ValidationException('a search needs a non-empty text', { text: '' });
    }

    const { products, total } = await this.search.searchByText({ text, page, pageSize });

    return {
      products: products.map(toProductView),
      total,
      page,
      pageSize,
    };
  }
}
