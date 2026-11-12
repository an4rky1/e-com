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
    requestFingerprint: 'user-1|session-1|USD',
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

  it('charges the frozen line totals, not a figure the caller named', async () => {
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

    expect(billing.charges).toHaveLength(1);
    const charge = billing.charges[0];
    expect(charge.amount.amountMinor).toBe('1000');
    expect(charge.amount.currency).toBe('USD');
    expect(charge.idempotencyKey).toBe(`order:${result.order!.id}:charge:1`);
    expect(charge.lines).toEqual([
      {
        sku: 'SKU-1',
        quantity: 2,
        unitPrice: { amountMinor: '500', currency: 'USD' },
      },
    ]);
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
