'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ProductList } from '@auth/contracts/http';
import { GATEWAY_UNAVAILABLE_MESSAGE } from '../../lib/api-constants';
import { formatMoney } from '../../lib/money';
import { GRID_LIST_STYLE, pluralSuffix } from '../../lib/ui';
import styles from '../page.module.scss';

/**
 * The vitrina: every product the catalog will list, reachable before sign-in.
 *
 * @remarks `GET /catalog` is `@Public()` — the shelf has to work for a stranger. Add-to-cart
 * is not on this page: it needs a bearer, and the product page is where a shopper chooses
 * a quantity anyway.
 */
export default function ShopIndex() {
  const [data, setData] = useState<ProductList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState('');

  const load = async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const query = path ? `?categoryPath=${encodeURIComponent(path)}` : '';
      const response = await fetch(`/api/catalog${query}`);
      const body = (await response.json()) as ProductList;
      if (!response.ok) throw new Error('Could not load products');
      setData(body);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : GATEWAY_UNAVAILABLE_MESSAGE);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load('');
    // Mount-only: the first shelf is the root list; filters re-enter through `load`.
  }, []);

  return (
    <main className={`${styles.page} ${styles.wide}`}>
      <h1>Catalog</h1>
      <p className={styles.lede}>
        Public products from <code>catalog</code>, through the gateway.
      </p>

      <nav className={styles.nav}>
        <Link href="/">Home</Link>
        <Link href="/cart">Cart</Link>
        <Link href="/orders">Orders</Link>
        <Link href="/checkout">Checkout</Link>
      </nav>

      <div className={styles.row}>
        <label htmlFor="category">Category path</label>
        <input
          id="category"
          value={category}
          placeholder="shoes,boots"
          onChange={(event) => setCategory(event.target.value)}
        />
        <button type="button" onClick={() => void load(category)} disabled={loading}>
          Filter
        </button>
        <button
          type="button"
          onClick={() => {
            setCategory('');
            void load('');
          }}
          disabled={loading}
        >
          All
        </button>
      </div>

      {loading ? <p className={styles.muted}>Loading…</p> : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      {data ? (
        <section aria-labelledby="products-heading">
          <h2 id="products-heading">
            {data.total} product{pluralSuffix(data.total)}
            {category ? ` in ${category}` : ''}
          </h2>
          <ul style={GRID_LIST_STYLE}>
            {data.products.map((product) => (
              <li key={product.id} className={styles.card}>
                <strong>{product.name}</strong>
                <p className={styles.muted}>{product.description}</p>
                <p className={styles.muted}>
                  {product.categoryPath.join(' / ') || 'uncategorised'}
                </p>
                {product.priceRangeMin ? (
                  <p>From {formatMoney(product.priceRangeMin)}</p>
                ) : null}
                <div className={styles.row}>
                  <Link href={`/shop/${product.id}`}>View</Link>
                </div>
              </li>
            ))}
            {data.products.length === 0 ? (
              <li className={styles.muted}>No products yet — create one via the admin API.</li>
            ) : null}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
