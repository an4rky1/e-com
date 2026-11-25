'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { QUANTITY_MAX, QUANTITY_MIN, StorefrontRoutes } from '@auth/contracts/http';
import type { CartView, RemoveCartItemRequest, UpdateCartItemRequest } from '@auth/contracts/http';
import { GATEWAY_UNAVAILABLE_MESSAGE } from '../../lib/api-constants';
import { formatMoney } from '../../lib/money';
import { storefrontFetch, useStorefront } from '../../lib/storefront-client';
import { GRID_LIST_STYLE, pluralSuffix } from '../../lib/ui';
import styles from '../page.module.scss';

const QUANTITY_INPUT_WIDTH = '4.5rem';

/**
 * A quantity editor that commits when the shopper is done, not on every keystroke.
 *
 * @remarks Sending an update per character both spams the cart and disables the input
 * mid-number, so "12" is hard to type at all. The draft is local until blur or Enter; an
 * invalid or unchanged value falls back to the quantity the server currently has.
 */
function QuantityInput({
  sku,
  quantity,
  disabled,
  onCommit,
}: {
  sku: string;
  quantity: number;
  disabled: boolean;
  onCommit: (quantity: number) => void;
}) {
  const [draft, setDraft] = useState(String(quantity));

  useEffect(() => {
    setDraft(String(quantity));
  }, [quantity]);

  const commit = () => {
    const next = Number(draft);
    if (
      Number.isSafeInteger(next) &&
      next >= QUANTITY_MIN &&
      next <= QUANTITY_MAX &&
      next !== quantity
    ) {
      onCommit(next);
      return;
    }
    setDraft(String(quantity));
  };

  return (
    <input
      id={`qty-${sku}`}
      type="number"
      min={QUANTITY_MIN}
      max={QUANTITY_MAX}
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      style={{ width: QUANTITY_INPUT_WIDTH }}
    />
  );
}

/**
 * The shopper's basket. Mutations are the contract's POST verbs — update, remove, clear.
 *
 * @remarks Identity is the bearer or this tab's guest id, never a form field: every call
 * goes through `storefrontFetch`, which attaches the session token when there is one and
 * the `X-Guest-Id` when there is not. Signing in later folds the basket into the account.
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
      setMessage(err instanceof Error ? err.message : GATEWAY_UNAVAILABLE_MESSAGE);
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
              {data.itemCount} item{pluralSuffix(data.itemCount)}
            </strong>
            <span>Subtotal {formatMoney(data.subtotal)}</span>
            <span>Total {formatMoney(data.total)}</span>
            <span className={styles.muted}>v{data.version}</span>
          </div>

          <ul style={GRID_LIST_STYLE}>
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
                <QuantityInput
                  sku={item.sku}
                  quantity={item.quantity}
                  disabled={busy}
                  onCommit={(quantity) => void updateQty(item.sku, quantity)}
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
