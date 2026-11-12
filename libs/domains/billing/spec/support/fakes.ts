/**
 * @fileoverview In-memory doubles for the billing ports.
 *
 * @remarks Hand-written rather than auto-mocked: a mock asserts on the calls a test
 * *expects*, while the question these suites keep asking is "what would be stored, and
 * what would be published" — and only the resulting state answers that.
 *
 * @remarks The repository stores **aggregates**, and drains their event buffers exactly
 * when `saveCharge`/`saveRefund` commit — the same moment the real repository writes the
 * outbox rows. An event assertion that ran against a buffer the save had not yet drained
 * would pass even if the save never happened.
 *
 * @remarks The semantics here mirror `PrismaBillingRepository` on purpose — idempotent on
 * the business keys, one invoice per order — because a suite that only ever exercised the
 * real repository could not run without a database, and one that only ever exercised this
 * double could not tell whether the real one kept its rules.
 */
import type { IDomainEvent } from '@auth/core';
import type { BillingConfig } from '../../src/billing.config';
import type { Payment } from '../../src/domain/payment.entity';
import type { Invoice } from '../../src/domain/invoice.entity';
import type { Refund } from '../../src/domain/refund.entity';
import type {
  BillingRepositoryPort,
  Coupon,
  SaveChargeInput,
  SaveRefundInput,
} from '../../src/domain/ports/billing-repository.port';

export const ORDER_ID = '0f1e2d3c-4b5a-4697-8899-aabbccddeeff';
export const OTHER_ORDER_ID = '1a2b3c4d-5e6f-4708-9911-223344556677';
export const PAYMENT_ID = '2b3c4d5e-6f7a-4891-9a0b-1c2d3e4f5a6b';
export const CURRENCY = 'EUR';

/** The `payment.*` / `invoice.*` -> topic mapping the real repository uses. */
export const TOPICS = {
  'payment.succeeded': 'platform.payment.succeeded.v1',
  'payment.failed': 'platform.payment.failed.v1',
  'payment.refunded': 'platform.payment.refunded.v1',
  'invoice.issued': 'platform.invoice.issued.v1',
} as const;

/** A config object for tests: the real defaults, without touching `process.env`. */
export const testBillingConfig = (overrides: Partial<BillingConfig> = {}): BillingConfig => ({
  taxRatesByCountry: { US: 0, DE: 1900, FR: 2000, GB: 2000 },
  defaultTaxCountry: 'US',
  pspProvider: 'fake',
  grpcDeadlineMs: 5_000,
  ...overrides,
});

/** One row the repository would have written to `outbox_events`. */
export interface CapturedOutboxEvent {
  readonly eventType: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly eventId: string;
  readonly dedupKey: string;
  readonly topic: string | null;
  readonly payload: unknown;
}

export class InMemoryBillingRepository implements BillingRepositoryPort {
  /** Stored payments, keyed by payment id. */
  readonly payments = new Map<string, Payment>();

  /** `idempotency_key` -> payment id: the unique index the real schema enforces. */
  readonly paymentKeys = new Map<string, string>();

  readonly refunds = new Map<string, Refund>();
  readonly refundKeys = new Map<string, string>();

  /** Stored invoices, keyed by order id: one per order, as the unique index says. */
  readonly invoices = new Map<string, Invoice>();

  readonly coupons = new Map<string, Coupon>();

  readonly outbox: CapturedOutboxEvent[] = [];

  /** Transaction boundaries. Each mutating call must add exactly one. */
  commits = 0;

  constructor(private readonly topics: Readonly<Record<string, string>> = TOPICS) {}

  async findPaymentByIdempotencyKey(idempotencyKey: string): Promise<Payment | null> {
    const id = this.paymentKeys.get(idempotencyKey);
    return id ? (this.payments.get(id) ?? null) : null;
  }

  async findPaymentById(paymentId: string): Promise<Payment | null> {
    return this.payments.get(paymentId) ?? null;
  }

  async findRefundByIdempotencyKey(idempotencyKey: string): Promise<Refund | null> {
    const id = this.refundKeys.get(idempotencyKey);
    return id ? (this.refunds.get(id) ?? null) : null;
  }

  async findInvoiceByOrderId(orderId: string): Promise<Invoice | null> {
    return this.invoices.get(orderId) ?? null;
  }

  async findCoupon(code: string): Promise<Coupon | null> {
    return this.coupons.get(code) ?? null;
  }

  async saveCharge(input: SaveChargeInput): Promise<void> {
    this.commits += 1;
    this.payments.set(input.payment.id, input.payment);
    this.paymentKeys.set(input.payment.idempotencyKey, input.payment.id);
    this.invoices.set(input.invoice.orderId, input.invoice);

    for (const event of [
      ...input.payment.clearDomainEvents(),
      ...input.invoice.clearDomainEvents(),
    ]) {
      this.outbox.push(capture(event, this.topics));
    }
  }

  async saveRefund(input: SaveRefundInput): Promise<void> {
    this.commits += 1;
    this.refunds.set(input.refund.id, input.refund);
    this.refundKeys.set(input.refund.idempotencyKey, input.refund.id);
    this.payments.set(input.payment.id, input.payment);
    if (input.voidedInvoice) {
      this.invoices.set(input.voidedInvoice.orderId, input.voidedInvoice);
    }

    for (const event of [
      ...input.payment.clearDomainEvents(),
      ...(input.voidedInvoice ? input.voidedInvoice.clearDomainEvents() : []),
    ]) {
      this.outbox.push(capture(event, this.topics));
    }
  }

  async countPayments(): Promise<number> {
    return this.payments.size;
  }
}

function capture(event: IDomainEvent, topics: Readonly<Record<string, string>>): CapturedOutboxEvent {
  const candidate = event as unknown as { payload?: unknown };
  return {
    eventType: event.eventType,
    aggregateId: event.aggregateId,
    version: event.version,
    eventId: event.eventId,
    dedupKey: `${event.eventType}:${event.aggregateId}:${event.version}`,
    topic: topics[event.eventType] ?? null,
    payload: candidate.payload ?? {},
  };
}
