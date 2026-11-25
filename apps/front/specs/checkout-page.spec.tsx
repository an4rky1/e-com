/**
 * @fileoverview The checkout page's one money invariant: what is quoted is what is charged.
 *
 * @remarks The preview is priced by billing from the jurisdiction and coupon on screen;
 * the create call must carry exactly those inputs, or the charge reconciles against a
 * different figure than the customer agreed to. The second half of that invariant is the
 * page's own: editing either pricing input retires the quote, because a live "Place
 * order" under stale totals is a displayed price that changes under the customer.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import CheckoutPage from '../src/app/checkout/page';

const EXPIRES_IN_SEC = 900;

const originalFetch = global.fetch;

const reply = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const money = (amountMinor: string, currency = 'EUR') => ({ amountMinor, currency });

const previewBody = {
  lines: {
    lines: [
      {
        sku: 'SKU-1',
        productId: 'p-1',
        name: 'Widget',
        quantity: 2,
        unitPrice: money('1000'),
      },
    ],
    subtotal: money('2000'),
    currency: 'EUR',
    version: 1,
  },
  validation: { valid: true, unavailableSkus: [], priceChanges: [] },
  invoice: {
    invoiceId: '',
    orderId: '',
    status: 'draft',
    lines: [],
    subtotal: money('2000'),
    discount: money('0'),
    taxTotal: money('380'),
    shipping: money('499'),
    total: money('2879'),
    currency: 'EUR',
    couponCode: 'SAVE10',
    issuedAt: '',
  },
};

const orderBody = {
  id: '3c2b1a00-0000-4000-8000-000000000001',
  userId: 'user-1',
  status: 'paid',
  lines: [],
  subtotal: money('2000'),
  total: money('2879'),
  currency: 'EUR',
  paymentId: 'psp_ch_1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1,
  cancelReason: '',
};

/** Every call the page made, as `[url, init]` — the proxy-prefixed path and its body. */
const callsOf = (fetchMock: jest.Mock): [string, { body?: string }][] =>
  fetchMock.mock.calls.map(([url, init]: [string, { body?: string }]) => [String(url), init]);

beforeEach(() => {
  sessionStorage.setItem(
    'auth.session',
    JSON.stringify({
      accessToken: 'token',
      refreshToken: '',
      sessionId: 's',
      expiresIn: EXPIRES_IN_SEC,
    }),
  );
});

afterEach(() => {
  global.fetch = originalFetch;
  sessionStorage.clear();
});

const renderQuotedCheckout = async (fetchMock: jest.Mock) => {
  render(<CheckoutPage />);

  fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'DE' } });
  fireEvent.change(screen.getByLabelText('Coupon'), { target: { value: 'SAVE10' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview totals' }));
  await screen.findByTestId('checkout-preview');
  return fetchMock;
};

describe('CheckoutPage', () => {
  it('places the order with the exact inputs the quote was priced with', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(reply(200, previewBody))
      .mockResolvedValue(reply(200, orderBody));
    global.fetch = fetchMock as unknown as typeof fetch;

    await renderQuotedCheckout(fetchMock);
    fireEvent.click(screen.getByRole('button', { name: 'Place order' }));
    await screen.findByTestId('order-created');

    const [[previewUrl, previewInit], [createUrl, createInit]] = callsOf(fetchMock);
    expect(previewUrl).toContain('/checkout/preview');
    expect(JSON.parse(previewInit.body as string)).toEqual({
      customerCountry: 'DE',
      couponCode: 'SAVE10',
    });
    expect(createUrl).toContain('/checkout');
    // Identical body: billing reconciles the charge against these very inputs.
    expect(JSON.parse(createInit.body as string)).toEqual(
      JSON.parse(previewInit.body as string),
    );
    expect(fetchMock.mock.calls[1][1].headers['Idempotency-Key']).toEqual(expect.any(String));
  });

  it('retires the quote when either pricing input changes', async () => {
    const fetchMock = jest.fn().mockResolvedValue(reply(200, previewBody));
    global.fetch = fetchMock as unknown as typeof fetch;

    await renderQuotedCheckout(fetchMock);

    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'FR' } });
    // The quote dies with its inputs: "Place order" lived inside it, so a stale
    // price can no longer be charged.
    expect(screen.queryByTestId('checkout-preview')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Place order' })).toBeNull();

    // The coupon is priced too — editing it retires a quote the same way.
    fireEvent.click(screen.getByRole('button', { name: 'Preview totals' }));
    await screen.findByTestId('checkout-preview');
    fireEvent.change(screen.getByLabelText('Coupon'), { target: { value: 'OTHER' } });
    expect(screen.queryByTestId('checkout-preview')).toBeNull();
  });

  it('shows the delivery charge the gateway quoted, and hides it when the field is absent', async () => {
    const fetchMock = jest.fn().mockResolvedValue(reply(200, previewBody));
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CheckoutPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Preview totals' }));
    const preview = await screen.findByTestId('checkout-preview');
    expect(preview.textContent).toContain('Shipping €4.99');
    expect(preview.textContent).toContain('Total €28.79');

    // An older gateway knows no delivery charge: the row disappears rather than
    // rendering money that was never priced.
    fetchMock.mockResolvedValue(
      reply(200, {
        ...previewBody,
        invoice: { ...previewBody.invoice, shipping: undefined },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preview totals' }));
    await waitFor(() => {
      const requoted = screen.getByTestId('checkout-preview');
      expect(requoted.textContent).not.toContain('Shipping');
    });
  });
});
