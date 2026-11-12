/**
 * @fileoverview The Prisma implementation of the inventory port, including the outbox.
 *
 * @remarks This is where atomicity lives. `reserveForOrder`, `releaseOrder`, `shipOrder`
 * and `adjustStock` each run inside one interactive transaction, so the stock rows, the
 * reservation rows and the `outbox_events` rows either all commit or none of them do —
 * which is the only way "we told the order side we held its stock" can be a true
 * statement.
 *
 * @remarks Multi-line writes take `SELECT ... FOR UPDATE` locks in **ascending `sku`
 * order**. Two concurrent reserves that touch overlapping SKUs in different request orders
 * would otherwise deadlock: A holds SKU-1 and waits for SKU-2 while B holds SKU-2 and
 * waits for SKU-1. Sorting the lock acquisition removes the cycle — every transaction
 * acquires the same lock in the same order, so one simply waits.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type PrismaService } from '@auth/infra/prisma';
import { Topics } from '@auth/contracts';
import {
  InvalidStateTransitionException,
  ValidationException,
} from '@auth/platform/error-handling';
import type { PrismaClient } from '../../generated/prisma/client';
import {
  StockLevel,
  type StockAvailability,
  type StockLevelRow,
} from '../../domain/stock-level.aggregate';
import {
  Reservation,
  type ReservationLineRow,
  type ReservationRow,
} from '../../domain/reservation.entity';
import { stockRejectedEvents } from '../../domain/inventory.events';
import {
  INVENTORY_REPOSITORY,
  type AdjustResult,
  type AdjustStockInput,
  type InventoryRepositoryPort,
  type RejectedLineResult,
  type ReleaseResult,
  type ReserveLineInput,
  type ReserveResult,
  type ShipResult,
} from '../../domain/ports/inventory-repository.port';
import { INVENTORY_PRISMA } from '../../inventory.config';
import { enqueueEvents } from './outbox-enqueue';

/**
 * The `stock.*` -> `platform.stock.*.v1` mapping.
 *
 * @remarks Domain events name facts in the domain's language; topics are a transport
 * contract. Keeping the translation in one function means adding an event cannot
 * accidentally invent a topic name that no consumer subscribes to.
 */
const INVENTORY_TOPICS: Readonly<Record<string, string>> = {
  'stock.reserved': Topics.STOCK_RESERVED,
  'stock.rejected': Topics.STOCK_REJECTED,
  'stock.released': Topics.STOCK_RELEASED,
  'stock.changed': Topics.STOCK_CHANGED,
};

/** Row shape `SELECT ... FOR UPDATE` returns, aliased to the domain's own row type. */
type LockedRow = StockLevelRow;

@Injectable()
export class PrismaInventoryRepository implements InventoryRepositoryPort {
  private readonly logger = new Logger(PrismaInventoryRepository.name);

  constructor(
    @Inject(INVENTORY_PRISMA) private readonly prisma: PrismaService<PrismaClient>,
  ) {}

  async reserveForOrder(input: {
    orderId: string;
    warehouseId: string;
    lines: readonly ReserveLineInput[];
  }): Promise<ReserveResult> {
    // Aggregated before the transaction opens: a request that names the same SKU twice is
    // evaluated against the *sum*, so two half-covered lines cannot both pass the check
    // against the same units. The response reports the aggregated quantities for the same
    // reason — a caller must not be told it holds 4 when the ledger holds 4 in total.
    const totals = sumBySku(input.lines);
    const skus = [...totals.keys()].sort();

    return this.prisma.runInTransaction(async (client) => {
      const existing = await client.reservations.findUnique({
        where: { order_id: input.orderId },
        include: { lines: true },
      });

      if (existing) {
        return this.replayExistingReservation(existing);
      }

      // Locked one SKU at a time, ascending: see the file header for why the order is the
      // whole deadlock story. A SKU with no row takes no lock and is treated as empty —
      // nothing has ever been stocked here, so nothing may be reserved from here.
      const levels = new Map<string, StockLevel>();
      for (const sku of skus) {
        const rows = await client.$queryRaw<LockedRow[]>`
          SELECT id, sku, warehouse_id, on_hand, reserved, safety, version, created_at, updated_at
            FROM stock_levels
           WHERE sku = ${sku}
             AND warehouse_id = ${input.warehouseId}
           FOR UPDATE
        `;
        const row = rows[0];
        if (row) levels.set(sku, StockLevel.fromRow(row));
      }

      // All-or-nothing evaluation against the locked rows: one refusal refuses the batch.
      const rejected: RejectedLineResult[] = [];
      const accepted: { sku: string; qty: number }[] = [];

      for (const sku of skus) {
        const qty = totals.get(sku) ?? 0;
        const level = levels.get(sku);

        if (!level || level.available < qty) {
          rejected.push({ sku, qty, reason: 'insufficient_stock' });
        } else {
          accepted.push({ sku, qty });
        }
      }

      if (rejected.length > 0) {
        // Stock and the hold are untouched — that is what all-or-nothing means. The
        // refusal itself is still announced: the order side learns "your reserve was
        // refused" from `stock.rejected`, not from polling this table.
        await enqueueEvents(
          stockRejectedEvents({
            orderId: input.orderId,
            warehouseId: input.warehouseId,
            lines: rejected,
          }),
          { client, logger: this.logger, topics: INVENTORY_TOPICS },
        );

        return { fullyAccepted: false, reserved: [], rejected, replayed: false };
      }

      const now = new Date();
      const reservation = Reservation.create({
        orderId: input.orderId,
        warehouseId: input.warehouseId,
        lines: accepted,
        now,
      });

      for (const line of accepted) {
        const level = levels.get(line.sku);
        // Unreachable: `accepted` was only filled for SKUs that passed the check above.
        // Thrown rather than defaulted so a future edit that weakens the check fails here
        // instead of writing a negative hold.
        if (!level) {
          throw new ValidationException('stock row vanished inside the transaction', {
            sku: line.sku,
            warehouseId: input.warehouseId,
          });
        }

        level.reserve(line.qty, now);
        await client.stock_levels.update({
          where: { id: level.id },
          data: level.toUpdate(),
        });
      }

      await client.reservations.create({
        data: {
          id: reservation.id,
          order_id: reservation.orderId,
          warehouse_id: reservation.warehouseId,
          status: reservation.status,
          version: reservation.version,
          created_at: now,
          updated_at: now,
        },
      });

      await client.reservation_lines.createMany({
        data: accepted.map((line) => ({
          id: crypto.randomUUID(),
          reservation_id: reservation.id,
          sku: line.sku,
          qty: line.qty,
        })),
      });

      reservation.announceReserved(now);
      await enqueueEvents(reservation.clearDomainEvents(), {
        client,
        logger: this.logger,
        topics: INVENTORY_TOPICS,
      });

      return {
        fullyAccepted: true,
        reserved: accepted.map((line) => ({
          sku: line.sku,
          qty: line.qty,
          reservationId: reservation.id,
        })),
        rejected: [],
        replayed: false,
      };
    });
  }

  async releaseOrder(input: {
    orderId: string;
    warehouseId?: string;
  }): Promise<ReleaseResult> {
    return this.prisma.runInTransaction(async (client) => {
      const existing = await client.reservations.findUnique({
        where: { order_id: input.orderId },
        include: { lines: true },
      });

      // No hold at all, or a hold that already finished: both are "nothing to give back",
      // and both answer without a single write. Release is retried by every cancel path,
      // so a second call must not fail and must not announce a second `stock.released`.
      if (!existing || existing.status !== 'active') {
        return { releasedLines: 0 };
      }

      this.assertWarehouseMatches(existing.warehouse_id, input.warehouseId, input.orderId);

      const reservation = Reservation.fromRow(existing, existing.lines);
      const held = reservation.activeLines;

      if (held.length === 0) {
        // An active hold with no quantity left is already spent; there is nothing to
        // return to the shelf.
        return { releasedLines: 0 };
      }

      const levels = await this.lockLevels(
        client,
        held.map((line) => line.sku),
        existing.warehouse_id,
      );

      const now = new Date();

      for (const line of held) {
        const level = levels.get(line.sku);
        if (!level) continue;
        level.release(line.qty, now);
        await client.stock_levels.update({
          where: { id: level.id },
          data: level.toUpdate(),
        });
      }

      const releasedLines = reservation.releaseAll(now);

      await client.reservations.update({
        where: { id: existing.id },
        data: reservation.toUpdate(),
      });
      await client.reservation_lines.updateMany({
        where: { reservation_id: existing.id },
        data: { qty: 0 },
      });

      await enqueueEvents(reservation.clearDomainEvents(), {
        client,
        logger: this.logger,
        topics: INVENTORY_TOPICS,
      });

      return { releasedLines };
    });
  }

  async shipOrder(input: {
    orderId: string;
    warehouseId?: string;
    lines: readonly ReserveLineInput[];
  }): Promise<ShipResult> {
    const totals = sumBySku(input.lines);
    const skus = [...totals.keys()].sort();

    return this.prisma.runInTransaction(async (client) => {
      const existing = await client.reservations.findUnique({
        where: { order_id: input.orderId },
        include: { lines: true },
      });

      if (!existing || existing.status !== 'active') {
        throw new InvalidStateTransitionException(
          `order ${input.orderId} has no active reservation to ship`,
          { orderId: input.orderId, status: existing?.status ?? 'none' },
        );
      }

      this.assertWarehouseMatches(existing.warehouse_id, input.warehouseId, input.orderId);

      const reservation = Reservation.fromRow(existing, existing.lines);

      // Coverage is checked for the whole batch *before* anything moves, so a shipment
      // the hold never agreed to cannot be half-applied. A refusal here is a 400; a
      // refusal after the first row is written would only be a rollback.
      const held = new Map(reservation.activeLines.map((line) => [line.sku, line.qty]));
      for (const sku of skus) {
        const heldQty = held.get(sku) ?? 0;
        if (heldQty < (totals.get(sku) ?? 0)) {
          throw new ValidationException('reservation does not cover the requested shipment', {
            orderId: input.orderId,
            sku,
            requested: totals.get(sku) ?? 0,
            held: heldQty,
          });
        }
      }

      const levels = await this.lockLevels(client, skus, existing.warehouse_id);
      const now = new Date();

      for (const sku of skus) {
        const qty = totals.get(sku) ?? 0;
        const level = levels.get(sku);

        if (!level) {
          throw new ValidationException('cannot ship stock that was never stocked', {
            orderId: input.orderId,
            sku,
            warehouseId: existing.warehouse_id,
          });
        }

        // Throws if the shelf cannot cover it. Inside the transaction, so a refusal on the
        // second SKU rolls the first one back — atomicity by rollback, not by ordering.
        level.ship(qty, now);
        await client.stock_levels.update({
          where: { id: level.id },
          data: level.toUpdate(),
        });

        reservation.shipLine(sku, qty, now);
      }

      await client.reservations.update({
        where: { id: existing.id },
        data: reservation.toUpdate(),
      });
      for (const line of reservation.lines) {
        await client.reservation_lines.updateMany({
          where: { reservation_id: existing.id, sku: line.sku },
          data: { qty: line.qty },
        });
      }

      // No domain event: a shipment is announced by the order side (`order.shipped`) and
      // the hold's own lifecycle. A third view of the same numbers is a third place for
      // them to disagree.
      return { shipped: true };
    });
  }

  async adjustStock(input: AdjustStockInput): Promise<AdjustResult> {
    return this.prisma.runInTransaction(async (client) => {
      const applied = await client.stock_adjustments.findUnique({
        where: { adjustment_id: input.adjustmentId },
      });

      // Idempotent replay: the adjustment already happened, so this call answers with the
      // figures it produced and writes nothing — no second adjustment row, no second
      // `stock.changed`, no version bump.
      if (applied) {
        const current = await this.readAvailability(client, input.sku, input.warehouseId);
        return {
          onHand: current.onHand,
          available: current.available,
          replayed: true,
        };
      }

      const rows = await client.$queryRaw<LockedRow[]>`
        SELECT id, sku, warehouse_id, on_hand, reserved, safety, version, created_at, updated_at
          FROM stock_levels
         WHERE sku = ${input.sku}
           AND warehouse_id = ${input.warehouseId}
         FOR UPDATE
      `;

      const now = new Date();
      const existing = rows[0];
      let level: StockLevel;

      if (existing) {
        level = StockLevel.fromRow(existing);
        level.adjust(input.delta, now);
        await client.stock_levels.update({
          where: { id: existing.id },
          data: level.toUpdate(),
        });
      } else {
        // Creating the row and applying the correction are one step. A negative delta on
        // a SKU that was never stocked fails inside `adjust`, so no zero row is ever left
        // behind by an adjustment that was refused.
        level = StockLevel.create({
          sku: input.sku,
          warehouseId: input.warehouseId,
          safety: input.safetyDefault,
          now,
        });
        level.adjust(input.delta, now);
        // Stored at the version the adjustment produced, so the row and the
        // `stock.changed` event that announces it agree on the same number.
        await client.stock_levels.create({
          data: {
            id: level.id,
            sku: level.sku,
            warehouse_id: level.warehouseId,
            on_hand: level.onHand,
            reserved: level.reserved,
            safety: level.safety,
            version: level.version,
            created_at: now,
            updated_at: now,
          },
        });
      }

      await client.stock_adjustments.create({
        data: {
          id: crypto.randomUUID(),
          sku: input.sku,
          warehouse_id: input.warehouseId,
          delta: input.delta,
          reason: input.reason,
          adjustment_id: input.adjustmentId,
          created_at: now,
        },
      });

      await enqueueEvents(level.clearDomainEvents(), {
        client,
        logger: this.logger,
        topics: INVENTORY_TOPICS,
      });

      return { onHand: level.onHand, available: level.available, replayed: false };
    });
  }

  async getAvailable(sku: string, warehouseId: string): Promise<StockAvailability> {
    return this.readAvailability(this.prisma.tx, sku, warehouseId);
  }

  async countActiveReservations(): Promise<number> {
    return this.prisma.tx.reservations.count({ where: { status: 'active' } });
  }

  /**
   * Answers an existing hold as a full acceptance.
   *
   * @remarks Returns the hold's **own** lines, not the ones in the request: a retry that
   * asks for a different quantity still sees what was actually reserved, which is the only
   * answer that cannot lie about the ledger.
   *
   * @remarks A hold that already finished is refused rather than recreated —
   * `reservations.order_id` is unique, so there is no second row to make, and resurrecting
   * a released hold would silently undo a cancellation.
   */
  private replayExistingReservation(
    existing: ReservationRow & { lines: readonly ReservationLineRow[] },
  ): ReserveResult {
    if (existing.status !== 'active') {
      throw new InvalidStateTransitionException(
        `order ${existing.order_id} already has a ${existing.status} reservation`,
        { orderId: existing.order_id, status: existing.status },
      );
    }

    const held = [...existing.lines].sort((a, b) => a.sku.localeCompare(b.sku));

    return {
      fullyAccepted: true,
      reserved: held.map((line) => ({
        sku: line.sku,
        qty: line.qty,
        reservationId: existing.id,
      })),
      rejected: [],
      replayed: true,
    };
  }

  /**
   * Locks one stock row per SKU, in ascending SKU order.
   *
   * @remarks The order is the deadlock contract: every transaction in this service
   * acquires these locks the same way, so overlapping reserves serialise instead of
   * waiting on each other in a cycle.
   */
  private async lockLevels(
    client: PrismaClient,
    skus: readonly string[],
    warehouseId: string,
  ): Promise<Map<string, StockLevel>> {
    const levels = new Map<string, StockLevel>();

    for (const sku of [...skus].sort()) {
      const rows = await client.$queryRaw<LockedRow[]>`
        SELECT id, sku, warehouse_id, on_hand, reserved, safety, version, created_at, updated_at
          FROM stock_levels
         WHERE sku = ${sku}
           AND warehouse_id = ${warehouseId}
           FOR UPDATE
      `;
      const row = rows[0];
      if (row) levels.set(sku, StockLevel.fromRow(row));
    }

    return levels;
  }

  private async readAvailability(
    client: PrismaClient,
    sku: string,
    warehouseId: string,
  ): Promise<StockAvailability> {
    const row = await client.stock_levels.findUnique({
      where: { sku_warehouse_id: { sku, warehouse_id: warehouseId } },
    });

    // A row that does not exist has never been stocked, so every figure reads zero —
    // `safety` included. The configured default applies when a row is *created*, not to
    // an absence, or a default of 5 would report `available: -5` for a SKU nobody carries.
    if (!row) {
      return { sku, warehouseId, onHand: 0, reserved: 0, safety: 0, available: 0 };
    }

    const level = StockLevel.fromRow(row);
    return {
      sku,
      warehouseId,
      onHand: level.onHand,
      reserved: level.reserved,
      safety: level.safety,
      available: level.available,
    };
  }

  /**
   * Refuses a warehouse that is not the one the hold lives in.
   *
   * @remarks Only when the caller actually named one. An empty value means "whatever the
   * hold is in", which is the right answer for a caller that does not track warehouses —
   * and `order_id` already identifies the hold uniquely, so the field is corroboration,
   * not the lookup key.
   */
  private assertWarehouseMatches(
    reservedIn: string,
    requested: string | undefined,
    orderId: string,
  ): void {
    const named = requested?.trim();
    if (named && named !== reservedIn) {
      throw new ValidationException('warehouse does not match the reservation', {
        orderId,
        reservedIn,
        requested: named,
      });
    }
  }
}

/**
 * Sums a request by SKU, preserving first-seen order.
 *
 * @remarks Duplicate SKUs in one request are a client bug that must not corrupt the
 * ledger: summing makes the check and the response describe the same quantity the row
 * will actually end up holding.
 */
function sumBySku(lines: readonly ReserveLineInput[]): Map<string, number> {
  const totals = new Map<string, number>();

  for (const line of lines) {
    totals.set(line.sku, (totals.get(line.sku) ?? 0) + line.qty);
  }

  return totals;
}

export { INVENTORY_REPOSITORY };
