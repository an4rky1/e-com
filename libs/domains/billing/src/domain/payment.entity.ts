/**
 * @fileoverview The payment aggregate: one attempt to move money for one order.
 *
 * @remarks One aggregate per `payments` row. The row is keyed by `idempotency_key` —
 * the caller's business-derived `order:{id}:charge:{step}` — which is what makes a
 * retried charge answer with the payment it already made instead of charging twice.
 *
 * @remarks `version` is overridden out of `AggregateRoot`: the base implementation counts
 * *buffered* events, which would make a refund's `payment.refunded` collide with the
 * original `payment.succeeded` on the same `dedup_key` and the second announcement would
 * be silently dropped.
 */
import { AggregateRoot } from '@auth/core';
import { ValidationException } from '@auth/platform/error-handling';
import { PaymentFailed, PaymentRefunded, PaymentSucceeded } from './billing.events';

/**
 * The statuses a payment moves through, exactly as the PSP reports them.
 *
 * @remarks `requires_action` is a *success-shaped* answer: the charge is not finished,
 * but nothing went wrong, and the caller shows a 3DS redirect rather than an error.
 */
export type PaymentStatus =
  | 'requires_payment_method'
  | 'requires_action'
  | 'processing'
  | 'succeeded'
  | 'failed';

/** Statuses from which money may be refunded. */
export const REFUNDABLE_PAYMENT_STATUSES: ReadonlySet<PaymentStatus> = new Set(['succeeded']);

/**
 * Statuses a webhook may move a payment *to*, keyed by where it is now.
 *
 * @remarks Forward-only: `succeeded` and `failed` are terminal for a given attempt, so a
 * late delivery cannot walk a settled payment backwards and a replayed failure cannot
 * erase a success. An empty set means "this status accepts no further webhook".
 */
const WEBHOOK_TRANSITIONS: Readonly<Record<PaymentStatus, ReadonlySet<PaymentStatus>>> = {
  requires_payment_method: new Set<PaymentStatus>([
    'requires_action',
    'processing',
    'succeeded',
    'failed',
  ]),
  requires_action: new Set<PaymentStatus>(['processing', 'succeeded', 'failed']),
  processing: new Set<PaymentStatus>(['succeeded', 'failed']),
  succeeded: new Set<PaymentStatus>(),
  failed: new Set<PaymentStatus>(),
};

/** What `applyProviderStatus` did with the delivery. */
export type WebhookApplyOutcome = 'applied' | 'duplicate';

/** One `payments` row, exactly as the column names spell it. */
export interface PaymentRow {
  id: string;
  order_id: string;
  idempotency_key: string;
  amount_minor: number;
  currency: string;
  status: string;
  provider: string;
  provider_ref: string | null;
  failure_code: string | null;
  refunded_minor: number;
  customer_id: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface PaymentProps {
  orderId: string;
  idempotencyKey: string;
  amountMinor: number;
  currency: string;
  status: PaymentStatus;
  provider: string;
  providerRef: string | null;
  failureCode: string | null;
  refundedMinor: number;
  customerId: string;
  /** Write counter, and the version tail of every `payment.*` dedup_key. */
  version: number;
}

export class Payment extends AggregateRoot<string> {
  private constructor(
    id: string,
    private readonly props: PaymentProps,
    createdAt: Date,
    updatedAt: Date,
  ) {
    super(id, createdAt, updatedAt, null);
  }

  /**
   * A charge the provider has already answered.
   *
   * @remarks The announcement happens here, in the aggregate, so a payment that settled
   * and a payment that failed are told apart by the same code that stored them — a
   * repository that decided which event to emit would be a second implementation of the
   * status rules.
   *
   * @remarks `requires_action` and `processing` announce nothing: neither is a fact about
   * where the money is, and `Topics` carries no event for them.
   */
  static fromProvider(input: {
    id: string;
    orderId: string;
    idempotencyKey: string;
    amountMinor: number;
    currency: string;
    status: PaymentStatus;
    provider: string;
    providerRef?: string | null;
    failureCode?: string | null;
    customerId: string;
    now?: Date;
  }): Payment {
    const now = input.now ?? new Date();
    const payment = new Payment(
      input.id,
      {
        orderId: input.orderId,
        idempotencyKey: input.idempotencyKey,
        amountMinor: input.amountMinor,
        currency: input.currency,
        status: input.status,
        provider: input.provider,
        providerRef: input.providerRef ?? null,
        failureCode: input.failureCode ?? null,
        refundedMinor: 0,
        customerId: input.customerId,
        version: 1,
      },
      now,
      now,
    );

    if (input.status === 'succeeded') {
      payment.addDomainEvent(new PaymentSucceeded(input.orderId, payment.toPayload(), 1));
    } else if (input.status === 'failed') {
      payment.addDomainEvent(new PaymentFailed(input.orderId, payment.toPayload(), 1));
    }

    return payment;
  }

  /** Rehydration from persistence. Does not emit events — the write already happened. */
  static fromRow(row: PaymentRow): Payment {
    return new Payment(
      row.id,
      {
        orderId: row.order_id,
        idempotencyKey: row.idempotency_key,
        amountMinor: row.amount_minor,
        currency: row.currency,
        status: isPaymentStatus(row.status) ? row.status : 'processing',
        provider: row.provider,
        providerRef: row.provider_ref,
        failureCode: row.failure_code,
        refundedMinor: row.refunded_minor,
        customerId: row.customer_id,
        version: row.version,
      },
      row.created_at,
      row.updated_at,
    );
  }

  /**
   * Applies a provider-reported status from a verified webhook.
   *
   * @remarks `duplicate` for a redelivery whose status already matches: the write is
   * skipped, the version does not move, and no event is re-announced — a PSP retrying
   * until it sees a 2xx must not be able to bump `version` or collide a `dedup_key`.
   *
   * @remarks An illegal transition (a success walking back to `processing`, a failure
   * overwriting a settled payment) is refused rather than clamped: the provider is either
   * lying, replaying an old capture, or talking about a different attempt, and storing
   * any of those would rewrite where the money actually is.
   *
   * @remarks `succeeded` / `failed` announce the same events `fromProvider` does, so a
   * payment that settled through a webhook and one that settled synchronously are told
   * to consumers by the same code.
   */
  applyProviderStatus(input: {
    status: PaymentStatus;
    failureCode?: string | null;
    now?: Date;
  }): WebhookApplyOutcome {
    const now = input.now ?? new Date();

    if (input.status === this.props.status) {
      return 'duplicate';
    }

    if (!WEBHOOK_TRANSITIONS[this.props.status].has(input.status)) {
      throw new ValidationException('illegal payment status transition', {
        paymentId: this.id,
        from: this.props.status,
        to: input.status,
      });
    }

    this.props.status = input.status;
    if (input.status === 'failed') {
      this.props.failureCode = input.failureCode ?? this.props.failureCode;
    }
    this.bump(now);

    if (input.status === 'succeeded') {
      this.addDomainEvent(
        new PaymentSucceeded(this.props.orderId, this.toPayload(), this.props.version),
      );
    } else if (input.status === 'failed') {
      this.addDomainEvent(
        new PaymentFailed(this.props.orderId, this.toPayload(), this.props.version),
      );
    }

    return 'applied';
  }

  get orderId(): string {
    return this.props.orderId;
  }

  get idempotencyKey(): string {
    return this.props.idempotencyKey;
  }

  get amountMinor(): number {
    return this.props.amountMinor;
  }

  get currency(): string {
    return this.props.currency;
  }

  get status(): PaymentStatus {
    return this.props.status;
  }

  get provider(): string {
    return this.props.provider;
  }

  get providerRef(): string | null {
    return this.props.providerRef;
  }

  get failureCode(): string | null {
    return this.props.failureCode;
  }

  get refundedMinor(): number {
    return this.props.refundedMinor;
  }

  get customerId(): string {
    return this.props.customerId;
  }

  override get version(): number {
    return this.props.version;
  }

  /** What may still be refunded: everything the customer paid, less what came back. */
  get remainingMinor(): number {
    return this.props.amountMinor - this.props.refundedMinor;
  }

  get isFullyRefunded(): boolean {
    return this.remainingMinor <= 0;
  }

  /**
   * Records `amountMinor` coming back, and announces it.
   *
   * @remarks Refuses rather than clamping: a refund larger than what the payment holds
   * would drive `refunded_minor` past `amount_minor`, and the ledger would claim more
   * money left than ever arrived. The remaining balance is checked by the caller against
   * the same figure this aggregate stores, so the refusal cannot be raced into place.
   *
   * @remarks The version advances *before* the event is built, so two partial refunds
   * carry different `dedup_key`s — `payment.refunded:<orderId>:2` then `:3`.
   */
  refund(amountMinor: number, now: Date = new Date()): void {
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      throw new ValidationException('refund amount must be a positive integer in minor units', {
        amountMinor,
      });
    }
    if (!REFUNDABLE_PAYMENT_STATUSES.has(this.props.status)) {
      throw new ValidationException('only a succeeded payment can be refunded', {
        paymentId: this.id,
        status: this.props.status,
      });
    }
    if (amountMinor > this.remainingMinor) {
      throw new ValidationException('refund exceeds the refundable balance', {
        paymentId: this.id,
        requested: amountMinor,
        remaining: this.remainingMinor,
      });
    }

    this.props.refundedMinor += amountMinor;
    this.bump(now);

    this.addDomainEvent(
      new PaymentRefunded(this.props.orderId, this.toPayload(), this.props.version),
    );
  }

  /** The same aggregate, flattened the way persistence hands it back. */
  toRow(): PaymentRow {
    return {
      id: this.id,
      order_id: this.props.orderId,
      idempotency_key: this.props.idempotencyKey,
      amount_minor: this.props.amountMinor,
      currency: this.props.currency,
      status: this.props.status,
      provider: this.props.provider,
      provider_ref: this.props.providerRef,
      failure_code: this.props.failureCode,
      refunded_minor: this.props.refundedMinor,
      customer_id: this.props.customerId,
      version: this.props.version,
      created_at: this.createdAt,
      updated_at: this.updatedAt,
    };
  }

  /** Columns an update may write. Identity, key and amount never move. */
  toUpdate(): {
    status: string;
    failure_code: string | null;
    refunded_minor: number;
    version: number;
    updated_at: Date;
  } {
    return {
      status: this.props.status,
      failure_code: this.props.failureCode,
      refunded_minor: this.props.refundedMinor,
      version: this.props.version,
      updated_at: this.updatedAt,
    };
  }

  /** The payload contract, as `PaymentPayload` spells it. */
  toPayload(): {
    paymentId: string;
    orderId: string;
    amountMinor: number;
    refundedMinor: number;
    currency: string;
    status: string;
    failureCode?: string;
    provider: string;
  } {
    return {
      paymentId: this.id,
      orderId: this.props.orderId,
      amountMinor: this.props.amountMinor,
      refundedMinor: this.props.refundedMinor,
      currency: this.props.currency,
      status: this.props.status,
      ...(this.props.failureCode ? { failureCode: this.props.failureCode } : {}),
      provider: this.props.provider,
    };
  }

  private bump(now: Date): void {
    this.props.version += 1;
    this.updatedAt = now;
  }
}

/** A status this build knows how to act on. Anything else reads as in-flight. */
export const isPaymentStatus = (value: string): value is PaymentStatus =>
  value === 'requires_payment_method' ||
  value === 'requires_action' ||
  value === 'processing' ||
  value === 'succeeded' ||
  value === 'failed';
