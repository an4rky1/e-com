/**
 * @fileoverview The order aggregate's state machine.
 *
 * @remarks Every transition is exercised against explicit statuses rather than wall-clock
 * time — the rules here are a graph and a set of invariants, and a fixed `now` keeps the
 * assertions about `version` and event payloads free of clock noise.
 *
 * @remarks What these tests guard is the invariant the whole service exists for: money and
 * stock decisions hang off status, so an illegal transition (cancel a shipped order, pay a
 * canceled one) must be refused rather than quietly accepted.
 */
import 'reflect-metadata';
import { InvalidStateTransitionException, ValidationException } from '@auth/platform/error-handling';
import { DomainError } from '@auth/core';
import {
  Order,
  OrderStatus,
  canTransition,
  isCancelable,
  isStockHeld,
  mayBeCharged,
} from '../src/domain/order.aggregate';
import { payloadFor, thrown } from './support/helpers';
import { USER_ID } from './support/fakes';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1_000);

function freshOrder(overrides: Partial<Parameters<typeof Order.create>[0]> = {}): Order {
  return Order.create({
    userId: USER_ID,
    sessionId: 'session-1',
    currency: 'USD',
    lines: [
      {
        sku: 'SKU-1',
        productId: 'prod-1',
        name: 'Widget',
        quantity: 2,
        unitPriceMinor: 500,
      },
    ],
    idempotencyKey: 'key-1',
    requestFingerprint: 'user-1|session-1|USD',
    now: T0,
    ...overrides,
  });
}

/** Walks an order to `paid` with a payment id, clearing events along the way. */
function paidOrder(): Order {
  const order = freshOrder();
  order.clearDomainEvents();
  order.markPendingPayment(at(1));
  order.markPaid('pay-1', at(2));
  order.clearDomainEvents();
  return order;
}

describe('Order.create', () => {
  it('starts as draft with frozen lines and totals computed from them', () => {
    const order = freshOrder();

    expect(order.status).toBe(OrderStatus.DRAFT);
    expect(order.subtotalMinor).toBe(1000);
    expect(order.totalMinor).toBe(1000);
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0].totalPriceMinor).toBe(1000);
    expect(order.version).toBe(1);
    expect(order.paymentId).toBeNull();
  });

  it('emits order.created with the frozen lines in the payload', () => {
    const order = freshOrder();
    const payload = payloadFor(order.domainEvents, 'order.created');

    expect(payload).toBeDefined();
    expect(payload?.orderId).toBe(order.id);
    expect(payload?.status).toBe('draft');
    expect(payload?.totalMinor).toBe(1000);
    expect(Array.isArray(payload?.lines)).toBe(true);
  });

  it('refuses an empty line set', () => {
    const error = thrown(() =>
      Order.create({
        userId: USER_ID,
        currency: 'USD',
        lines: [],
        now: T0,
      }),
    );

    expect(error).toBeInstanceOf(DomainError);
  });

  it('refuses a currency that is not a 3-letter code', () => {
    const error = thrown(() =>
      Order.create({
        userId: USER_ID,
        currency: 'dollars',
        lines: [{ sku: 'S', productId: 'p', name: 'n', quantity: 1, unitPriceMinor: 1 }],
        now: T0,
      }),
    );

    expect(error).toBeInstanceOf(ValidationException);
  });

  it('refuses a non-positive quantity', () => {
    const error = thrown(() =>
      Order.create({
        userId: USER_ID,
        currency: 'USD',
        lines: [{ sku: 'S', productId: 'p', name: 'n', quantity: 0, unitPriceMinor: 1 }],
        now: T0,
      }),
    );

    expect(error).toBeInstanceOf(DomainError);
  });
});

describe('Order transitions', () => {
  it('follows draft → pending_payment → paid → confirmed', () => {
    const order = freshOrder();
    order.clearDomainEvents();

    order.markPendingPayment(at(1));
    expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);

    order.markPaid('pay-1', at(2));
    expect(order.status).toBe(OrderStatus.PAID);
    expect(order.paymentId).toBe('pay-1');

    order.markConfirmed(at(3));
    expect(order.status).toBe(OrderStatus.CONFIRMED);
  });

  it('emits order.paid with the payment id', () => {
    const order = freshOrder();
    order.clearDomainEvents();
    order.markPendingPayment(at(1));
    order.markPaid('pay-1', at(2));

    const payload = payloadFor(order.domainEvents, 'order.paid');
    expect(payload?.paymentId).toBe('pay-1');
    expect(payload?.status).toBe('paid');
  });

  it('refuses markPaid without a payment id', () => {
    const order = freshOrder();
    order.markPendingPayment(at(1));

    expect(thrown(() => order.markPaid('', at(2)))).toBeInstanceOf(DomainError);
  });

  it('refuses an illegal transition with INVALID_STATE_TRANSITION', () => {
    const order = freshOrder();

    // draft cannot jump straight to paid.
    expect(thrown(() => order.markPaid('pay-1', at(1)))).toBeInstanceOf(
      InvalidStateTransitionException,
    );
  });

  it('refuses cancel once the order has shipped', () => {
    const order = paidOrder();
    order.markConfirmed(at(3));
    order.markShipped(at(4));

    expect(thrown(() => order.cancel('too_late', at(5)))).toBeInstanceOf(
      InvalidStateTransitionException,
    );
    expect(order.status).toBe(OrderStatus.SHIPPED);
  });

  it('allows cancel from paid and records the reason', () => {
    const order = paidOrder();
    order.clearDomainEvents();

    order.cancel('customer_changed_mind', at(3));

    expect(order.status).toBe(OrderStatus.CANCELED);
    expect(order.cancelReason).toBe('customer_changed_mind');

    const payload = payloadFor(order.domainEvents, 'order.canceled');
    expect(payload?.reason).toBe('customer_changed_mind');
  });

  it('is idempotent: a second cancel is a no-op that emits nothing', () => {
    const order = paidOrder();
    order.cancel('first', at(3));
    order.clearDomainEvents();

    order.cancel('second', at(4));

    expect(order.cancelReason).toBe('first');
    expect(order.domainEvents).toHaveLength(0);
  });

  it('defaults an empty cancel reason to "canceled"', () => {
    const order = freshOrder();
    order.cancel('   ', at(1));

    expect(order.cancelReason).toBe('canceled');
  });
});

describe('Order status predicates', () => {
  it('marks draft/pending/paid/confirmed as cancelable', () => {
    expect(isCancelable(OrderStatus.DRAFT)).toBe(true);
    expect(isCancelable(OrderStatus.PENDING_PAYMENT)).toBe(true);
    expect(isCancelable(OrderStatus.PAID)).toBe(true);
    expect(isCancelable(OrderStatus.CONFIRMED)).toBe(true);
    expect(isCancelable(OrderStatus.SHIPPED)).toBe(false);
    expect(isCancelable(OrderStatus.CANCELED)).toBe(false);
    expect(isCancelable(OrderStatus.COMPLETED)).toBe(false);
  });

  it('marks stock-held statuses for the cancel saga', () => {
    expect(isStockHeld(OrderStatus.DRAFT)).toBe(false);
    expect(isStockHeld(OrderStatus.PENDING_PAYMENT)).toBe(true);
    expect(isStockHeld(OrderStatus.PAID)).toBe(true);
    expect(isStockHeld(OrderStatus.CONFIRMED)).toBe(true);
    expect(isStockHeld(OrderStatus.SHIPPED)).toBe(false);
    expect(isStockHeld(OrderStatus.CANCELED)).toBe(false);
  });

  it('marks only settled payments as refundable', () => {
    expect(mayBeCharged(OrderStatus.PENDING_PAYMENT)).toBe(false);
    expect(mayBeCharged(OrderStatus.PAID)).toBe(true);
    expect(mayBeCharged(OrderStatus.CONFIRMED)).toBe(true);
    expect(mayBeCharged(OrderStatus.CANCELED)).toBe(false);
  });

  it('has a closed transition graph', () => {
    expect(canTransition(OrderStatus.DRAFT, OrderStatus.PENDING_PAYMENT)).toBe(true);
    expect(canTransition(OrderStatus.DRAFT, OrderStatus.PAID)).toBe(false);
    expect(canTransition(OrderStatus.COMPLETED, OrderStatus.CANCELED)).toBe(false);
    expect(canTransition(OrderStatus.CANCELED, OrderStatus.DRAFT)).toBe(false);
  });
});

describe('Order.fromRow / toRow', () => {
  it('round-trips through the row shape without losing lines', () => {
    const order = freshOrder();
    const rehydrated = Order.fromRow(order.toRow(), order.toLineRows());

    expect(rehydrated.id).toBe(order.id);
    expect(rehydrated.status).toBe(order.status);
    expect(rehydrated.totalMinor).toBe(order.totalMinor);
    expect(rehydrated.lines).toEqual(order.lines);
    // Not a column: the position in the event stream starts over on rehydration.
    expect(rehydrated.version).toBe(0);
  });

  it('rehydrated aggregate emits no events', () => {
    const order = freshOrder();
    const rehydrated = Order.fromRow(order.toRow(), order.toLineRows());

    expect(rehydrated.domainEvents).toHaveLength(0);
  });
});

describe('Order.attachPaymentId', () => {
  it('records a reference without claiming paid or advancing the event stream', () => {
    const order = freshOrder();
    order.markPendingPayment(at(1));
    order.clearDomainEvents();
    const versionBefore = order.version;

    order.attachPaymentId('psp_ch_1', at(2));

    expect(order.paymentId).toBe('psp_ch_1');
    expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(order.version).toBe(versionBefore);
    expect(order.domainEvents).toHaveLength(0);
  });

  it('is a no-op when the same id is reattached', () => {
    const order = freshOrder();
    order.markPendingPayment(at(1));
    order.attachPaymentId('psp_ch_1', at(2));
    order.attachPaymentId('psp_ch_1', at(3));

    expect(order.paymentId).toBe('psp_ch_1');
  });
});
