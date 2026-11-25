import type { Product } from '../product.aggregate';

/** The indexing side: keep the search engine's copy of a product in step with the product. */
export const PRODUCT_SEARCH_INDEXER = Symbol('ProductSearchIndexer');

export interface ProductSearchIndexer {
  /** Creates the document, or replaces the previous version of it — both are "this product is now". */
  index(product: Product): Promise<void>;
  /** Drops the document — the product left the sellable set. Absent docs are fine. */
  remove(product: Product): Promise<void>;
}
