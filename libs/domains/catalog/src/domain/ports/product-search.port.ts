import type { Product } from '../product.aggregate';

/** The search read port: "which products mention `text`?" — answered in relevance order. */
export const PRODUCT_SEARCH = Symbol('ProductSearch');

/**
 * The search read side of the catalog.
 *
 * @remarks The port speaks products, not engine answers: the engine's ids are the search's
 * storage detail and never reach a caller. Paging comes back in `page`/`pageSize`, so the
 * caller sees a slice of the same page shape every other catalog read returns.
 */
export interface ProductSearchPort {
  searchByText(input: {
    text: string;
    page: number;
    pageSize: number;
  }): Promise<{ products: readonly Product[]; total: number }>;
}
