'use client';

import { useState } from 'react';
import Link from 'next/link';
import { StorefrontRoutes } from '@auth/contracts/http';
import type {
  CheckoutCreateRequest,
  CheckoutPreviewResponse,
  OrderView,
} from '@auth/contracts/http';
import { formatMoney } from '../../lib/money';
import { storefrontFetch } from '../../lib/storefront-client';
import styles from '../page.module.scss';

/**
 * Checkout: preview the basket's totals, then place the order.
 *
 * @remarks Preview is composed at the edge (cart lines + billing totals) and still answers
 * 200 when `validation.valid` is false — the refusal is data the page renders, not an HTTP
 * error the form has to special-case. `POST /checkout` is a single CreateOrder; the order
 * service's saga owns reserve → charge → confirm.
 */
export default function CheckoutPage() {
  const [preview, setPreview] = useState<CheckoutPreviewResponse | null>(null);
  const [order, setOrder] = useState<OrderView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [coupon, setCoupon] = useState('');
  const [country, setCountry] = useState('');

  /**
   * Edits either pricing input.
   *
   * @remarks The quote on screen was priced with the inputs as they were; keeping it
   * visible under new ones would offer a "Place order" button charging a price the
   * customer is no longer looking at — billing reconciles against the current inputs.
   */
  const changePricingInput =
    (apply: (value: string) => void) =>
    (value: string): void => {
      apply(value);
      setPreview(null);
    };

  const loadPreview = async () => {
    setBusy(true);
    setMessage(null);
    setOrder(null);
    try {
      const body = {
        ...(country ? { customerCountry: country } : {}),
        ...(coupon ? { couponCode: coupon } : {}),
      };
      const result = await storefrontFetch<CheckoutPreviewResponse>(
        StorefrontRoutes.checkoutPreview,
        { body: JSON.stringify(body) },
      );
      setPreview(result);
    } catch (err) {
      setPreview(null);
      setMessage(err instanceof Error ? err.message : 'The gateway did not answer');
    } finally {
      setBusy(false);
    }
  };

  const placeOrder = async () => {
    setBusy(true);
    setMessage(null);
    try {
      // The same jurisdiction and coupon the preview was priced with: billing
      // reconciles the charge against them, and a mismatch is a refused charge.
      const body: CheckoutCreateRequest = {
        ...(country ? { customerCountry: country } : {}),
        ...(coupon ? { couponCode: coupon } : {}),
      };
      const created = await storefrontFetch<OrderView>(StorefrontRoutes.checkoutCreate, {
        body: JSON.stringify(body),
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      });
      setOrder(created);
      setPreview(null);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Checkout failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={`${styles.page} ${styles.wide}`}>
      <h1>Checkout</h1>
      <nav className={styles.nav}>
        <Link href="/shop">Catalog</Link>
        <Link href="/cart">Cart</Link>
        <Link href="/orders">Orders</Link>
      </nav>

      <section className={styles.card}>
        <div className={styles.row}>
          <label htmlFor="country">Country</label>
          <input
            id="country"
            value={country}
            maxLength={2}
            placeholder="US"
            onChange={(event) => changePricingInput(setCountry)(event.target.value)}
            style={{ width: '4rem' }}
          />
          <label htmlFor="coupon">Coupon</label>
          <input
            id="coupon"
            value={coupon}
            maxLength={32}
            onChange={(event) => changePricingInput(setCoupon)(event.target.value)}
          />
          <button type="button" onClick={() => void loadPreview()} disabled={busy}>
            {busy && !order ? 'Previewing…' : 'Preview totals'}
          </button>
        </div>

        {message ? (
          <p className={styles.error} role="alert">
            {message}
          </p>
        ) : null}

        {preview ? (
          <div data-testid="checkout-preview">
            <h2>Preview</h2>
            <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '0.35rem' }}>
              {preview.lines.lines.map((line) => (
                <li key={line.sku} className={styles.row}>
                  <span>
                    {line.quantity} × {line.name}
                  </span>
                  <code>{line.sku}</code>
                  <span>{formatMoney(line.unitPrice)}</span>
                </li>
              ))}
            </ul>
            <p>
              Subtotal {formatMoney(preview.lines.subtotal)} · Tax{' '}
              {formatMoney(preview.invoice.taxTotal)}
              {/* An older gateway knows no delivery charge and omits the field; a
                  Shipping row for money that was never priced would be a lie. */}
              {preview.invoice.shipping ? (
                <> · Shipping {formatMoney(preview.invoice.shipping)}</>
              ) : null}{' '}
              · Discount {formatMoney(preview.invoice.discount)} · Total{' '}
              <strong>{formatMoney(preview.invoice.total)}</strong>
            </p>
            <p className={preview.validation.valid ? styles.muted : styles.error}>
              {preview.validation.valid
                ? 'Every line is still buyable.'
                : `Not buyable: ${preview.validation.unavailableSkus.join(', ') || 'see price changes'}`}
            </p>
            {!preview.validation.valid && preview.validation.priceChanges.length > 0 ? (
              <ul className={styles.muted}>
                {preview.validation.priceChanges.map((change) => (
                  <li key={change.sku}>
                    {change.sku}: {formatMoney(change.oldPrice)} → {formatMoney(change.newPrice)}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className={styles.row}>
              <button
                type="button"
                onClick={() => void placeOrder()}
                disabled={busy || !preview.validation.valid}
              >
                Place order
              </button>
            </div>
          </div>
        ) : null}

        {order ? (
          <div data-testid="order-created">
            <h2>Order placed</h2>
            <p>
              <strong>{order.id}</strong> · {order.status}
            </p>
            <p>
              Total {formatMoney(order.total)} ({order.currency})
            </p>
            <div className={styles.row}>
              <Link href="/orders">View orders</Link>
              <Link href="/shop">Keep shopping</Link>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}
