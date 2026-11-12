/**
 * @fileoverview The refund: one return of money against one payment.
 *
 * @remarks Not an aggregate with events of its own — `PaymentRefunded` already carries
 * the fact, keyed by the payment's post-refund version — but a first-class entity because
 * `refunds.idempotency_key` is unique and that uniqueness is the whole idempotency
 * mechanism for the refund path. A retried refund finds this row and answers with it
 * instead of sending money back twice.
 *
 * @remarks There is deliberately no `version` column on `refunds`: a refund is written
 * once and never updated, so a write counter would have nothing to count.
 */
import { Ensure } from '@auth/core';

export interface RefundProps {
  paymentId: string;
  orderId: string;
  idempotencyKey: string;
  amountMinor: number;
  status: string;
  providerRef: string | null;
}

/** One `refunds` row, exactly as the column names spell it. */
export interface RefundRow {
  id: string;
  payment_id: string;
  order_id: string;
  idempotency_key: string;
  amount_minor: number;
  status: string;
  provider_ref: string | null;
  created_at: Date;
}

export class Refund {
  private constructor(
    readonly id: string,
    private readonly props: RefundProps,
    readonly createdAt: Date,
  ) {}

  static create(input: {
    id?: string;
    paymentId: string;
    orderId: string;
    idempotencyKey: string;
    amountMinor: number;
    status: string;
    providerRef?: string | null;
    now?: Date;
  }): Refund {
    Ensure.notEmpty(input.paymentId, 'paymentId');
    Ensure.notEmpty(input.orderId, 'orderId');
    Ensure.notEmpty(input.idempotencyKey, 'idempotencyKey');
    Ensure.positive(input.amountMinor, 'amountMinor');

    const now = input.now ?? new Date();
    return new Refund(
      input.id ?? crypto.randomUUID(),
      {
        paymentId: input.paymentId,
        orderId: input.orderId,
        idempotencyKey: input.idempotencyKey,
        amountMinor: input.amountMinor,
        status: input.status,
        providerRef: input.providerRef ?? null,
      },
      now,
    );
  }

  static fromRow(row: RefundRow): Refund {
    return new Refund(
      row.id,
      {
        paymentId: row.payment_id,
        orderId: row.order_id,
        idempotencyKey: row.idempotency_key,
        amountMinor: row.amount_minor,
        status: row.status,
        providerRef: row.provider_ref,
      },
      row.created_at,
    );
  }

  get paymentId(): string {
    return this.props.paymentId;
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

  get status(): string {
    return this.props.status;
  }

  get providerRef(): string | null {
    return this.props.providerRef;
  }

  toRow(): RefundRow {
    return {
      id: this.id,
      payment_id: this.props.paymentId,
      order_id: this.props.orderId,
      idempotency_key: this.props.idempotencyKey,
      amount_minor: this.props.amountMinor,
      status: this.props.status,
      provider_ref: this.props.providerRef,
      created_at: this.createdAt,
    };
  }
}
