/**
 * @fileoverview In-memory doubles for the inventory ports.
 *
 * @remarks Hand-written rather than auto-mocked: a mock asserts on the calls a test
 * *expects*, while the question these suites keep asking is "what would be stored, and
 * what would be published" — and only the resulting state answers that.
 *
 * @remarks The repository stores **rehydrated rows**, not the aggregates it was handed.
 * That is load-bearing: an assertion about `reserved` or about a `shipped` hold then
 * proves the transition reached storage, rather than proving it is sitting in an object
 * the handler still holds. It also runs `fromRow` on every read, which is where a column
 * renamed on one side only would show up.
 *
 * @remarks The semantics here mirror `PrismaInventoryRepository` on purpose — all-or-nothing
 * reserve, idempotent release, idempotent adjustment — because a suite that only ever
 * exercised the real repository could not run without a database, and one that only ever
 * exercised this double could not tell whether the real one kept its rules.
 */
import type { IDomainEvent } from '@auth/core';
import { InvalidStateTransitionException } from '@auth/platform/error-handling';
import type { StockLevelRow, StockAvailability } from '../../src/domain/stock-level.aggregate';
import { StockLevel } from '../../src/domain/stock-level.aggregate';
import type { ReservationLineRow, ReservationRow } from '../../src/domain/reservation.entity';
import { Reservation } from '../../src/domain/reservation.entity';
import {
  stockRejectedEvents,
} from '../../src/domain/inventory.events';
import type {
  AdjustResult,
  AdjustStockInput,
  InventoryRepositoryPort,
  ReleaseResult,
  ReserveLineInput,
  ReserveResult,
  ShipResult,
} from '../../src/domain/ports/inventory-repository.port';

export const ORDER_ID = '0f1e2d3c-4b5a-4697-8899-aabbccddeeff';
export const OTHER_ORDER_ID = '1a2b3c4d-5e6f-4708-9911-223344556677';
export const WAREHOUSE = 'main';
export const ADJUSTMENT_ID = '3b7a1c9e-2d4f-4e5a-8b6c-7d8e9f0a1b2c';

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

interface StoredAdjustment {
  readonly sku: string;
  readonly warehouseId: string;
  readonly delta: number;
  readonly reason: string;
}

export class InMemoryInventoryRepository implements InventoryRepositoryPort {
  /** Stored stock rows, keyed `sku|warehouseId` — rehydrated on every read. */
  readonly stockLevels = new Map<string, StockLevelRow>();

  /** Stored reservations, keyed by order id. One hold per order, as the unique index says. */
  readonly reservations = new Map<string, ReservationRow & { lines: ReservationLineRow[] }>();

  /** Applied `adjustmentId`s — the idempotency ledger for corrections. */
  readonly adjustments = new Map<string, StoredAdjustment>();

  /** Every aggregate handed to a write, in call order. */
  readonly saved: string[] = [];

  /** Transaction boundaries. Each mutating call must add exactly one. */
  commits = 0;

  readonly outbox: CapturedOutboxEvent[] = [];

  constructor(private readonly topics: Readonly<Record<string, string>> = {}) {}

  private static key(sku: string, warehouseId: string): string {
    return `${sku}|${warehouseId}`;
  }

  async reserveForOrder(input: {
    orderId: string;
    warehouseId: string;
    lines: readonly ReserveLineInput[];
  }): Promise<ReserveResult> {
    this.commits += 1;

    const totals = new Map<string, number>();
    for (const line of input.lines) {
      totals.set(line.sku, (totals.get(line.sku) ?? 0) + line.qty);
    }

    const existing = this.reservations.get(input.orderId);
    if (existing) {
      if (existing.status !== 'active') {
        throw new InvalidStateTransitionException(
          `order ${input.orderId} already has a ${existing.status} reservation`,
          { orderId: input.orderId, status: existing.status },
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

    const rejected: { sku: string; qty: number; reason: string }[] = [];
    const accepted: { sku: string; qty: number }[] = [];

    for (const sku of [...totals.keys()].sort()) {
      const qty = totals.get(sku) ?? 0;
      const level = this.loadLevel(sku, input.warehouseId);

      if (!level || level.available < qty) {
        rejected.push({ sku, qty, reason: 'insufficient_stock' });
      } else {
        accepted.push({ sku, qty });
      }
    }

    if (rejected.length > 0) {
      for (const event of stockRejectedEvents({
        orderId: input.orderId,
        warehouseId: input.warehouseId,
        lines: rejected,
      })) {
        this.outbox.push(capture(event, this.topics));
      }
      return { fullyAccepted: false, reserved: [], rejected, replayed: false };
    }

    const reservation = Reservation.create({
      orderId: input.orderId,
      warehouseId: input.warehouseId,
      lines: accepted,
    });

    for (const line of accepted) {
      const level = this.loadLevel(line.sku, input.warehouseId);
      if (!level) throw new Error(`expected a stock row for ${line.sku}`);
      level.reserve(line.qty);
      this.writeLevel(level);
    }

    this.reservations.set(input.orderId, {
      id: reservation.id,
      order_id: reservation.orderId,
      warehouse_id: reservation.warehouseId,
      status: reservation.status,
      version: reservation.version,
      created_at: new Date(),
      updated_at: new Date(),
      lines: accepted.map((line) => ({
        id: crypto.randomUUID(),
        reservation_id: reservation.id,
        sku: line.sku,
        qty: line.qty,
      })),
    });

    reservation.announceReserved();
    for (const event of reservation.clearDomainEvents()) {
      this.outbox.push(capture(event, this.topics));
    }
    this.saved.push(reservation.id);

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
  }

  async releaseOrder(input: {
    orderId: string;
    warehouseId?: string;
  }): Promise<ReleaseResult> {
    this.commits += 1;

    const existing = this.reservations.get(input.orderId);
    if (!existing || existing.status !== 'active') {
      return { releasedLines: 0 };
    }

    const reservation = Reservation.fromRow(existing, existing.lines);
    const held = reservation.activeLines;
    if (held.length === 0) return { releasedLines: 0 };

    const now = new Date();
    for (const line of held) {
      const level = this.loadLevel(line.sku, existing.warehouse_id);
      if (!level) continue;
      level.release(line.qty, now);
      this.writeLevel(level);
    }

    const releasedLines = reservation.releaseAll(now);
    this.reservations.set(input.orderId, {
      ...existing,
      status: reservation.status,
      version: reservation.version,
      lines: existing.lines.map((line) => ({ ...line, qty: 0 })),
    });

    for (const event of reservation.clearDomainEvents()) {
      this.outbox.push(capture(event, this.topics));
    }

    return { releasedLines };
  }

  async shipOrder(input: {
    orderId: string;
    warehouseId?: string;
    lines: readonly ReserveLineInput[];
  }): Promise<ShipResult> {
    this.commits += 1;

    const existing = this.reservations.get(input.orderId);
    if (!existing || existing.status !== 'active') {
      throw new InvalidStateTransitionException(
        `order ${input.orderId} has no active reservation to ship`,
        { orderId: input.orderId, status: existing?.status ?? 'none' },
      );
    }

    const reservation = Reservation.fromRow(existing, existing.lines);
    const totals = new Map<string, number>();
    for (const line of input.lines) {
      totals.set(line.sku, (totals.get(line.sku) ?? 0) + line.qty);
    }

    const held = new Map(reservation.activeLines.map((line) => [line.sku, line.qty]));
    for (const [sku, qty] of totals) {
      if ((held.get(sku) ?? 0) < qty) {
        throw new InvalidStateTransitionException('reservation does not cover the shipment', {
          orderId: input.orderId,
          sku,
        });
      }
    }

    const now = new Date();
    for (const [sku, qty] of [...totals.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const level = this.loadLevel(sku, existing.warehouse_id);
      if (!level) throw new Error(`expected a stock row for ${sku}`);
      level.ship(qty, now);
      this.writeLevel(level);
      reservation.shipLine(sku, qty, now);
    }

    this.reservations.set(input.orderId, {
      ...existing,
      status: reservation.status,
      version: reservation.version,
      lines: reservation.lines.map((line, index) => ({
        ...existing.lines[index],
        qty: line.qty,
      })),
    });

    return { shipped: true };
  }

  async adjustStock(input: AdjustStockInput): Promise<AdjustResult> {
    this.commits += 1;

    const applied = this.adjustments.get(input.adjustmentId);
    if (applied) {
      const current = this.getAvailability(input.sku, input.warehouseId);
      return { onHand: current.onHand, available: current.available, replayed: true };
    }

    const key = InMemoryInventoryRepository.key(input.sku, input.warehouseId);
    const stored = this.stockLevels.get(key);
    const level = stored
      ? StockLevel.fromRow(stored)
      : StockLevel.create({
          sku: input.sku,
          warehouseId: input.warehouseId,
          safety: input.safetyDefault,
        });

    level.adjust(input.delta);
    this.stockLevels.set(key, level.toRow());

    this.adjustments.set(input.adjustmentId, {
      sku: input.sku,
      warehouseId: input.warehouseId,
      delta: input.delta,
      reason: input.reason,
    });

    for (const event of level.clearDomainEvents()) {
      this.outbox.push(capture(event, this.topics));
    }
    this.saved.push(key);

    return { onHand: level.onHand, available: level.available, replayed: false };
  }

  async getAvailable(sku: string, warehouseId: string): Promise<StockAvailability> {
    return this.getAvailability(sku, warehouseId);
  }

  async countActiveReservations(): Promise<number> {
    return [...this.reservations.values()].filter((row) => row.status === 'active').length;
  }

  private getAvailability(sku: string, warehouseId: string): StockAvailability {
    const stored = this.stockLevels.get(InMemoryInventoryRepository.key(sku, warehouseId));
    if (!stored) {
      return { sku, warehouseId, onHand: 0, reserved: 0, safety: 0, available: 0 };
    }
    const level = StockLevel.fromRow(stored);
    return {
      sku,
      warehouseId,
      onHand: level.onHand,
      reserved: level.reserved,
      safety: level.safety,
      available: level.available,
    };
  }

  private loadLevel(sku: string, warehouseId: string): StockLevel | null {
    const stored = this.stockLevels.get(InMemoryInventoryRepository.key(sku, warehouseId));
    return stored ? StockLevel.fromRow(stored) : null;
  }

  private writeLevel(level: StockLevel): void {
    this.stockLevels.set(
      InMemoryInventoryRepository.key(level.sku, level.warehouseId),
      level.toRow(),
    );
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
