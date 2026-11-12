/**
 * @fileoverview The stock ledger's two aggregates: the row and the hold.
 *
 * @remarks Every state transition is exercised against explicit quantities rather than
 * `new Date()` — the rules here are arithmetic and invariants, and a fixed `now` keeps the
 * assertions about `version` and event payloads free of wall-clock noise.
 *
 * @remarks What these tests guard is the invariant the whole service exists for:
 * `available` never goes negative under any order of operations, and a refusal leaves the
 * row exactly as it was. A partial write here is an oversell.
 */
import 'reflect-metadata';
import { ValidationException, InvalidStateTransitionException } from '@auth/platform/error-handling';
import { StockLevel } from '../src/domain/stock-level.aggregate';
import { Reservation, TERMINAL_RESERVATION_STATUSES } from '../src/domain/reservation.entity';
import { stockRejectedEvents } from '../src/domain/inventory.events';
import { payloadFor, payloadsFor, thrown } from './support/helpers';
import { ORDER_ID, WAREHOUSE } from './support/fakes';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1_000);

/** `create` starts at `on_hand: 0`, so a fixture that needs stock applies it as an adjustment. */
function seeded(input: {
  onHand?: number;
  reserved?: number;
  safety?: number;
}): StockLevel {
  const created = StockLevel.create({
    sku: 'SKU-1',
    warehouseId: WAREHOUSE,
    safety: input.safety ?? 0,
    now: T0,
    id: '5f0e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
  });
  if (input.onHand) created.adjust(input.onHand, T0);
  for (let i = 0; i < (input.reserved ?? 0); i += 1) created.reserve(1, at(i));

  // The seed's own `adjust` announces `stock.changed`; a fixture that hands back a row
  // mid-life must not make every later assertion count that event too.
  created.clearDomainEvents();

  return created;
}

describe('StockLevel.available', () => {
  it('is on_hand minus reserved minus safety, never a stored column', () => {
    const row = seeded({ onHand: 10, reserved: 3, safety: 2 });

    expect(row.available).toBe(5);
    expect(JSON.stringify(row.toRow())).not.toContain('available');
  });

  it('may read negative when safety alone exceeds the shelf, which reserve treats as empty', () => {
    const row = StockLevel.create({
      sku: 'SKU-1',
      warehouseId: WAREHOUSE,
      safety: 5,
      onHand: 3,
      now: T0,
    });

    expect(row.available).toBe(-2);
    expect(thrown(() => row.reserve(1, T0))).toBeInstanceOf(ValidationException);
  });
});

describe('StockLevel.reserve', () => {
  it('holds the units and moves the row forward in its own write stream', () => {
    const row = seeded({ onHand: 10 });
    const before = row.version;

    row.reserve(4, at(60));

    expect(row.reserved).toBe(4);
    expect(row.available).toBe(6);
    expect(row.version).toBeGreaterThan(before);
  });

  it('refuses the whole quantity when the shelf cannot cover it, changing nothing', () => {
    const row = seeded({ onHand: 10, reserved: 8 });
    const before = row.toRow();

    const error = thrown(() => row.reserve(3, at(60))) as ValidationException;

    expect(error).toBeInstanceOf(ValidationException);
    expect(error.context.requested).toBe(3);
    expect(error.context.available).toBe(2);
    expect(row.toRow()).toMatchObject({
      on_hand: before.on_hand,
      reserved: before.reserved,
      version: before.version,
    });
  });

  it('refuses a quantity that is not a positive integer', () => {
    const row = seeded({ onHand: 10 });

    expect(thrown(() => row.reserve(0, T0))).toBeInstanceOf(ValidationException);
    expect(thrown(() => row.reserve(-1, T0))).toBeInstanceOf(ValidationException);
    expect(thrown(() => row.reserve(1.5, T0))).toBeInstanceOf(ValidationException);
    expect(row.reserved).toBe(0);
  });

  it('emits no event of its own — the reservation announces the hold', () => {
    const row = seeded({ onHand: 10 });

    row.reserve(2, T0);

    expect(row.domainEvents).toHaveLength(0);
  });
});

describe('StockLevel.release', () => {
  it('gives units back and never drives reserved below zero', () => {
    const row = seeded({ onHand: 10, reserved: 3 });

    row.release(5, at(60));

    expect(row.reserved).toBe(0);
    expect(row.onHand).toBe(10);
    expect(row.available).toBe(10);
  });

  it('is a successful no-op for a quantity that was never held', () => {
    const row = seeded({ onHand: 10 });

    expect(() => row.release(4, T0)).not.toThrow();
    expect(row.reserved).toBe(0);
  });
});

describe('StockLevel.ship', () => {
  it('takes the units off the shelf and out of the hold at once', () => {
    const row = seeded({ onHand: 10, reserved: 4 });

    row.ship(4, at(60));

    expect(row.onHand).toBe(6);
    expect(row.reserved).toBe(0);
    expect(row.available).toBe(6);
  });

  it('refuses to ship more than is on hand', () => {
    const row = seeded({ onHand: 2, reserved: 2 });

    expect(thrown(() => row.ship(3, T0))).toBeInstanceOf(ValidationException);
    expect(row.onHand).toBe(2);
    expect(row.reserved).toBe(2);
  });

  it('refuses to ship more than was ever reserved, even with stock on the shelf', () => {
    const row = seeded({ onHand: 10, reserved: 2 });

    const error = thrown(() => row.ship(3, T0)) as ValidationException;

    expect(error).toBeInstanceOf(ValidationException);
    expect(error.context.reserved).toBe(2);
    expect(row.onHand).toBe(10);
  });
});

describe('StockLevel.adjust', () => {
  it('accepts a negative correction that keeps the row whole', () => {
    const row = seeded({ onHand: 10 });

    row.adjust(-4, at(60));

    expect(row.onHand).toBe(6);
    expect(row.version).toBeGreaterThan(1);
  });

  it('refuses a correction that would take on_hand below zero', () => {
    const row = seeded({ onHand: 3 });

    const error = thrown(() => row.adjust(-4, T0)) as ValidationException;

    expect(error).toBeInstanceOf(ValidationException);
    expect(error.context.delta).toBe(-4);
    expect(row.onHand).toBe(3);
    expect(row.domainEvents).toHaveLength(0);
  });

  it('refuses a correction that would strand a live reservation', () => {
    const row = seeded({ onHand: 10, reserved: 6 });

    const error = thrown(() => row.adjust(-5, T0)) as ValidationException;

    expect(error).toBeInstanceOf(ValidationException);
    expect(error.context.reserved).toBe(6);
    expect(row.onHand).toBe(10);
  });

  it('accepts a correction that lands exactly on the reservation', () => {
    const row = seeded({ onHand: 10, reserved: 6 });

    expect(() => row.adjust(-4, T0)).not.toThrow();
    expect(row.onHand).toBe(6);
    expect(row.available).toBe(0);
  });

  it('refuses a non-integer delta', () => {
    const row = seeded({ onHand: 10 });

    expect(thrown(() => row.adjust(1.5, T0))).toBeInstanceOf(ValidationException);
  });

  it('announces stock.changed keyed by sku at the row version', () => {
    const row = seeded({ onHand: 10 });
    row.clearDomainEvents();

    row.adjust(-1, at(60));

    const event = row.domainEvents[0];
    expect(event.eventType).toBe('stock.changed');
    expect(event.aggregateId).toBe('SKU-1');
    expect(event.aggregateType).toBe('StockLevel');
    expect(event.version).toBe(row.version);

    expect(payloadFor(row.domainEvents, 'stock.changed')).toMatchObject({
      sku: 'SKU-1',
      warehouseId: WAREHOUSE,
      onHand: 9,
      reserved: 0,
      available: 9,
    });
  });

  it('versions two adjustments of the same sku differently, so dedup cannot swallow one', () => {
    const row = seeded({ onHand: 10 });
    row.clearDomainEvents();

    row.adjust(-1, at(60));
    row.adjust(-1, at(120));

    const versions = row.domainEvents.map((event) => event.version);
    expect(versions).toHaveLength(2);
    expect(new Set(versions).size).toBe(2);
    expect(versions).toEqual([row.version - 1, row.version]);
  });
});

describe('Reservation.create', () => {
  const hold = (lines: { sku: string; qty: number }[] = [{ sku: 'SKU-1', qty: 3 }]) =>
    Reservation.create({ orderId: ORDER_ID, warehouseId: WAREHOUSE, lines, now: T0 });

  it('starts active, holds its lines, and says so with no event yet', () => {
    const reservation = hold();

    expect(reservation.status).toBe('active');
    expect(reservation.isActive).toBe(true);
    expect(reservation.lines).toEqual([{ sku: 'SKU-1', qty: 3 }]);
    expect(reservation.domainEvents).toHaveLength(0);
    expect(reservation.version).toBe(1);
  });

  it('refuses to exist without a line', () => {
    expect(() => hold([])).toThrow();
  });
});

describe('Reservation.announceReserved', () => {
  it('emits one event per line, keyed by order and indexed from one', () => {
    const reservation = Reservation.create({
      orderId: ORDER_ID,
      warehouseId: WAREHOUSE,
      lines: [
        { sku: 'SKU-1', qty: 2 },
        { sku: 'SKU-2', qty: 5 },
      ],
      now: T0,
    });

    reservation.announceReserved(T0);

    expect(reservation.domainEvents.map((event) => event.eventType)).toEqual([
      'stock.reserved',
      'stock.reserved',
    ]);
    expect(reservation.domainEvents.map((event) => event.version)).toEqual([1, 2]);
    expect(reservation.domainEvents.every((event) => event.aggregateId === ORDER_ID)).toBe(true);
    expect(payloadsFor(reservation.domainEvents, 'stock.reserved')).toEqual([
      { orderId: ORDER_ID, sku: 'SKU-1', qty: 2, reservationId: reservation.id, warehouseId: WAREHOUSE },
      { orderId: ORDER_ID, sku: 'SKU-2', qty: 5, reservationId: reservation.id, warehouseId: WAREHOUSE },
    ]);
  });

  it('produces dedup keys that cannot collide inside one batch', () => {
    const reservation = Reservation.create({
      orderId: ORDER_ID,
      warehouseId: WAREHOUSE,
      lines: [
        { sku: 'SKU-1', qty: 2 },
        { sku: 'SKU-2', qty: 5 },
        { sku: 'SKU-3', qty: 1 },
      ],
      now: T0,
    });

    reservation.announceReserved(T0);

    const keys = reservation.domainEvents.map(
      (event) => `${event.eventType}:${event.aggregateId}:${event.version}`,
    );

    expect(keys).toEqual([
      `stock.reserved:${ORDER_ID}:1`,
      `stock.reserved:${ORDER_ID}:2`,
      `stock.reserved:${ORDER_ID}:3`,
    ]);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('Reservation.releaseAll', () => {
  const hold = () =>
    Reservation.create({
      orderId: ORDER_ID,
      warehouseId: WAREHOUSE,
      lines: [
        { sku: 'SKU-1', qty: 2 },
        { sku: 'SKU-2', qty: 5 },
      ],
      now: T0,
    });

  it('zeroes every line, moves to a terminal status and announces one release', () => {
    const reservation = hold();

    const released = reservation.releaseAll(at(60));

    expect(released).toBe(2);
    expect(reservation.status).toBe('released');
    expect(reservation.isActive).toBe(false);
    expect(reservation.activeLines).toHaveLength(0);
    expect(reservation.lines.every((line) => line.qty === 0)).toBe(true);
    expect(reservation.domainEvents.map((event) => event.eventType)).toEqual(['stock.released']);
    expect(reservation.domainEvents[0].version).toBe(1);
    expect(payloadFor(reservation.domainEvents, 'stock.released')).toEqual({
      orderId: ORDER_ID,
      warehouseId: WAREHOUSE,
      lines: 2,
    });
  });

  it('is a no-op the second time: no state change, no second event', () => {
    const reservation = hold();
    reservation.releaseAll(at(60));
    const buffered = reservation.domainEvents.length;
    const version = reservation.version;

    const again = reservation.releaseAll(at(120));

    expect(again).toBe(0);
    expect(reservation.domainEvents).toHaveLength(buffered);
    expect(reservation.version).toBe(version);
    expect(reservation.status).toBe('released');
  });

  it('releases nothing from a hold that is already spent', () => {
    const reservation = hold();
    reservation.announceReserved();
    reservation.shipLine('SKU-1', 2, at(60));
    reservation.shipLine('SKU-2', 5, at(60));

    expect(reservation.status).toBe('shipped');
    expect(reservation.releaseAll(at(120))).toBe(0);
  });
});

describe('Reservation.shipLine', () => {
  const hold = () =>
    Reservation.create({
      orderId: ORDER_ID,
      warehouseId: WAREHOUSE,
      lines: [
        { sku: 'SKU-1', qty: 2 },
        { sku: 'SKU-2', qty: 5 },
      ],
      now: T0,
    });

  it('consumes the line and keeps the hold active while anything is left', () => {
    const reservation = hold();

    reservation.shipLine('SKU-1', 2, at(60));

    expect(reservation.status).toBe('active');
    expect(reservation.activeLines).toEqual([{ sku: 'SKU-2', qty: 5 }]);
  });

  it('moves to `shipped` only when no line holds anything', () => {
    const reservation = hold();

    reservation.shipLine('SKU-1', 2, at(60));
    reservation.shipLine('SKU-2', 5, at(120));

    expect(reservation.status).toBe('shipped');
    expect(TERMINAL_RESERVATION_STATUSES.has(reservation.status)).toBe(true);
    expect(reservation.domainEvents).toHaveLength(0);
  });

  it('refuses a quantity the hold never agreed to', () => {
    const reservation = hold();

    const error = thrown(() => reservation.shipLine('SKU-1', 3, T0)) as ValidationException;

    expect(error).toBeInstanceOf(ValidationException);
    expect(error.context.held).toBe(2);
    expect(reservation.lines[0].qty).toBe(2);
  });

  it('refuses a sku the hold does not carry', () => {
    const reservation = hold();

    expect(thrown(() => reservation.shipLine('SKU-9', 1, T0))).toBeInstanceOf(
      ValidationException,
    );
  });

  it('refuses to ship a hold that has already finished', () => {
    const reservation = hold();
    reservation.releaseAll(at(60));

    expect(thrown(() => reservation.shipLine('SKU-1', 1, at(120)))).toBeInstanceOf(
      InvalidStateTransitionException,
    );
  });
});

describe('Reservation rehydration', () => {
  it('round-trips through a row without losing the hold', () => {
    const reservation = Reservation.create({
      orderId: ORDER_ID,
      warehouseId: WAREHOUSE,
      lines: [{ sku: 'SKU-1', qty: 7 }],
      now: T0,
    });
    reservation.announceReserved();
    reservation.clearDomainEvents();

    const loaded = Reservation.fromRow(
      {
        id: reservation.id,
        order_id: reservation.orderId,
        warehouse_id: reservation.warehouseId,
        status: reservation.status,
        version: reservation.version,
        created_at: T0,
        updated_at: T0,
      },
      [{ id: crypto.randomUUID(), reservation_id: reservation.id, sku: 'SKU-1', qty: 7 }],
    );

    expect(loaded.id).toBe(reservation.id);
    expect(loaded.orderId).toBe(ORDER_ID);
    expect(loaded.status).toBe('active');
    expect(loaded.lines).toEqual([{ sku: 'SKU-1', qty: 7 }]);
    expect(loaded.domainEvents).toHaveLength(0);
  });

  it('reads an unknown status as active rather than releasing or shipping stock', () => {
    const loaded = Reservation.fromRow(
      {
        id: crypto.randomUUID(),
        order_id: ORDER_ID,
        warehouse_id: WAREHOUSE,
        status: 'something_a_newer_build_wrote',
        version: 1,
        created_at: T0,
        updated_at: T0,
      },
      [],
    );

    expect(loaded.status).toBe('active');
  });
});

describe('stockRejectedEvents', () => {
  it('keys one event per refused line, indexed from one', () => {
    const events = stockRejectedEvents({
      orderId: ORDER_ID,
      warehouseId: WAREHOUSE,
      lines: [
        { sku: 'SKU-1', qty: 4 },
        { sku: 'SKU-2', qty: 1 },
      ],
    });

    expect(events.map((event) => event.version)).toEqual([1, 2]);
    expect(events.map((event) => `${event.eventType}:${event.aggregateId}:${event.version}`)).toEqual([
      `stock.rejected:${ORDER_ID}:1`,
      `stock.rejected:${ORDER_ID}:2`,
    ]);
    expect(payloadFor(events, 'stock.rejected')).toMatchObject({
      reason: 'insufficient_stock',
      warehouseId: WAREHOUSE,
    });
  });
});
