/**
 * @fileoverview Storage port for the inventory use cases.
 *
 * @remarks Declared in the domain and implemented in infrastructure so the handlers can
 * ask for a reserve, a release, a shipment or an adjustment without knowing that Postgres
 * exists — and so a unit test can answer with a plain object instead of a database.
 *
 * @remarks The port is deliberately coarse. `reserveForOrder` is one method rather than
 * `findStock` + `lockStock` + `writeStock` because the all-or-nothing guarantee *is* the
 * transaction: split it across calls and every caller has to re-implement the locking, the
 * ordering and the rollback, and the first one that forgets a step oversells.
 */
import type { StockAvailability } from '../stock-level.aggregate';

export const INVENTORY_REPOSITORY = Symbol('INVENTORY_REPOSITORY');

export interface ReserveLineInput {
  readonly sku: string;
  readonly qty: number;
}

export interface ReservedLineResult {
  readonly sku: string;
  readonly qty: number;
  readonly reservationId: string;
}

export interface RejectedLineResult {
  readonly sku: string;
  readonly qty: number;
  readonly reason: string;
}

export interface ReserveResult {
  readonly fullyAccepted: boolean;
  readonly reserved: readonly ReservedLineResult[];
  readonly rejected: readonly RejectedLineResult[];
  /**
   * `true` when an existing hold for this order answered the call.
   *
   * @remarks Lets a caller tell "your retry landed on the hold you already made" apart from
   * "we just reserved this" — the two look identical on the wire and mean different things
   * in a log.
   */
  readonly replayed: boolean;
}

export interface ReleaseResult {
  /** Lines actually given back. `0` when there was nothing to release. */
  readonly releasedLines: number;
}

export interface ShipResult {
  readonly shipped: boolean;
}

export interface AdjustResult {
  readonly onHand: number;
  readonly available: number;
  /** `true` when this `adjustment_id` had already been applied. */
  readonly replayed: boolean;
}

export interface AdjustStockInput {
  readonly sku: string;
  readonly warehouseId: string;
  readonly delta: number;
  readonly reason: string;
  readonly adjustmentId: string;
  /** Safety stock written onto the row when this adjustment creates it. */
  readonly safetyDefault: number;
}

export interface InventoryRepositoryPort {
  /**
   * Reserves every line for an order, or none of them.
   *
   * @remarks Idempotent on `order_id`: an existing **active** hold is returned as
   * `fullyAccepted` with its own lines and nothing is written. A hold that is already
   * `released` or `shipped` is refused — `order_id` is unique, so there is no second hold
   * to create, and silently resurrecting a released hold would undo a cancellation.
   *
   * @remarks Atomicity is this method's job: rows are locked with `SELECT ... FOR UPDATE`
   * in ascending `sku` order inside one interactive transaction, every line is evaluated
   * against the locked rows, and only an all-clear writes. Partial acceptance cannot
   * happen because there is no path that writes a subset.
   */
  reserveForOrder(input: {
    readonly orderId: string;
    /** Required: a reserve writes into a warehouse, so there is no "no warehouse" case. */
    readonly warehouseId: string;
    readonly lines: readonly ReserveLineInput[];
  }): Promise<ReserveResult>;

  /**
   * Gives back everything the order still holds.
   *
   * @remarks Idempotent: no active hold means `releasedLines: 0` and no writes at all.
   * `warehouseId` is checked only when the caller actually names one — an empty value
   * means "whatever the hold is in", which is what a caller that does not track
   * warehouses should get.
   */
  releaseOrder(input: {
    readonly orderId: string;
    readonly warehouseId?: string;
  }): Promise<ReleaseResult>;

  /**
   * Consumes the requested lines out of the order's hold and off the shelf.
   *
   * @remarks Refuses when there is no active hold, when the hold does not cover the
   * request, or when the named warehouse is not the one the hold is in.
   */
  shipOrder(input: {
    readonly orderId: string;
    readonly warehouseId?: string;
    readonly lines: readonly ReserveLineInput[];
  }): Promise<ShipResult>;

  /**
   * Applies a signed correction, once per `adjustmentId`.
   *
   * @remarks Idempotent on `adjustment_id`: a repeat returns the current figures with
   * `replayed: true` and writes nothing — no second adjustment row, no second
   * `stock.changed`.
   */
  adjustStock(input: AdjustStockInput): Promise<AdjustResult>;

  /**
   * Reads one `(sku, warehouse_id)` pair.
   *
   * @remarks A missing row answers zeros rather than a 404: "nothing has ever been stocked
   * here" is a fact, not a failure, and every caller already has to handle a zero.
   */
  getAvailable(sku: string, warehouseId: string): Promise<StockAvailability>;

  /** Live hold count — the readiness probe's question: "can this service still work?" */
  countActiveReservations(): Promise<number>;
}
