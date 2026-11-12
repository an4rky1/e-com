/**
 * @fileoverview Billing's domain events.
 *
 * @remarks Event *classes* live here so the aggregates can announce a fact without the
 * repository having to know the event type strings; the topic mapping stays in
 * infrastructure, because a topic is a transport contract and a domain event is not.
 *
 * @remarks Versioning is the load-bearing part of this file. `dedup_key` is
 * `<type>:<aggregateId>:<version>`, and the unique index on `(dedup_key, type)` is what
 * turns a retried command into a no-op. Every event below therefore states what its
 * version counts — and every `aggregateId` is the **order**, because the saga that
 * consumes these reasons per order and a partition key of payment id would scatter one
 * order's decisions across partitions where they can be reordered.
 */
import { DomainEvent } from '@auth/core';
import type { InvoicePayload, PaymentPayload } from '@auth/contracts';

/** Aggregate type recorded on payment-scoped events. */
export const PAYMENT_AGGREGATE = 'Payment';

/** Aggregate type recorded on invoice-scoped events. */
export const INVOICE_AGGREGATE = 'Invoice';

/** The charge settled. The first fact an order side waits for. */
export class PaymentSucceeded extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: PaymentPayload,
    version = 1,
  ) {
    super(aggregateId, PAYMENT_AGGREGATE, 'payment.succeeded', version);
  }
}

/** The charge failed. Carries the provider's failure code so a caller can say why. */
export class PaymentFailed extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: PaymentPayload,
    version = 1,
  ) {
    super(aggregateId, PAYMENT_AGGREGATE, 'payment.failed', version);
  }
}

/**
 * Money went back to the customer.
 *
 * @remarks Keyed by the payment's **post-refund** version, so two partial refunds of one
 * payment produce two distinct `dedup_key`s instead of the second being swallowed.
 */
export class PaymentRefunded extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: PaymentPayload,
    version: number,
  ) {
    super(aggregateId, PAYMENT_AGGREGATE, 'payment.refunded', version);
  }
}

/**
 * An invoice came into existence for an order.
 *
 * @remarks Announced once, when the invoice row is created: `invoices.order_id` is
 * unique, so there is exactly one such moment per order, and the invoice's own version
 * is the dedup tail. Status transitions that follow (`paid`, `void`) have no topic of
 * their own — the payment events already carry those facts.
 */
export class InvoiceIssued extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: InvoicePayload,
    version = 1,
  ) {
    super(aggregateId, INVOICE_AGGREGATE, 'invoice.issued', version);
  }
}
