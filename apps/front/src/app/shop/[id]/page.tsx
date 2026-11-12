'use client';

import { useCallback, useEffect, useState, use } from 'react';
import Link from 'next/link';
import { QUANTITY_MAX, StorefrontRoutes } from '@auth/contracts/http';
import type { AddCartItemRequest, CartView, CatalogProduct } from '@auth/contracts/http';
import { formatMoney } from '../../../lib/money';
import { storefrontFetch } from '../../../lib/storefront-client';
import { authHeaders } from '../../../lib/session';
import styles from '../../page.module.scss';

/**
 * One product, and the only place a quantity is chosen.
 *
 * @remarks Add-to-cart is authenticated: cart identity is the JWT, so a guest who presses
 * the button is told to sign in rather than given a basket that evaporates. The catalog
 * read itself stays public — browsing does not require an account.
 */
export default function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [product, setProduct] = useState<CatalogProduct | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [quantity, setQuantity] = useState(1);
  const [message, setMessage] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProduct(
        await storefrontFetch<CatalogProduct>({
          ...StorefrontRoutes.catalogProduct,
          path: StorefrontRoutes.catalogProduct.path.replace(':id', id),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the product');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const addToCart = async () => {
    if (!authHeaders()) {
      setMessage('Sign in to add items to your cart');
      return;
    }
    const sku =
      product?.variants.find((variant) => variant.active)?.sku ?? product?.variants[0]?.sku;
    if (!sku) {
      setMessage('This product has no SKU to add');
      return;
    }

    setBusy(true);
    setMessage(null);
    setInfo(null);
    try {
      const body: AddCartItemRequest = { sku, quantity };
      const cart = await storefrontFetch<CartView>(StorefrontRoutes.cartAddItem, {
        body: JSON.stringify(body),
      });
      setInfo(`Cart now has ${cart.itemCount} item(s)`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not update the cart');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={`${styles.page} ${styles.wide}`}>
      <p>
        <Link href="/shop">← Catalog</Link>
      </p>
      <h1>{product?.name ?? 'Product'}</h1>

      {loading ? <p className={styles.muted}>Loading…</p> : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      {product ? (
        <section className={styles.card}>
          <p>{product.description}</p>
          <p className={styles.muted}>
            {product.categoryPath.join(' / ') || 'uncategorised'} · v{product.version}
          </p>

          <h2>Variants</h2>
          <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '0.5rem' }}>
            {product.variants.map((variant) => (
              <li key={variant.sku} className={styles.row}>
                <code>{variant.sku}</code>
                <span>{formatMoney(variant.price)}</span>
                <span className={styles.muted}>{variant.active ? 'available' : 'inactive'}</span>
              </li>
            ))}
            {product.variants.length === 0 ? (
              <li className={styles.muted}>No variants.</li>
            ) : null}
          </ul>

          <div className={styles.row}>
            <label htmlFor="qty">Qty</label>
            <input
              id="qty"
              type="number"
              min={1}
              max={QUANTITY_MAX}
              value={quantity}
              onChange={(event) => setQuantity(Number(event.target.value))}
              style={{ width: '5rem' }}
            />
            <button type="button" onClick={() => void addToCart()} disabled={busy}>
              {busy ? 'Adding…' : 'Add to cart'}
            </button>
          </div>

          {message ? (
            <p className={styles.error} role="alert">
              {message}
            </p>
          ) : null}
          {info ? (
            <p className={styles.muted} data-testid="cart-info">
              {info} · <Link href="/cart">open cart</Link>
            </p>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
