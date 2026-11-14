/**
 * @fileoverview The checkout saga: forward steps and their compensations.
 *
 * @remarks The point of a saga is the *order* of undo. These tests script each peer so a
 * failure at a known step can assert exactly which compensations ran and in which order —
 * a checkout that refunds without releasing, or releases without canceling, leaves money
 * or stock unaccounted for.
 *
 * @remarks `requires_action` is treated as success: stock stays held, the order stays
 * `pending_payment`, and no compensation runs. Getting that wrong would release stock the
 * 3DS flow is still counting on.
 */
import 'reflect-metadata';
import { ValidationException } from '@auth/platform/error-handling';
import { OrderStatus } from '../src/domain/order.aggregate';
import {
  ChargeFailedError,
  StockRejectedError,
  runCheckout,
  type CheckoutContext,
} from '../src/application/saga/checkout.saga';
import {
  FakeBillingPeer,
  FakeCartPeer,
  FakeInventoryPeer,
  IDEMPOTENCY_KEY,
  InMemoryOrderRepository,
  SESSION_ID,
  USER_ID,
  testOrderConfig,
} from './support/fakes';
import { thrownCause } from './support/helpers';

function context(overrides: Partial<CheckoutContext> = {}): CheckoutContext {
  return {
    userId: USER_ID,
    sessionId: SESSION_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    currency: 'USD',
    paymentMethodToken: 'pm_card_visa',
    warehouseId: testOrderConfig.defaultWarehouse,
    requestFingerprint: '["user-1","session-1","USD","",""]',
    customerCountry: '',
    couponCode: '',
    ...overrides,
  };
}

describe('checkout saga — success path', () => {
  it('validates, snapshots, reserves, charges and leaves the order paid', async () => {
    const cart = new FakeCartPeer();
    const inventory = new FakeInventoryPeer();
    const billing = new FakeBillingPeer('succeeded');
    const repository = new InMemoryOrderRepository();

    const result = await runCheckout(
      { cart, inventory, billing, repository },
      context(),
    );

    expect(result.order?.status).toBe(OrderStatus.PAID);
    expect(result.order?.paymentId).toBe('pay-1');
    expect(result.reserved).toBe(true);
    expect(result.paymentStatus).toBe('succeeded');

    // Cart is cleared only after money and stock commit.
    expect(cart.calls).toEqual(['validate', 'lines', 'clear']);

    // The order reached storage with its events.
    const stored = await repository.findById(result.order!.id);
    expect(stored?.status).toBe(OrderStatus.PAID);
    expect(repository.outbox.map((e) => e.eventType)).toEqual(
      expect.arrayContaining(['order.created', 'order.paid']),
    );
  });

  it('charges the total billing previewed over the frozen lines', async () => {
    const billing = new FakeBillingPeer('succeeded');
    const repository = new InMemoryOrderRepository();

    const result = await runCheckout(
      {
        cart: new FakeCartPeer(),
        inventory: new FakeInventoryPeer(),
        billing,
        repository,
      },
      context(),
    );

    // Billing priced the charge first, over exactly the lines the charge carries —
    // the parity its reconciliation checks when the request lands.
    expect(billing.previews).toHaveLength(1);
    expect(billing.previews[0]).toMatchObject({ currency: 'USD', customerCountry: '' });
    expect(billing.previews[0].lines).toEqual([
      {
        sku: 'SKU-1',
        quantity: 2,
        unitPrice: { amountMinor: '500', currency: 'USD' },
      },
    ]);

    expect(billing.charges).toHaveLength(1);
    const charge = billing.charges[0];
    // 2 × 500 subtotal + billing's default delivery — the previewed figure, not the
    // 1000 line subtotal the order aggregate holds.
    expect(charge.amount.amountMinor).toBe('1500');
    expect(charge.amount.currency).toBe('USD');
    expect(charge.idempotencyKey).toBe(`order:${result.order!.id}:charge:1`);
    expect(charge.lines).toEqual([
      {
        sku: 'SKU-1',
        quantity: 2,
        unitPrice: { amountMinor: '500', currency: 'USD' },
      },
    ]);
    // One set of lines feeds both calls: preview and charge cannot disagree.
    expect(charge.lines).toEqual(billing.previews[0].lines);
  });

  it('prices and charges under the same jurisdiction and coupon the context carries', async () => {
    const billing = new FakeBillingPeer('succeeded');
    const repository = new InMemoryOrderRepository();

    await runCheckout(
      { cart: new FakeCartPeer(), inventory: new FakeInventoryPeer(), billing, repository },
      context({ customerCountry: 'DE', couponCode: 'SAVE10' }),
    );

    // Billing resolves both inputs on its side; a charge carrying different ones than
    // the preview would reconcile against a different total and be refused.
    expect(billing.previews[0]).toMatchObject({
      customerCountry: 'DE',
      couponCode: 'SAVE10',
    });
    const charge = billing.charges[0];
    expect(charge.customerCountry).toBe('DE');
    expect(charge.couponCode).toBe('SAVE10');
    // Surviving the fake's reconciliation proves the charge amount equals what the
    // preview answered; the literal pins the figure itself.
    expect(charge.amount.amountMinor).toBe('1500');
  });

  it('keeps stock and the order pending when the charge needs 3DS', async () => {
    const cart = new FakeCartPeer();
    const inventory = new FakeInventoryPeer();
    const billing = new FakeBillingPeer('requires_action');
    const repository = new InMemoryOrderRepository();

    const result = await runCheckout(
      { cart, inventory, billing, repository },
      context(),
    );

    expect(result.order?.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(result.order?.paymentId).toMatch(/^psp_ch_/);
    // Not compensated: stock is still held for the authentication flow.
    expect(inventory.releaseCount).toBe(0);
    expect(cart.calls).toContain('clear');
  });
});

describe('checkout saga — invalid cart', () => {
  it('refuses before touching inventory or billing', async () => {
    const cart = new FakeCartPeer({
      valid: false,
      unavailableSkus: ['GONE'],
      priceChanges: [],
    });
    const inventory = new FakeInventoryPeer();
    const billing = new FakeBillingPeer();
    const repository = new InMemoryOrderRepository();

    const error = await thrownCause(() =>
      runCheckout({ cart, inventory, billing, repository }, context()),
    );

    expect(error).toBeInstanceOf(ValidationException);
    expect(inventory.calls).toHaveLength(0);
    expect(billing.charges).toHaveLength(0);
    expect(billing.previews).toHaveLength(0);
    expect(repository.saved).toHaveLength(0);
  });
});

describe('checkout saga — stock rejected', () => {
  it('cancels the draft and never calls billing', async () => {
    const cart = new FakeCartPeer();
    const inventory = new FakeInventoryPeer({ fullyAccepted: false });
    const billing = new FakeBillingPeer();
    const repository = new InMemoryOrderRepository();

    const error = await thrownCause(() =>
      runCheckout({ cart, inventory, billing, repository }, context()),
    );

    expect(error).toBeInstanceOf(StockRejectedError);
    expect(billing.charges).toHaveLength(0);
    expect(billing.previews).toHaveLength(0);

    // The draft was persisted then compensated to canceled.
    expect(repository.saved).toHaveLength(2);
    const stored = await repository.findById(repository.saved[0]);
    expect(stored?.status).toBe(OrderStatus.CANCELED);
    expect(stored?.cancelReason).toBe('checkout_compensated');
  });
});

describe('checkout saga — charge failed', () => {
  it('releases stock and cancels the order', async () => {
    const cart = new FakeCartPeer();
    const inventory = new FakeInventoryPeer();
    const billing = new FakeBillingPeer('failed', 'card_declined');
    const repository = new InMemoryOrderRepository();

    const error = await thrownCause(() =>
      runCheckout({ cart, inventory, billing, repository }, context()),
    );

    expect(error).toBeInstanceOf(ChargeFailedError);
    expect(inventory.releaseCount).toBe(1);

    // Draft → pending (reserve) → canceled (compensate): three saves.
    expect(repository.saved.length).toBeGreaterThanOrEqual(3);
    const stored = await repository.findById(repository.saved[0]);
    expect(stored?.status).toBe(OrderStatus.CANCELED);
    expect(stored?.cancelReason).toBe('checkout_compensated');

    // Cart is NOT cleared on failure — the shopper keeps their basket.
    expect(cart.calls).not.toContain('clear');
  });
});

describe('checkout saga — billing preview refuses', () => {
  it('releases stock and cancels when the preview never answers', async () => {
    const cart = new FakeCartPeer();
    const inventory = new FakeInventoryPeer();
    const billing = new FakeBillingPeer();
    billing.previewFailure = new Error('billing is not there');
    const repository = new InMemoryOrderRepository();

    const error = await thrownCause(() =>
      runCheckout({ cart, inventory, billing, repository }, context()),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('billing is not there');
    // Pricing failed before any money moved: no charge, stock released, draft canceled.
    expect(billing.charges).toHaveLength(0);
    expect(inventory.releaseCount).toBe(1);
    const stored = await repository.findById(repository.saved[0]);
    expect(stored?.status).toBe(OrderStatus.CANCELED);
    expect(cart.calls).not.toContain('clear');
  });

  it('refuses to charge when the preview answers without a total', async () => {
    const cart = new FakeCartPeer();
    const inventory = new FakeInventoryPeer();
    const billing = new FakeBillingPeer();
    billing.previewWithoutTotal = true;
    const repository = new InMemoryOrderRepository();

    const error = await thrownCause(() =>
      runCheckout({ cart, inventory, billing, repository }, context()),
    );

    // The line subtotal is not a fallback: charging it is exactly what billing's own
    // reconciliation would refuse, so the saga stops with the contract broken.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /billing preview returned no total for order/,
    );
    expect(billing.charges).toHaveLength(0);
    expect(inventory.releaseCount).toBe(1);
    const stored = await repository.findById(repository.saved[0]);
    expect(stored?.status).toBe(OrderStatus.CANCELED);
  });
});

describe('checkout saga — empty cart', () => {
  it('refuses with a validation error after validation passed', async () => {
    const cart = new FakeCartPeer(undefined, {
      lines: [],
      subtotal: { amountMinor: '0', currency: 'USD' },
      currency: 'USD',
      version: 0,
    });
    const repository = new InMemoryOrderRepository();

    const error = await thrownCause(() =>
      runCheckout(
        {
          cart,
          inventory: new FakeInventoryPeer(),
          billing: new FakeBillingPeer(),
          repository,
        },
        context(),
      ),
    );

    expect(error).toBeInstanceOf(ValidationException);
    expect(repository.saved).toHaveLength(0);
  });
});
