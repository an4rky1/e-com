/**
 * The search use case: what the port answers, and what the use case refuses to send it.
 *
 * @remarks Validation lives here rather than in the engine wrapper because this is where
 * the caller's intent is known: an empty search text or a bogus page is a caller mistake,
 * while "the engine found nothing" is a legitimate answer of `total: 0`.
 */
import { MAX_PAGE_SIZE } from '@auth/contracts/http/api';
import { SearchProductsHandler, SearchProductsQuery } from '../src/application/queries/product.search-query';
import type { ProductSearchPort } from '../src/domain/ports/product-search.port';
import type { Product } from '../src/domain/product.aggregate';
import { makeProduct } from './support/fakes';

describe('SearchProductsHandler', () => {
  const product: Product = makeProduct();

  const harness = (products: readonly Product[], total: number) => {
    const search: ProductSearchPort = {
      searchByText: jest.fn().mockResolvedValue({ products, total }),
    };
    return { search, execute: new SearchProductsHandler(search) };
  };

  it('returns the engine page with the match total and the requested window', async () => {
    const { search, execute } = harness([product], 1);

    const page = await execute.execute(new SearchProductsQuery('trail', 2, 20));

    expect(page.products.map((item) => item.id)).toEqual([product.id]);
    expect(page.total).toBe(1);
    expect(page.page).toBe(2);
    expect(page.pageSize).toBe(20);
    expect(search.searchByText).toHaveBeenCalledWith({ text: 'trail', page: 2, pageSize: 20 });
  });

  it('trims the text so padded and unpadded searches are the same query', async () => {
    const { search, execute } = harness([], 0);

    await execute.execute(new SearchProductsQuery('  trail  ', 1));

    expect(search.searchByText).toHaveBeenCalledWith({ text: 'trail', page: 1, pageSize: 20 });
  });

  it('refuses a blank text rather than running a search that matches everything', async () => {
    const { search, execute } = harness([], 0);

    await expect(execute.execute(new SearchProductsQuery('   '))).rejects.toThrow(
      'a search needs a non-empty text',
    );
    expect(search.searchByText).not.toHaveBeenCalled();
  });

  it('refuses a non-positive page', async () => {
    const { execute } = harness([], 0);

    await expect(execute.execute(new SearchProductsQuery('trail', 0))).rejects.toThrow(
      'page must be a positive integer',
    );
  });

  it('caps the page size at the shared ceiling every catalog read uses', async () => {
    const { search, execute } = harness([], 0);

    await execute.execute(new SearchProductsQuery('trail', 1, 10_000));

    expect(search.searchByText).toHaveBeenCalledWith({
      text: 'trail',
      page: 1,
      pageSize: MAX_PAGE_SIZE,
    });
  });
});
