/**
 * @fileoverview Storage port for the billing use cases.
 *
 * @remarks Declared in the domain and implemented in infrastructure so the handlers can
 * ask for a payment, an invoice or a coupon without knowing that Postgres exists — and
 * so a unit test can answer with a plain object instead of a database.
 *
 * @remarks The write side is deliberately coarse. `saveCharge` persists the payment, the
 * invoice and their events in **one** transaction because the three are one fact: a
 * payment row without its invoice is a charge nobody can bill, an invoice without its
 * events is a bill no consumer hears about, and either half alone is a lie.
 */
import type { Payment } from '../payment.entity';
import type { Invoice } from '../invoice.entity';
import type { Refund } from '../refund.entity';

export const BILLING_REPOSITORY = Symbol('BILLING_REPOSITORY');

/** A coupon as the `coupons` table spells it. */
export interface Coupon {
  readonly code: string;
  readonly percentOff: number;
  readonly active: boolean;
}

/**
 * One charge, as it will be stored: the payment, the invoice it produced, and nothing
 * else — the events are buffered on those two aggregates and drained inside the same
 * transaction.
 */
export interface SaveChargeInput {
  readonly payment: Payment;
  /**
   * The order's invoice, freshly issued or updated in place.
   *
   * @remarks Always present: even a failed charge leaves a bill, because the order side
   * needs something to reconcile against and "no invoice" is indistinguishable from
   * "never charged".
   */
  readonly invoice: Invoice;
}

/**
 * One refund: the refund row, the payment it debited, and the invoice to write off when
 * the payment is now fully refunded.
 */
export interface SaveRefundInput {
  readonly refund: Refund;
  readonly payment: Payment;
  /** Present only when this refund completed the payback and the bill must go `void`. */
  readonly voidedInvoice: Invoice | null;
}

export interface BillingRepositoryPort {
  /** The payment a retried charge must answer with, or `null` for a first attempt. */
  findPaymentByIdempotencyKey(idempotencyKey: string): Promise<Payment | null>;

  findPaymentById(paymentId: string): Promise<Payment | null>;

  /** The refund a retried refund must answer with, or `null` for a first attempt. */
  findRefundByIdempotencyKey(idempotencyKey: string): Promise<Refund | null>;

  /** One invoice per order, so this is the whole lookup. */
  findInvoiceByOrderId(orderId: string): Promise<Invoice | null>;

  /** An inactive coupon still answers — the caller decides whether to refuse it. */
  findCoupon(code: string): Promise<Coupon | null>;

  /**
   * Writes the payment, the invoice and every buffered event in one transaction.
   *
   * @remarks Atomicity is this method's job: the caller has already decided *what* is
   * true, and splitting the write across calls would let a consumer observe a payment
   * that has no invoice or an invoice whose events never arrived.
   */
  saveCharge(input: SaveChargeInput): Promise<void>;

  /**
   * Writes the refund, the payment's new balance, the optional write-off and every
   * buffered event in one transaction.
   */
  saveRefund(input: SaveRefundInput): Promise<void>;

  /** Live payment count — the readiness probe's question: "can this service still work?" */
  countPayments(): Promise<number>;
}
