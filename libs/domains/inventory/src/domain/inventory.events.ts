/**
 * @fileoverview Inventory's domain events and the factories that build them.
 *
 * @remarks Event *classes* live here so the aggregate can announce a fact without the
 * repository having to know the event type strings; the topic mapping stays in
 * infrastructure, because a topic is a transport contract and a domain event is not.
 *
 * @remarks Versioning is the load-bearing part of this file. `dedup_key` is
 * `<type>:<aggregateId>:<version>`, and the unique index on `(dedup_key, type)` is what
 * turns a retried command into a no-op. Two events sharing a key means the second one is
 * silently dropped by `createMany(skipDuplicates)` — so every factory below states
 * explicitly what its version counts.
 */
import { DomainEvent } from '@auth/core';
import type {
  StockChangedPayload,
  StockReleasedPayload,
  StockRejectedPayload,
  StockReservedPayload,
} from '@auth/contracts';

/** Aggregate type recorded on reservation-scoped events. */
export const RESERVATION_AGGREGATE = 'Reservation';

/** Aggregate type recorded on stock-row-scoped events. */
export const STOCK_LEVEL_AGGREGATE = 'StockLevel';

/**
 * One line was held for an order.
 *
 * @remarks `aggregateId` is the **order**, not the reservation: the consumer that cares
 * (the order saga) subscribes per order, and a partition key of reservation id would
 * scatter one order's decisions across partitions where they can be reordered.
 */
export class StockReserved extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: StockReservedPayload,
    version = 1,
  ) {
    super(aggregateId, RESERVATION_AGGREGATE, 'stock.reserved', version);
  }
}

/** One line could not be held, and nothing was written for the order. */
export class StockRejected extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: StockRejectedPayload,
    version = 1,
  ) {
    super(aggregateId, RESERVATION_AGGREGATE, 'stock.rejected', version);
  }
}

/** An order's hold on its stock was dropped. */
export class StockReleased extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: StockReleasedPayload,
    version = 1,
  ) {
    super(aggregateId, RESERVATION_AGGREGATE, 'stock.released', version);
  }
}

/** A stock row changed for a reason no reservation event describes (an adjustment). */
export class StockChanged extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: StockChangedPayload,
    version = 1,
  ) {
    super(aggregateId, STOCK_LEVEL_AGGREGATE, 'stock.changed', version);
  }
}

/** A rejected reserve line, as the payload contract spells it. */
export interface RejectedLineInput {
  readonly sku: string;
  readonly qty: number;
}

/**
 * One `stock.reserved` per accepted line, versions `1..n`.
 *
 * @remarks The version is the **1-based index of the line in this batch**, not the
 * reservation's version column. Every event of one reserve shares `aggregateId = orderId`,
 * so a version taken from the aggregate would be `1` for all of them: the first row would
 * land and `createMany(skipDuplicates)` would swallow the rest, and the order would be told
 * it holds stock it was never told about. Indexing the lines makes each key unique —
 * `stock.reserved:<orderId>:1`, `stock.reserved:<orderId>:2` — and still deterministic, so
 * a retry of the same reserve produces the same keys and is deduplicated as a whole.
 *
 * @remarks The batch is all-or-nothing, so reserved and rejected lines never coexist in
 * one transaction and their index sequences cannot collide. The `type` half of the unique
 * index would separate them anyway.
 */
export function stockReservedEvents(input: {
  readonly orderId: string;
  readonly warehouseId: string;
  readonly reservationId: string;
  readonly lines: readonly { readonly sku: string; readonly qty: number }[];
}): readonly StockReserved[] {
  return input.lines.map(
    (line, index) =>
      new StockReserved(
        input.orderId,
        {
          orderId: input.orderId,
          sku: line.sku,
          qty: line.qty,
          reservationId: input.reservationId,
          warehouseId: input.warehouseId,
        },
        index + 1,
      ),
  );
}

/**
 * One `stock.rejected` per refused line, versions `1..m`.
 *
 * @remarks Same index rule as {@link stockReservedEvents}: a rejection has no reservation
 * row to hang a version off, and a batch of refused lines must not collapse into a single
 * `dedup_key`.
 *
 * @remarks There is no aggregate to buffer these — an all-or-nothing rejection writes no
 * reservation and no stock — so the repository builds them here and hands them straight to
 * the outbox inside the same transaction.
 */
export function stockRejectedEvents(input: {
  readonly orderId: string;
  readonly warehouseId: string;
  readonly lines: readonly RejectedLineInput[];
}): readonly StockRejected[] {
  return input.lines.map(
    (line, index) =>
      new StockRejected(
        input.orderId,
        {
          orderId: input.orderId,
          sku: line.sku,
          qty: line.qty,
          reason: 'insufficient_stock',
          warehouseId: input.warehouseId,
        },
        index + 1,
      ),
  );
}

/**
 * The single `stock.released` of a release pass.
 *
 * @remarks Always version `1`: a release is one fact about one order, and the reservation
 * it follows is terminal — there is no second release of the same order to version.
 */
export function stockReleasedEvent(input: {
  readonly orderId: string;
  readonly warehouseId: string;
  readonly lines: number;
}): StockReleased {
  return new StockReleased(
    input.orderId,
    {
      orderId: input.orderId,
      warehouseId: input.warehouseId,
      lines: input.lines,
    },
    1,
  );
}
