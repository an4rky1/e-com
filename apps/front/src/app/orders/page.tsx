'use client';

import { useState } from 'react';
import Link from 'next/link';
import { StorefrontRoutes } from '@auth/contracts/http';
import type { ListUserOrdersResponse, OrderView } from '@auth/contracts/http';
import { formatMoney } from '../../lib/money';
import { storefrontFetch, useStorefront } from '../../lib/storefront-client';
import { GRID_LIST_STYLE, pluralSuffix } from '../../lib/ui';
import styles from '../page.module.scss';

/**
 * A shopper's orders, newest page first. Cancel is the only mutation the contract has.
 *
 * @remarks Ownership is the bearer: `/orders/:id` answers only for the caller the token
 * names, so this list never carries a userId field to spoof.
 */
export default function OrdersPage() {
  const { data, error, loading, reload } = useStorefront<ListUserOrdersResponse>(
    StorefrontRoutes.orderList,
  );
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const cancel = async (orderId: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await storefrontFetch(
        {
          ...StorefrontRoutes.orderCancel,
          path: StorefrontRoutes.orderCancel.path.replace(':id', orderId),
        },
        { body: JSON.stringify({ reason: 'cancelled from orders page' }) },
      );
      reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not cancel the order');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={`${styles.page} ${styles.wide}`}>
      <h1>Orders</h1>
      <nav className={styles.nav}>
        <Link href="/shop">Catalog</Link>
        <Link href="/cart">Cart</Link>
        <Link href="/checkout">Checkout</Link>
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

      {data ? (
        <section>
          <h2>
            {data.total} order{pluralSuffix(data.total)}
          </h2>
          <ul style={GRID_LIST_STYLE}>
            {data.orders.map((order) => (
              <li key={order.id} className={styles.card}>
                <OrderRow order={order} busy={busy} onCancel={() => void cancel(order.id)} />
              </li>
            ))}
            {data.orders.length === 0 ? (
              <li className={styles.muted}>
                No orders yet — <Link href="/shop">browse the catalog</Link>.
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}
    </main>
  );
}

function OrderRow({
  order,
  busy,
  onCancel,
}: {
  order: OrderView;
  busy: boolean;
  onCancel: () => void;
}) {
  return (
    <>
      <div className={styles.row}>
        <strong>{order.id}</strong>
        <span>{order.status}</span>
        <span>{formatMoney(order.total)}</span>
        <span className={styles.muted}>{new Date(order.createdAt).toLocaleString()}</span>
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: '0.5rem 0 0' }}>
        {order.lines.map((line) => (
          <li key={line.sku} className={styles.muted}>
            {line.quantity} × {line.name} ({line.sku}) — {formatMoney(line.totalPrice)}
          </li>
        ))}
      </ul>
      {order.status === 'pending' || order.status === 'confirmed' ? (
        <div className={styles.row}>
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      ) : null}
    </>
  );
}
