import { Inject, Injectable } from '@nestjs/common';
import { ElasticsearchService } from '@auth/infra/elasticsearch';
import type { ElasticsearchDocument } from '@auth/infra/elasticsearch';
import type { Product } from '../../domain/product.aggregate';
import { PRODUCT_SEARCH_INDEXER, type ProductSearchIndexer } from '../../domain/ports/product-search-indexer.port';

/**
 * Keeps the search engine's copy of a product in step with the product.
 *
 * @remarks The write path treats the engine as an indexer it waits for, not a part of the
 * transaction it waits with: a product is a thing of its own and search is a projection of
 * it, so the projection being briefly stale (or absent, on first indexing) is the normal
 * state of the world, not a failure to roll back for.
 */
@Injectable()
export class ElasticsearchProductIndexer implements ProductSearchIndexer {
  constructor(@Inject(ElasticsearchService) private readonly elasticsearch: ElasticsearchService) {}

  async index(product: Product): Promise<void> {
    const document: ElasticsearchDocument = {
      id: product.id,
      name: product.name,
      description: product.description,
      categoryPath: [...product.categoryPath],
      active: product.isActive,
    };
    await this.elasticsearch.indexDocument({ doc: document });
  }

  async remove(product: Product): Promise<void> {
    await this.elasticsearch.deleteDocument({ id: product.id });
  }
}
