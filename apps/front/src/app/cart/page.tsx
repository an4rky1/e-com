'use client';

import { useState } from 'react';
import Link from 'next/link';
import { StorefrontRoutes } from '@auth/contracts/http';
import type { CartView, RemoveCartItemRequest, UpdateCartItemRequest } from '@auth/contracts/http';
import { formatMoney } from '../../lib/money';
import { storefrontFetch, useStorefront } from '../../lib/storefront-client';
import styles from '../page.module.scss';

/**
 * The shopper's basket. Mutations are the contract's POST verbs — update, remove, clear.
 *
 * @remarks Identity is the bearer, never a form field: every call goes through
 * `storefrontFetch`, which attaches the session token and refuses when there is none.
 */
export default function CartPage() {
  const { data, error, loading, reload } = useStorefront<CartView>(StorefrontRoutes.cartGet);
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>, done = 'Updated') => {
    setBusy(true);
    setMessage(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'The gateway did not answer');
    } finally {
      setBusy(false);
    }
  };

  const updateQty = (sku: string, quantity: number) =>
    run(async () => {
      const body: UpdateCartItemRequest = { sku, quantity };
      await storefrontFetch(StorefrontRoutes.cartUpdateItem, { body: JSON.stringify(body) });
    });

  const remove = (sku: string) =>
    run(async () => {
      const body: RemoveCartItemRequest = { sku };
      await storefrontFetch(StorefrontRoutes.cartRemoveItem, { body: JSON.stringify(body) });
    }, 'Removed');

  const clear = () => run(() => storefrontFetch(StorefrontRoutes.cartClear), 'Cart cleared');

  return (
    <main className={`${styles.page} ${styles.wide}`}>
      <h1>Cart</h1>
      <nav className={styles.nav}>
        <Link href="/shop">Catalog</Link>
        <Link href="/checkout">Checkout</Link>
        <Link href="/orders">Orders</Link>
      </nav>

      {loading ? <p className={styles.muted}>Loading…</p> : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className={styles.error} role="alert">
          {message}
        </p>
      ) : null}
      {notice ? (
        <p className={styles.muted} data-testid="cart-notice">
          {notice}
        </p>
      ) : null}

      {data ? (
        <section className={styles.card}>
          <div className={styles.row}>
            <strong>
              {data.itemCount} item{data.itemCount === 1 ? '' : 's'}
            </strong>
            <span>Subtotal {formatMoney(data.subtotal)}</span>
            <span>Total {formatMoney(data.total)}</span>
            <span className={styles.muted}>v{data.version}</span>
          </div>

          <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '0.75rem' }}>
            {data.items.map((item) => (
              <li key={item.sku} className={styles.row}>
                <div style={{ flex: 1 }}>
                  <strong>{item.name}</strong>
                  <div className={styles.muted}>
                    <code>{item.sku}</code> · {formatMoney(item.unitPrice)} each
                  </div>
                  {item.priceChanged ? (
                    <div className={styles.error}>Price changed since you added this</div>
                  ) : null}
                </div>
                <label htmlFor={`qty-${item.sku}`}>Qty</label>
                <input
                  id={`qty-${item.sku}`}
                  type="number"
                  min={1}
                  max={999}
                  value={item.quantity}
                  disabled={busy}
                  onChange={(event) => void updateQty(item.sku, Number(event.target.value))}
                  style={{ width: '4.5rem' }}
                />
                <span>{formatMoney(item.totalPrice)}</span>
                <button type="button" onClick={() => void remove(item.sku)} disabled={busy}>
                  Remove
                </button>
              </li>
            ))}
            {data.items.length === 0 ? (
              <li className={styles.muted}>Your cart is empty.</li>
            ) : null}
          </ul>

          <div className={styles.row}>
            <button
              type="button"
              onClick={() => void clear()}
              disabled={busy || data.items.length === 0}
            >
              Clear cart
            </button>
            <Link href="/checkout">Go to checkout →</Link>
          </div>
        </section>
      ) : null}
    </main>
  );
}
