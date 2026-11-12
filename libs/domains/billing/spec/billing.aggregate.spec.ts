/**
 * @fileoverview The two money aggregates: the payment and the bill.
 *
 * @remarks What these tests guard is the invariant the whole service exists for: a
 * payment can never refund more than it took, and an invoice's figures are only ever
 * replaced wholesale by a computation — never nudged. A partial write here is money that
 * does not add up.
 *
 * @remarks Events are asserted as much as state: `dedup_key` is
 * `<type>:<aggregateId>:<version>`, so a version that does not advance is a silent
 * duplicate announcement, and a version that advances twice is a gap consumers never see.
 */
import 'reflect-metadata';
import { ValidationException } from '@auth/platform/error-handling';
import { Payment, isPaymentStatus } from '../src/domain/payment.entity';
import { Invoice, isInvoiceStatus } from '../src/domain/invoice.entity';
import { Refund } from '../src/domain/refund.entity';
import { computeTotals } from '../src/domain/totals';
import { ORDER_ID, PAYMENT_ID } from './support/fakes';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1_000);

const succeededPayment = (overrides: Partial<Parameters<typeof Payment.fromProvider>[0]> = {}) =>
  Payment.fromProvider({
    id: PAYMENT_ID,
    orderId: ORDER_ID,
    idempotencyKey: `order:${ORDER_ID}:charge:1`,
    amountMinor: 2_380,
    currency: 'EUR',
    status: 'succeeded',
    provider: 'fake',
    providerRef: 'psp_ch_1',
    customerId: 'customer-1',
    now: T0,
    ...overrides,
  });

const totalsFor = (coupon?: { code: string; percentOff: number }) =>
  computeTotals({
    lines: [
      { sku: 'SKU-1', quantity: 2, unitPriceMinor: 1_000 },
      { sku: 'SKU-2', quantity: 1, unitPriceMinor: 380 },
    ],
    currency: 'EUR',
    taxRateBps: 1_900,
    coupon,
  });

describe('Payment.fromProvider', () => {
  it('announces a settled charge at version one, keyed by order', () => {
    const payment = succeededPayment();

    expect(payment.domainEvents).toHaveLength(1);
    expect(payment.domainEvents[0]).toMatchObject({
      eventType: 'payment.succeeded',
      aggregateId: ORDER_ID,
      aggregateType: 'Payment',
      version: 1,
    });
    expect(payment.version).toBe(1);
    expect(payment.toPayload()).toMatchObject({
      paymentId: PAYMENT_ID,
      orderId: ORDER_ID,
      amountMinor: 2_380,
      refundedMinor: 0,
      currency: 'EUR',
      status: 'succeeded',
      provider: 'fake',
    });
  });

  it('announces a decline with the provider failure code', () => {
    const payment = succeededPayment({ status: 'failed', failureCode: 'card_declined' });

    expect(payment.domainEvents[0].eventType).toBe('payment.failed');
    expect(payment.toPayload().failureCode).toBe('card_declined');
    expect(payment.status).toBe('failed');
  });

  it('announces nothing for a charge that is still in flight', () => {
    // `requires_action` is neither success nor failure: the customer has not been
    // challenged yet, and `Topics` carries no event for "still deciding".
    const payment = succeededPayment({
      status: 'requires_action',
      providerRef: 'psp_ch_2',
    });

    expect(payment.domainEvents).toHaveLength(0);
    expect(payment.status).toBe('requires_action');
    expect(payment.version).toBe(1);
  });

  it('starts with nothing refunded', () => {
    const payment = succeededPayment();

    expect(payment.refundedMinor).toBe(0);
    expect(payment.remainingMinor).toBe(2_380);
    expect(payment.isFullyRefunded).toBe(false);
  });
});

describe('Payment.refund', () => {
  it('takes the money back and announces it at the next version', () => {
    const payment = succeededPayment();
    payment.clearDomainEvents();

    payment.refund(500, at(60));

    expect(payment.refundedMinor).toBe(500);
    expect(payment.remainingMinor).toBe(1_880);
    expect(payment.version).toBe(2);
    expect(payment.domainEvents).toHaveLength(1);
    expect(payment.domainEvents[0]).toMatchObject({
      eventType: 'payment.refunded',
      aggregateId: ORDER_ID,
      version: 2,
    });
    expect(payment.toPayload().refundedMinor).toBe(500);
  });

  it('versions two partial refunds differently, so dedup cannot swallow one', () => {
    const payment = succeededPayment();
    payment.clearDomainEvents();

    payment.refund(500, at(60));
    payment.refund(500, at(120));

    const versions = payment.domainEvents.map((event) => event.version);
    expect(versions).toEqual([2, 3]);
    expect(new Set(versions).size).toBe(versions.length);
    expect(payment.refundedMinor).toBe(1_000);
  });

  it('refuses a refund larger than the payment holds', () => {
    const payment = succeededPayment();
    payment.clearDomainEvents();

    const error = (() => {
      try {
        payment.refund(2_381, T0);
      } catch (error_) {
        return error_ as ValidationException;
      }
      throw new Error('expected the refund to be refused');
    })();

    expect(error).toBeInstanceOf(ValidationException);
    expect(error.context).toMatchObject({ requested: 2_381, remaining: 2_380 });
    expect(payment.refundedMinor).toBe(0);
    expect(payment.domainEvents).toHaveLength(0);
  });

  it('refuses a refund that is not a positive integer', () => {
    const payment = succeededPayment();

    expect(() => payment.refund(0)).toThrow(ValidationException);
    expect(() => payment.refund(-100)).toThrow(ValidationException);
    expect(() => payment.refund(10.5)).toThrow(ValidationException);
  });

  it('refuses to refund a payment that never settled', () => {
    const failed = succeededPayment({ status: 'failed', failureCode: 'card_declined' });

    expect(() => failed.refund(100)).toThrow(ValidationException);
    expect(failed.refundedMinor).toBe(0);
  });

  it('allows the balance to reach exactly zero', () => {
    const payment = succeededPayment();

    payment.refund(2_380, at(60));

    expect(payment.remainingMinor).toBe(0);
    expect(payment.isFullyRefunded).toBe(true);
    expect(payment.refundedMinor).toBe(2_380);
  });
});

describe('Payment persistence', () => {
  it('round-trips through a row without losing the ledger', () => {
    const payment = succeededPayment();
    payment.refund(380, at(60));

    const loaded = Payment.fromRow(payment.toRow());

    expect(loaded.id).toBe(payment.id);
    expect(loaded.orderId).toBe(ORDER_ID);
    expect(loaded.status).toBe('succeeded');
    expect(loaded.refundedMinor).toBe(380);
    expect(loaded.remainingMinor).toBe(2_000);
    expect(loaded.version).toBe(2);
    // Rehydration announces nothing: the write already happened.
    expect(loaded.domainEvents).toHaveLength(0);
  });

  it('never rewrites identity columns on update', () => {
    const payment = succeededPayment();

    expect(payment.toUpdate()).toEqual({
      status: 'succeeded',
      refunded_minor: 0,
      version: 1,
      updated_at: T0,
    });
    expect(payment.toRow()).toMatchObject({
      id: PAYMENT_ID,
      order_id: ORDER_ID,
      idempotency_key: `order:${ORDER_ID}:charge:1`,
      amount_minor: 2_380,
      provider_ref: 'psp_ch_1',
    });
  });

  it('reads an unknown status as in-flight rather than as settled', () => {
    const loaded = Payment.fromRow({
      ...succeededPayment().toRow(),
      status: 'something_a_newer_build_wrote',
    });

    // Treating it as settled would make it refundable; treating it as failed would make
    // it look like the money never arrived. In-flight is the only choice that cannot
    // move money either way.
    expect(loaded.status).toBe('processing');
    expect(isPaymentStatus('succeeded')).toBe(true);
    expect(isPaymentStatus('something_a_newer_build_wrote')).toBe(false);
  });
});

describe('Invoice.issue', () => {
  it('fixes the bill from a computation and announces it once', () => {
    const invoice = Invoice.issue({
      orderId: ORDER_ID,
      totals: totalsFor(),
      status: 'paid',
      country: 'DE',
      now: T0,
    });

    expect(invoice.status).toBe('paid');
    expect(invoice.version).toBe(1);
    expect(invoice.lines).toHaveLength(2);
    expect(invoice.subtotalMinor).toBe(2_380);
    expect(invoice.domainEvents).toHaveLength(1);
    expect(invoice.domainEvents[0]).toMatchObject({
      eventType: 'invoice.issued',
      aggregateId: ORDER_ID,
      aggregateType: 'Invoice',
      version: 1,
    });
    expect(invoice.toPayload()).toMatchObject({
      orderId: ORDER_ID,
      totalMinor: invoice.totalMinor,
      taxMinor: invoice.taxMinor,
    });
  });

  it('records the jurisdiction and the coupon it was computed with', () => {
    const invoice = Invoice.issue({
      orderId: ORDER_ID,
      totals: totalsFor({ code: 'SAVE10', percentOff: 10 }),
      status: 'issued',
      country: 'DE',
      couponCode: 'SAVE10',
      now: T0,
    });

    expect(invoice.couponCode).toBe('SAVE10');
    expect(invoice.country).toBe('DE');
    expect(invoice.discountMinor).toBeGreaterThan(0);
    expect(invoice.toPayload().couponCode).toBe('SAVE10');
  });

  it('starts a failed charge as issued, and a settled one as paid', () => {
    expect(
      Invoice.issue({ orderId: ORDER_ID, totals: totalsFor(), status: 'issued', now: T0 }).status,
    ).toBe('issued');
    expect(
      Invoice.issue({ orderId: ORDER_ID, totals: totalsFor(), status: 'paid', now: T0 }).status,
    ).toBe('paid');
  });
});

describe('Invoice transitions', () => {
  const issue = (status: 'draft' | 'issued' | 'paid' | 'void' = 'issued') =>
    Invoice.issue({ orderId: ORDER_ID, totals: totalsFor(), status, now: T0 });

  it('replaces the figures wholesale without announcing a second invoice', () => {
    const invoice = issue();
    invoice.clearDomainEvents();

    invoice.applyTotals(totalsFor({ code: 'SAVE10', percentOff: 10 }), at(60));

    expect(invoice.discountMinor).toBeGreaterThan(0);
    expect(invoice.version).toBe(2);
    // `invoice.issued` was already announced for this order; a second one at a new
    // version would tell consumers an invoice exists twice.
    expect(invoice.domainEvents).toHaveLength(0);
    // The lines are replaced, not merged: a stale line would make the bill disagree
    // with its own total.
    expect(invoice.lines).toHaveLength(2);
  });

  it('moves to paid, and stays there', () => {
    const invoice = issue();

    invoice.markPaid(at(60));
    expect(invoice.status).toBe('paid');
    const version = invoice.version;

    invoice.markPaid(at(120));
    expect(invoice.status).toBe('paid');
    expect(invoice.version).toBe(version);
  });

  it('refuses to collect against a bill that was written off', () => {
    const invoice = issue('void');

    expect(() => invoice.markPaid(at(60))).toThrow(ValidationException);
    expect(invoice.status).toBe('void');
  });

  it('voids once, and a second write-off changes nothing', () => {
    const invoice = issue('paid');

    invoice.markVoid(at(60));
    expect(invoice.status).toBe('void');
    const version = invoice.version;

    invoice.markVoid(at(120));
    expect(invoice.version).toBe(version);
    expect(invoice.status).toBe('void');
  });

  it('round-trips through a row with its lines intact', () => {
    const invoice = issue('paid');
    const row = invoice.toRow();
    const loaded = Invoice.fromRow({ ...row, lines: invoice.toLineRows().map((line, index) => ({
      id: `line-${index}`,
      invoice_id: row.id,
      ...line,
    })) });

    expect(loaded.id).toBe(invoice.id);
    expect(loaded.orderId).toBe(ORDER_ID);
    expect(loaded.status).toBe('paid');
    expect(loaded.totalMinor).toBe(invoice.totalMinor);
    expect(loaded.lines).toEqual(invoice.lines);
    expect(loaded.domainEvents).toHaveLength(0);
    expect(isInvoiceStatus('void')).toBe(true);
    expect(isInvoiceStatus('paid_out')).toBe(false);
  });

  it('reads an unknown status as draft rather than as settled', () => {
    const loaded = Invoice.fromRow({ ...issue().toRow(), status: 'something_newer' });

    expect(loaded.status).toBe('draft');
  });
});

describe('Refund', () => {
  it('stores the return against its payment and its order', () => {
    const refund = Refund.create({
      paymentId: PAYMENT_ID,
      orderId: ORDER_ID,
      idempotencyKey: `order:${ORDER_ID}:refund:1`,
      amountMinor: 500,
      status: 'succeeded',
      providerRef: 'psp_rf_1',
      now: T0,
    });

    expect(refund).toMatchObject({
      paymentId: PAYMENT_ID,
      orderId: ORDER_ID,
      amountMinor: 500,
      status: 'succeeded',
      providerRef: 'psp_rf_1',
    });
    expect(refund.toRow()).toMatchObject({
      id: refund.id,
      payment_id: PAYMENT_ID,
      order_id: ORDER_ID,
      idempotency_key: `order:${ORDER_ID}:refund:1`,
      amount_minor: 500,
    });
    expect(Refund.fromRow(refund.toRow())).toMatchObject({
      id: refund.id,
      amountMinor: 500,
      idempotencyKey: `order:${ORDER_ID}:refund:1`,
    });
  });

  it('refuses to exist without its keys', () => {
    expect(() =>
      Refund.create({
        paymentId: PAYMENT_ID,
        orderId: ORDER_ID,
        idempotencyKey: ' ',
        amountMinor: 100,
        status: 'succeeded',
      }),
    ).toThrow();
    expect(() =>
      Refund.create({
        paymentId: '',
        orderId: ORDER_ID,
        idempotencyKey: 'key',
        amountMinor: 100,
        status: 'succeeded',
      }),
    ).toThrow();
    expect(() =>
      Refund.create({
        paymentId: PAYMENT_ID,
        orderId: ORDER_ID,
        idempotencyKey: 'key',
        amountMinor: 0,
        status: 'succeeded',
      }),
    ).toThrow();
  });
});
