/**
 * @fileoverview The invoice: one order's bill, fixed at the moment it is issued.
 *
 * @remarks One aggregate per `invoices` row, and `invoices.order_id` is unique — an order
 * has exactly one invoice, updated in place as the order is paid and refunded. The lines
 * are part of the aggregate because the totals are meaningless without them: a stored
 * `total_minor` that no longer matches its own lines is exactly the money bug this
 * service exists to prevent.
 *
 * @remarks `version` is overridden out of `AggregateRoot` for the same reason as
 * `Payment`: the base counts buffered events, and a version that resets after
 * `clearDomainEvents()` would collide `dedup_key`s on a later reissue.
 */
import { AggregateRoot } from '@auth/core';
import { ValidationException } from '@auth/platform/error-handling';
import type { ComputedTotals } from './totals';
import { InvoiceIssued } from './billing.events';

export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'void';

/** Statuses from which an invoice can still move. */
export const TERMINAL_INVOICE_STATUSES: ReadonlySet<InvoiceStatus> = new Set(['void']);

/** One `invoice_lines` row. */
export interface InvoiceLineRow {
  id: string;
  invoice_id: string;
  sku: string;
  quantity: number;
  unit_price_minor: number;
  line_subtotal_minor: number;
  tax_minor: number;
}

/** One `invoices` row, exactly as the column names spell it. */
export interface InvoiceRow {
  id: string;
  order_id: string;
  status: string;
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  shipping_minor: number;
  total_minor: number;
  currency: string;
  coupon_code: string | null;
  country: string | null;
  issued_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  lines?: InvoiceLineRow[];
}

export interface InvoiceLine {
  readonly sku: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly lineSubtotalMinor: number;
  readonly taxMinor: number;
}

export interface InvoiceProps {
  orderId: string;
  status: InvoiceStatus;
  lines: InvoiceLine[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  shippingMinor: number;
  totalMinor: number;
  currency: string;
  couponCode: string | null;
  country: string | null;
  issuedAt: Date | null;
  /** Write counter; the tail of the `invoice.issued` dedup_key. */
  version: number;
}

export class Invoice extends AggregateRoot<string> {
  private constructor(
    id: string,
    private readonly props: InvoiceProps,
    createdAt: Date,
    updatedAt: Date,
  ) {
    super(id, createdAt, updatedAt, null);
  }

  /**
   * The invoice for a charge, fixed from a computation.
   *
   * @remarks Status is the caller's decision — a charge that just settled writes `paid`,
   * a charge that failed still leaves a bill behind as `issued` — because the aggregate
   * must not infer payment state from totals it does not hold.
   *
   * @remarks Announces `invoice.issued` at version 1: the creation of the row is the one
   * fact this topic carries, and `invoices.order_id` being unique means it happens once.
   */
  static issue(input: {
    orderId: string;
    totals: ComputedTotals;
    status: InvoiceStatus;
    country?: string | null;
    couponCode?: string | null;
    id?: string;
    now?: Date;
  }): Invoice {
    const now = input.now ?? new Date();

    const invoice = new Invoice(
      input.id ?? crypto.randomUUID(),
      {
        orderId: input.orderId,
        status: input.status,
        lines: input.totals.lines.map((line) => ({ ...line })),
        subtotalMinor: input.totals.subtotalMinor,
        discountMinor: input.totals.discountMinor,
        taxMinor: input.totals.taxMinor,
        shippingMinor: input.totals.shippingMinor,
        totalMinor: input.totals.totalMinor,
        currency: input.totals.currency,
        couponCode: input.couponCode ?? null,
        country: input.country ?? null,
        issuedAt: now,
        version: 1,
      },
      now,
      now,
    );

    invoice.addDomainEvent(new InvoiceIssued(input.orderId, invoice.toPayload(), 1));

    return invoice;
  }

  /** Rehydration from persistence. Does not emit events — the write already happened. */
  static fromRow(row: InvoiceRow, lines: readonly InvoiceLineRow[] = row.lines ?? []): Invoice {
    return new Invoice(
      row.id,
      {
        orderId: row.order_id,
        status: isInvoiceStatus(row.status) ? row.status : 'draft',
        lines: lines.map((line) => ({
          sku: line.sku,
          quantity: line.quantity,
          unitPriceMinor: line.unit_price_minor,
          lineSubtotalMinor: line.line_subtotal_minor,
          taxMinor: line.tax_minor,
        })),
        subtotalMinor: row.subtotal_minor,
        discountMinor: row.discount_minor,
        taxMinor: row.tax_minor,
        shippingMinor: row.shipping_minor,
        totalMinor: row.total_minor,
        currency: row.currency,
        couponCode: row.coupon_code,
        country: row.country,
        issuedAt: row.issued_at,
        version: row.version,
      },
      row.created_at,
      row.updated_at,
    );
  }

  get orderId(): string {
    return this.props.orderId;
  }

  get status(): InvoiceStatus {
    return this.props.status;
  }

  get lines(): readonly InvoiceLine[] {
    return this.props.lines;
  }

  get subtotalMinor(): number {
    return this.props.subtotalMinor;
  }

  get discountMinor(): number {
    return this.props.discountMinor;
  }

  get taxMinor(): number {
    return this.props.taxMinor;
  }

  get shippingMinor(): number {
    return this.props.shippingMinor;
  }

  get totalMinor(): number {
    return this.props.totalMinor;
  }

  get currency(): string {
    return this.props.currency;
  }

  get couponCode(): string | null {
    return this.props.couponCode;
  }

  get country(): string | null {
    return this.props.country;
  }

  get issuedAt(): Date | null {
    return this.props.issuedAt;
  }

  override get version(): number {
    return this.props.version;
  }

  /**
   * Replaces the bill with a fresh computation, e.g. a corrected charge after a failure.
   *
   * @remarks No event: `invoice.issued` was already announced for this order, and a
   * second one at a new version would tell consumers an invoice exists twice. The totals
   * still move, because a bill that kept the numbers of a charge that never settled
   * would be a bill for the wrong amount.
   *
   * @remarks `couponCode` is passed through because the discount figure is meaningless
   * without the code that produced it: a retry under a different code must rewrite both,
   * never one.
   */
  applyTotals(totals: ComputedTotals, now: Date = new Date(), couponCode?: string | null): void {
    this.props.lines = totals.lines.map((line) => ({ ...line }));
    this.props.subtotalMinor = totals.subtotalMinor;
    this.props.discountMinor = totals.discountMinor;
    this.props.taxMinor = totals.taxMinor;
    this.props.shippingMinor = totals.shippingMinor;
    this.props.totalMinor = totals.totalMinor;
    this.props.currency = totals.currency;
    if (couponCode !== undefined) {
      this.props.couponCode = couponCode;
    }
    this.bump(now);
  }

  /**
   * Marks the bill settled.
   *
   * @remarks Refuses on a void invoice: money cannot be collected against a bill that
   * has been written off, and silently resurrecting it would rewrite a refund decision.
   */
  markPaid(now: Date = new Date()): void {
    if (this.props.status === 'void') {
      throw new ValidationException('a void invoice cannot be paid', {
        invoiceId: this.id,
        orderId: this.props.orderId,
      });
    }
    if (this.props.status === 'paid') return;

    this.props.status = 'paid';
    this.bump(now);
  }

  /**
   * Writes the bill off after a full refund.
   *
   * @remarks Terminal by choice: `invoices.order_id` is unique, so a void invoice is the
   * only record of that order's billing, and keeping it rather than deleting it is what
   * lets a later audit see that the order was billed and then fully refunded.
   */
  markVoid(now: Date = new Date()): void {
    if (this.props.status === 'void') return;

    this.props.status = 'void';
    this.bump(now);
  }

  /** The same aggregate, flattened the way persistence hands it back. */
  toRow(): InvoiceRow {
    return {
      id: this.id,
      order_id: this.props.orderId,
      status: this.props.status,
      subtotal_minor: this.props.subtotalMinor,
      discount_minor: this.props.discountMinor,
      tax_minor: this.props.taxMinor,
      shipping_minor: this.props.shippingMinor,
      total_minor: this.props.totalMinor,
      currency: this.props.currency,
      coupon_code: this.props.couponCode,
      country: this.props.country,
      issued_at: this.props.issuedAt,
      version: this.props.version,
      created_at: this.createdAt,
      updated_at: this.updatedAt,
    };
  }

  /** Columns an update may write. `id`, `order_id` and `created_at` never move. */
  toUpdate(): {
    status: string;
    subtotal_minor: number;
    discount_minor: number;
    tax_minor: number;
    shipping_minor: number;
    total_minor: number;
    currency: string;
    coupon_code: string | null;
    country: string | null;
    issued_at: Date | null;
    version: number;
    updated_at: Date;
  } {
    return {
      status: this.props.status,
      subtotal_minor: this.props.subtotalMinor,
      discount_minor: this.props.discountMinor,
      tax_minor: this.props.taxMinor,
      shipping_minor: this.props.shippingMinor,
      total_minor: this.props.totalMinor,
      currency: this.props.currency,
      coupon_code: this.props.couponCode,
      country: this.props.country,
      issued_at: this.props.issuedAt,
      version: this.props.version,
      updated_at: this.updatedAt,
    };
  }

  /** Line rows for a full rewrite of `invoice_lines`. */
  toLineRows(): Omit<InvoiceLineRow, 'id' | 'invoice_id'>[] {
    return this.props.lines.map((line) => ({
      sku: line.sku,
      quantity: line.quantity,
      unit_price_minor: line.unitPriceMinor,
      line_subtotal_minor: line.lineSubtotalMinor,
      tax_minor: line.taxMinor,
    }));
  }

  /** The payload contract, as `InvoicePayload` spells it. */
  toPayload(): {
    invoiceId: string;
    orderId: string;
    totalMinor: number;
    taxMinor: number;
    shippingMinor: number;
    discountMinor: number;
    currency: string;
    couponCode?: string;
  } {
    return {
      invoiceId: this.id,
      orderId: this.props.orderId,
      totalMinor: this.props.totalMinor,
      taxMinor: this.props.taxMinor,
      shippingMinor: this.props.shippingMinor,
      discountMinor: this.props.discountMinor,
      currency: this.props.currency,
      ...(this.props.couponCode ? { couponCode: this.props.couponCode } : {}),
    };
  }

  private bump(now: Date): void {
    this.props.version += 1;
    this.updatedAt = now;
  }
}

/** A status this build knows how to act on. Anything else reads as draft. */
export const isInvoiceStatus = (value: string): value is InvoiceStatus =>
  value === 'draft' || value === 'issued' || value === 'paid' || value === 'void';
