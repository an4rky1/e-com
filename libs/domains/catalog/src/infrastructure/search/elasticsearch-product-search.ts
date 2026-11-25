/**
 * The ES-backed implementation of {@link ProductSearchPort}.
 *
 * @remarks The engine is authoritative for *which* products match; this class is the
 * translation from "ids in ES order" to the domain's "products in page order", because
 * the caller of a search wants the documents, not the engine's storage identity.
 *
 * @remarks The N+1 of loading the matches through the repository is deliberate and
 * bounded: a page of `pageSize` (capped by the same bound every other catalog read uses)
 * ids is looked up one call at a time, because what is being bought is "the products that
 * match", and a product that disappeared between the match and the read is simply not
 * there — the read path never fabricates it.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ElasticsearchService } from '@auth/infra/elasticsearch';
import {
  PRODUCT_REPOSITORY,
  type ProductRepositoryPort,
} from '../../domain/ports/product-repository.port';
import { PRODUCT_SEARCH, type ProductSearchPort } from '../../domain/ports/product-search.port';
import type { Product } from '../../domain/product.aggregate';

@Injectable()
export class ElasticsearchProductSearch implements ProductSearchPort {
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepositoryPort,
    // The service, not the raw client: `ElasticsearchService` is the search-facing
    // wrapper the rest of this class reasons about, and the module exports it as a class.
    @Inject(ElasticsearchService) private readonly elasticsearch: ElasticsearchService,
  ) {}

  async searchByText(input: {
    text: string;
    page: number;
    pageSize: number;
  }): Promise<{ products: readonly Product[]; total: number }> {
    const result = await this.elasticsearch.search({
      index: this.elasticsearch.index,
      query: {
        // `most_fields` over the two indexed text fields: name is the headline, description
        // the body, and relevance should consider both rather than name-then-description.
        multi_match: { query: input.text, fields: ['name', 'description'], type: 'most_fields' },
      },
      from: (input.page - 1) * input.pageSize,
      size: input.pageSize,
    });

    const products: Product[] = [];
    for (const hit of result.hits) {
      const product = await this.products.findById(hit.id);
      if (product !== null) products.push(product);
    }

    return { products, total: result.total };
  }
}
