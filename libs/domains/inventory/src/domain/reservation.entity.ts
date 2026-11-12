/**
 * @fileoverview The reservation: one order's hold on stock, and the lines that compose it.
 *
 * @remarks A child entity of the order, not a second root: `reservations.order_id` is
 * unique, so an order has exactly one hold and every transition of that hold is a
 * transition of this entity. Its events are keyed by **order id** for the same reason —
 * the saga that consumes them reasons per order.
 *
 * @remarks `lines[].qty` is what is *still* held, not what was originally requested. Ship
 * decrements it and release zeroes it, which makes "are there any active lines left?" the
 * single test for "is this hold finished" without a second table.
 *
 * @remarks `version` is overridden out of `AggregateRoot` for the same reason as
 * `StockLevel`: the base counts buffered events, and a version that resets after
 * `clearDomainEvents()` would collide `dedup_key`s.
 */
import { AggregateRoot, Ensure } from '@auth/core';
import { InvalidStateTransitionException, ValidationException } from '@auth/platform/error-handling';
import { stockReleasedEvent, stockReservedEvents } from './inventory.events';

export type ReservationStatus = 'active' | 'released' | 'shipped';

/** Statuses a reservation can never leave. */
export const TERMINAL_RESERVATION_STATUSES: ReadonlySet<ReservationStatus> = new Set([
  'released',
  'shipped',
]);

export interface ReservationLine {
  sku: string;
  /** Units still held by this line. Zero means the line has been fully shipped or released. */
  qty: number;
}

export interface ReservationProps {
  orderId: string;
  warehouseId: string;
  status: ReservationStatus;
  lines: ReservationLine[];
  /** Write counter; the tail of every `reservation`-scoped dedup_key is not taken from it. */
  version: number;
}

/** One `reservations` row. */
export interface ReservationRow {
  id: string;
  order_id: string;
  warehouse_id: string;
  status: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

/** One `reservation_lines` row. */
export interface ReservationLineRow {
  id: string;
  reservation_id: string;
  sku: string;
  qty: number;
}

export class Reservation extends AggregateRoot<string> {
  private constructor(
    id: string,
    private readonly props: ReservationProps,
    createdAt: Date,
    updatedAt: Date,
  ) {
    super(id, createdAt, updatedAt, null);
  }

  static create(input: {
    orderId: string;
    warehouseId: string;
    lines: readonly { sku: string; qty: number }[];
    id?: string;
    now?: Date;
  }): Reservation {
    Ensure.notEmpty(input.orderId, 'orderId');
    Ensure.notEmpty(input.warehouseId, 'warehouseId');
    Ensure.isTrue(input.lines.length > 0, 'a reservation needs at least one line');

    const now = input.now ?? new Date();

    return new Reservation(
      input.id ?? crypto.randomUUID(),
      {
        orderId: input.orderId,
        warehouseId: input.warehouseId,
        status: 'active',
        lines: input.lines.map((line) => ({ sku: line.sku, qty: line.qty })),
        version: 1,
      },
      now,
      now,
    );
  }

  static fromRow(row: ReservationRow, lines: readonly ReservationLineRow[]): Reservation {
    return new Reservation(
      row.id,
      {
        orderId: row.order_id,
        warehouseId: row.warehouse_id,
        // Sanitised rather than validated: a row written by a *newer* build may carry a
        // status this one does not know, and refusing to load it would turn a routine
        // rollout into an outage of every read for that order. An unknown status is read
        // as `active`, which is the only choice that cannot silently release or ship stock.
        status: isReservationStatus(row.status) ? row.status : 'active',
        lines: lines.map((line) => ({ sku: line.sku, qty: line.qty })),
        version: row.version,
      },
      row.created_at,
      row.updated_at,
    );
  }

  get orderId(): string {
    return this.props.orderId;
  }

  get warehouseId(): string {
    return this.props.warehouseId;
  }

  get status(): ReservationStatus {
    return this.props.status;
  }

  get lines(): readonly ReservationLine[] {
    return this.props.lines;
  }

  override get version(): number {
    return this.props.version;
  }

  get isActive(): boolean {
    return this.props.status === 'active';
  }

  /** Lines that still hold stock. A shipped-to-zero line stays as the record of what shipped. */
  get activeLines(): readonly ReservationLine[] {
    return this.props.lines.filter((line) => line.qty > 0);
  }

  /**
   * Announces every line this hold created.
   *
   * @remarks One event per line, versions `1..n` — see {@link stockReservedEvents} for why
   * the index is what keeps `dedup_key` unique inside a single batch.
   */
  announceReserved(now: Date = new Date()): void {
    const events = stockReservedEvents({
      orderId: this.props.orderId,
      warehouseId: this.props.warehouseId,
      reservationId: this.id,
      lines: this.props.lines,
    });

    for (const event of events) {
      this.addDomainEvent(event);
    }

    this.updatedAt = now;
  }

  /**
   * Drops everything still held and marks the hold released.
   *
   * @remarks Terminal: a second release is a **no-op** that changes nothing and announces
   * nothing. Release is retried by every cancel path in the system, and a second
   * `stock.released` would tell consumers stock came back twice.
   *
   * @returns how many lines were actually released, so the caller can decide whether the
   * single `stock.released` event is warranted at all.
   */
  releaseAll(now: Date = new Date()): number {
    if (!this.isActive) return 0;

    const released = this.activeLines.length;
    if (released === 0) return 0;

    for (const line of this.props.lines) {
      line.qty = 0;
    }
    this.props.status = 'released';
    this.bump(now);

    this.addDomainEvent(
      stockReleasedEvent({
        orderId: this.props.orderId,
        warehouseId: this.props.warehouseId,
        lines: released,
      }),
    );

    return released;
  }

  /**
   * Consumes `qty` units of one line out of this hold.
   *
   * @remarks Refuses rather than partially shipping: a shipment the reservation never
   * agreed to is a discrepancy between the warehouse and the ledger, and the honest
   * answer is a 400 that names the shortfall.
   *
   * @remarks When no line is left holding anything the hold becomes `shipped`; a
   * partially shipped hold stays `active` so the remainder can still ship or be released.
   */
  shipLine(sku: string, qty: number, now: Date = new Date()): void {
    if (!this.isActive) {
      throw new InvalidStateTransitionException(
        `reservation for order ${this.props.orderId} is ${this.props.status} and cannot ship`,
        { orderId: this.props.orderId, status: this.props.status },
      );
    }
    if (!Number.isSafeInteger(qty) || qty <= 0) {
      throw new ValidationException('quantity must be a positive integer', { sku, qty });
    }

    const line = this.props.lines.find((candidate) => candidate.sku === sku && candidate.qty > 0);

    if (!line || line.qty < qty) {
      throw new ValidationException('reservation does not cover the requested shipment', {
        orderId: this.props.orderId,
        sku,
        requested: qty,
        held: line?.qty ?? 0,
      });
    }

    line.qty -= qty;
    this.bump(now);

    if (this.activeLines.length === 0) {
      this.props.status = 'shipped';
    }
  }

  /** Columns an update may write. `id`, `order_id` and `created_at` never move. */
  toUpdate(): { status: string; version: number; updated_at: Date } {
    return {
      status: this.props.status,
      version: this.props.version,
      updated_at: this.updatedAt,
    };
  }

  private bump(now: Date): void {
    this.props.version += 1;
    this.updatedAt = now;
  }
}

/** A status this build knows how to act on. Anything else is read as `active`. */
export const isReservationStatus = (value: string): value is ReservationStatus =>
  value === 'active' || TERMINAL_RESERVATION_STATUSES.has(value as ReservationStatus);
