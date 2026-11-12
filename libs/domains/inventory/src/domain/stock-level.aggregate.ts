/**
 * @fileoverview The stock level aggregate: the one place a unit becomes sellable or not.
 *
 * @remarks One aggregate per `(sku, warehouse_id)`. Availability is **derived** —
 * `on_hand - reserved - safety` — and never stored: a stored `available` would drift from
 * its own inputs the moment a reserve and an adjustment commit in different orders, and
 * the whole point of this aggregate is that the number cannot drift.
 *
 * @remarks The aggregate owns the per-row invariants (never negative, never below what is
 * already promised). It deliberately does **not** own the multi-line, all-or-nothing rule
 * of a reserve: that spans several rows, so it belongs to the transaction in the
 * repository, which locks them in a fixed order first.
 *
 * @remarks `version` is overridden out of `AggregateRoot`: the base implementation counts
 * *buffered* events and reads `0` right after `clearDomainEvents()`, which would make two
 * different `stock.changed` rows share one `dedup_key` and the second be dropped.
 */
import { AggregateRoot, Ensure } from '@auth/core';
import { ValidationException } from '@auth/platform/error-handling';
import { StockChanged } from './inventory.events';

export interface StockLevelProps {
  sku: string;
  warehouseId: string;
  onHand: number;
  reserved: number;
  safety: number;
  /** Write counter, and the version tail of `stock.changed`. Not a stream position. */
  version: number;
}

/**
 * One `stock_levels` row, exactly as the column names spell it.
 *
 * @remarks Declared here rather than in the repository so `fromRow` and the write path
 * agree by construction, and so a test double can be built without importing Prisma: the
 * domain must not know the transport, but it can know the shape of its own storage.
 */
export interface StockLevelRow {
  id: string;
  sku: string;
  warehouse_id: string;
  on_hand: number;
  reserved: number;
  safety: number;
  version: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * The derived availability of one `(sku, warehouse_id)` pair, as every reader sees it.
 *
 * @remarks A read model rather than a stored shape: `available` is computed, never
 * persisted, so this is the only place the six figures of a stock row are put together
 * for a caller.
 */
export interface StockAvailability {
  readonly sku: string;
  readonly warehouseId: string;
  readonly onHand: number;
  readonly reserved: number;
  readonly safety: number;
  readonly available: number;
}

export class StockLevel extends AggregateRoot<string> {
  private constructor(
    id: string,
    private readonly props: StockLevelProps,
    createdAt: Date,
    updatedAt: Date,
  ) {
    super(id, createdAt, updatedAt, null);
  }

  /** A row that does not exist yet: created by the first adjustment, never by a reserve. */
  static create(input: {
    sku: string;
    warehouseId: string;
    safety: number;
    id?: string;
    onHand?: number;
    now?: Date;
  }): StockLevel {
    Ensure.notEmpty(input.sku, 'sku');
    Ensure.notEmpty(input.warehouseId, 'warehouseId');
    Ensure.nonNegative(input.safety, 'safety');

    const now = input.now ?? new Date();
    const onHand = input.onHand ?? 0;
    Ensure.nonNegative(onHand, 'onHand');

    return new StockLevel(
      input.id ?? crypto.randomUUID(),
      {
        sku: input.sku,
        warehouseId: input.warehouseId,
        onHand,
        reserved: 0,
        safety: input.safety,
        version: 1,
      },
      now,
      now,
    );
  }

  /** Rehydration from persistence. Does not emit events — the write already happened. */
  static fromRow(row: StockLevelRow): StockLevel {
    return new StockLevel(
      row.id,
      {
        sku: row.sku,
        warehouseId: row.warehouse_id,
        onHand: row.on_hand,
        reserved: row.reserved,
        safety: row.safety,
        version: row.version,
      },
      row.created_at,
      row.updated_at,
    );
  }

  get sku(): string {
    return this.props.sku;
  }

  get warehouseId(): string {
    return this.props.warehouseId;
  }

  get onHand(): number {
    return this.props.onHand;
  }

  get reserved(): number {
    return this.props.reserved;
  }

  get safety(): number {
    return this.props.safety;
  }

  /**
   * What may still be sold.
   *
   * @remarks Derived, and allowed to go negative when safety stock exceeds what is on
   * hand: that is not corruption, it is the ledger saying "the buffer alone is bigger than
   * the shelf", and {@link reserve} treats it exactly like zero.
   */
  get available(): number {
    return this.props.onHand - this.props.reserved - this.props.safety;
  }

  /**
   * Position of this row in its own write stream.
   *
   * @remarks Not the number of buffered events: `stock.changed` carries this number as its
   * `version`, and two events with the same `(type, dedup_key)` means the second is
   * silently skipped by the outbox.
   */
  override get version(): number {
    return this.props.version;
  }

  /**
   * Holds `qty` more units for an order.
   *
   * @remarks All-or-nothing at the row level: an insufficient row refuses outright rather
   * than taking what it can. The caller has already locked the row, so "partially
   * reserved" cannot be observed by anyone — but refusing here keeps the invariant in the
   * aggregate rather than in the SQL that surrounds it.
   *
   * @remarks Emits no event. A reservation announces itself as `stock.reserved`, keyed by
   * order; a second `stock.changed` for the same fact would give consumers two sources of
   * truth for the same number.
   */
  reserve(qty: number, now: Date = new Date()): void {
    this.assertPositiveQty(qty);

    if (this.available < qty) {
      throw new ValidationException('insufficient stock', {
        sku: this.props.sku,
        warehouseId: this.props.warehouseId,
        requested: qty,
        available: this.available,
      });
    }

    this.props.reserved += qty;
    this.bump(now);
  }

  /**
   * Returns `qty` units from the reservation pool.
   *
   * @remarks Floored at zero rather than throwing: a release is retried by every piece of
   * order-side tooling that queues a "cancel this order" job, and a second release of
   * stock that is already back must not fail the caller or drive `reserved` negative.
   */
  release(qty: number, now: Date = new Date()): void {
    this.assertPositiveQty(qty);
    this.props.reserved = Math.max(0, this.props.reserved - qty);
    this.bump(now);
  }

  /**
   * Consumes `qty` units out of stock as the order ships.
   *
   * @remarks Both counters move together: the units leave the shelf *and* stop being
   * promised. Checking `reserved` as well as `onHand` refuses a ship that would take more
   * than was ever held — the case where the caller invents a quantity the ledger never
   * agreed to.
   */
  ship(qty: number, now: Date = new Date()): void {
    this.assertPositiveQty(qty);

    if (this.props.onHand < qty) {
      throw new ValidationException('cannot ship more than is on hand', {
        sku: this.props.sku,
        warehouseId: this.props.warehouseId,
        requested: qty,
        onHand: this.props.onHand,
      });
    }
    if (this.props.reserved < qty) {
      throw new ValidationException('cannot ship more than is reserved', {
        sku: this.props.sku,
        warehouseId: this.props.warehouseId,
        requested: qty,
        reserved: this.props.reserved,
      });
    }

    this.props.onHand -= qty;
    this.props.reserved -= qty;
    this.bump(now);
  }

  /**
   * Applies a signed correction to `on_hand`.
   *
   * @remarks A correction may be negative (a breakage, a recount) but the result may never
   * fall below zero or below what is already promised to live reservations: either would
   * make `reserved` unbacked, which is the oversell this whole service exists to prevent.
   *
   * @remarks The only transition that announces `stock.changed`: an adjustment is a fact
   * about the row itself, with no reservation event to carry it.
   */
  adjust(delta: number, now: Date = new Date()): void {
    if (!Number.isSafeInteger(delta)) {
      throw new ValidationException('adjustment delta must be an integer', { delta });
    }

    const nextOnHand = this.props.onHand + delta;

    if (nextOnHand < 0) {
      throw new ValidationException('adjustment would take on_hand below zero', {
        sku: this.props.sku,
        warehouseId: this.props.warehouseId,
        onHand: this.props.onHand,
        delta,
      });
    }
    if (nextOnHand < this.props.reserved) {
      throw new ValidationException('adjustment would take on_hand below reserved', {
        sku: this.props.sku,
        warehouseId: this.props.warehouseId,
        onHand: this.props.onHand,
        reserved: this.props.reserved,
        delta,
      });
    }

    this.props.onHand = nextOnHand;
    this.bump(now);

    this.addDomainEvent(
      new StockChanged(
        this.props.sku,
        {
          sku: this.props.sku,
          warehouseId: this.props.warehouseId,
          onHand: this.props.onHand,
          reserved: this.props.reserved,
          available: this.available,
        },
        this.props.version,
      ),
    );
  }

  /** The same aggregate, flattened the way persistence hands it back. */
  toRow(): StockLevelRow {
    return {
      id: this.id,
      sku: this.props.sku,
      warehouse_id: this.props.warehouseId,
      on_hand: this.props.onHand,
      reserved: this.props.reserved,
      safety: this.props.safety,
      version: this.props.version,
      created_at: this.createdAt,
      updated_at: this.updatedAt,
    };
  }

  /** Columns an update may write. `id`, `sku`, `warehouse_id` and `created_at` never move. */
  toUpdate(): {
    on_hand: number;
    reserved: number;
    safety: number;
    version: number;
    updated_at: Date;
  } {
    return {
      on_hand: this.props.onHand,
      reserved: this.props.reserved,
      safety: this.props.safety,
      version: this.props.version,
      updated_at: this.updatedAt,
    };
  }

  private assertPositiveQty(qty: number): void {
    if (!Number.isSafeInteger(qty) || qty <= 0) {
      throw new ValidationException('quantity must be a positive integer', { qty });
    }
  }

  /**
   * Every mutation goes through here, so `version` can never lag behind a write.
   *
   * @remarks It advances even when no event is emitted (a reserve, a release, a ship):
   * `version` counts *writes*, which is what makes it usable as an optimistic-concurrency
   * token, while the event stream decides what is announced.
   */
  private bump(now: Date): void {
    this.props.version += 1;
    this.updatedAt = now;
  }
}
