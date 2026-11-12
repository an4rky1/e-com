/**
 * @fileoverview The cancel saga: refund → release → mark canceled, in that order.
 *
 * @remarks Money is unwound before stock because a refund is the harder conversation to
 * reverse; stock release is idempotent and can be retried by an operator, while a missing
 * refund is a customer-facing discrepancy.
 *
 * @remarks A `pending_payment` order whose charge returned `requires_action` is *not*
 * refunded — no money settled. Getting that wrong would invent a refund against a payment
 * the PSP never captured.
 */
import 'reflect-metadata';
import { Order, OrderStatus } from '../src/domain/order.aggregate';
import { runCancel } from '../src/application/saga/cancel.saga';
import {
  FakeBillingPeer,
  FakeInventoryPeer,
  InMemoryOrderRepository,
  PAYMENT_ID,
  WAREHOUSE,
  testOrderConfig,
} from './support/fakes';
import { USER_ID } from './support/fakes';

const T0 = new Date('2026-01-01T00:00:00.000Z');

function draftOrder(): Order {
  return Order.create({
    userId: USER_ID,
    sessionId: 'session-1',
    currency: 'USD',
    lines: [
      { sku: 'SKU-1', productId: 'p', name: 'Widget', quantity: 2, unitPriceMinor: 500 },
    ],
    now: T0,
  });
}

function pendingOrder(paymentId: string | null = null): Order {
  const order = draftOrder();
  order.clearDomainEvents();
  order.markPendingPayment(T0);
  if (paymentId) order.attachPaymentId(paymentId, T0);
  order.clearDomainEvents();
  return order;
}

function paidOrder(): Order {
  const order = pendingOrder();
  order.markPaid(PAYMENT_ID, T0);
  order.clearDomainEvents();
  return order;
}

describe('cancel saga — draft', () => {
  it('cancels without touching inventory or billing', async () => {
    const inventory = new FakeInventoryPeer();
    const billing = new FakeBillingPeer();
    const repository = new InMemoryOrderRepository();
    const order = draftOrder();

    const canceled = await runCancel(
      { inventory, billing, repository },
      order,
      'changed_mind',
      testOrderConfig.defaultWarehouse,
    );

    expect(canceled.status).toBe(OrderStatus.CANCELED);
    expect(canceled.cancelReason).toBe('changed_mind');
    expect(inventory.calls).toHaveLength(0);
    expect(billing.refunds).toHaveLength(0);
    expect(repository.outbox.map((e) => e.eventType)).toContain('order.canceled');
  });
});

describe('cancel saga — pending_payment with 3DS', () => {
  it('releases stock but does not refund money that never settled', async () => {
    const inventory = new FakeInventoryPeer();
    const billing = new FakeBillingPeer();
    const repository = new InMemoryOrderRepository();
    const order = pendingOrder('psp_ch_1');

    const canceled = await runCancel(
      { inventory, billing, repository },
      order,
      'abandoned_3ds',
      WAREHOUSE,
    );

    expect(canceled.status).toBe(OrderStatus.CANCELED);
    expect(inventory.releaseCount).toBe(1);
    expect(billing.refunds).toHaveLength(0);
  });
});

describe('cancel saga — paid', () => {
  it('refunds first, then releases stock, then cancels', async () => {
    const inventory = new FakeInventoryPeer();
    const billing = new FakeBillingPeer();
    const repository = new InMemoryOrderRepository();
    const order = paidOrder();

    const canceled = await runCancel(
      { inventory, billing, repository },
      order,
      'customer_request',
      WAREHOUSE,
    );

    expect(canceled.status).toBe(OrderStatus.CANCELED);
    expect(billing.refunds).toHaveLength(1);
    expect(billing.refunds[0].paymentId).toBe(PAYMENT_ID);
    // Business-derived key so a retried cancel cannot double-refund.
    expect(billing.refunds[0].idempotencyKey).toBe(
      `order:${order.id}:cancel-refund:1`,
    );
    expect(inventory.releaseCount).toBe(1);
    expect(repository.outbox.map((e) => e.eventType)).toContain('order.canceled');
  });

  it('keeps the payment id on the canceled row for reconciliation', async () => {
    const repository = new InMemoryOrderRepository();
    const order = paidOrder();

    const canceled = await runCancel(
      {
        inventory: new FakeInventoryPeer(),
        billing: new FakeBillingPeer(),
        repository,
      },
      order,
      'customer_request',
      WAREHOUSE,
    );

    expect(canceled.paymentId).toBe(PAYMENT_ID);
    const stored = await repository.findById(order.id);
    expect(stored?.paymentId).toBe(PAYMENT_ID);
    expect(stored?.status).toBe(OrderStatus.CANCELED);
  });
});

describe('cancel saga — already canceled', () => {
  it('is a no-op: no second refund, no second release, no second event', async () => {
    const inventory = new FakeInventoryPeer();
    const billing = new FakeBillingPeer();
    const repository = new InMemoryOrderRepository();
    const order = paidOrder();
    order.cancel('first', T0);
    order.clearDomainEvents();

    const result = await runCancel(
      { inventory, billing, repository },
      order,
      'second',
      WAREHOUSE,
    );

    expect(result.status).toBe(OrderStatus.CANCELED);
    expect(result.cancelReason).toBe('first');
    expect(inventory.releaseCount).toBe(0);
    expect(billing.refunds).toHaveLength(0);
    expect(repository.outbox).toHaveLength(0);
  });
});
