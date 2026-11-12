/**
 * @fileoverview The four commands and the one query of the stock ledger.
 *
 * @remarks The domain rules themselves are covered by `inventory.aggregate.spec.ts`; what
 * this suite guards is the *outbound* surface of the handlers: what a result claims, what
 * ends up stored, and what an event announces. A handler that validated correctly but
 * reported `fullyAccepted: false` for a complete reserve would be a bug only these tests
 * can see.
 *
 * @remarks Handlers are constructed directly rather than through a `TestingModule`: each
 * one takes a port and (sometimes) a config object, and a container would hide exactly the
 * wiring these assertions are about. The port is the in-memory double, whose semantics
 * deliberately mirror the Prisma repository — all-or-nothing reserve, idempotent release,
 * idempotent adjustment.
 *
 * @remarks Idempotency is the recurring theme. Every retry path a caller can take — a
 * reserve that lands twice, a cancel that runs twice, a recount that runs twice — must
 * answer without writing a second row and without announcing a second event.
 */

import 'reflect-metadata';
import {
  InvalidStateTransitionException,
  ValidationException,
} from '@auth/platform/error-handling';
import { Topics } from '@auth/contracts';
import { ReserveHandler } from '../src/application/commands/reserve.handler';
import { ReleaseHandler } from '../src/application/commands/release.handler';
import { ShipHandler } from '../src/application/commands/ship.handler';
import { AdjustStockHandler } from '../src/application/commands/adjust-stock.handler';
import {
  ReleaseCommand,
  ReserveCommand,
  ShipCommand,
  AdjustStockCommand,
} from '../src/application/commands/inventory.commands';
import {
  GetAvailableHandler,
  GetAvailableQuery,
} from '../src/application/queries/inventory.queries';
import type { InventoryConfig } from '../src/inventory.config';
import { InMemoryInventoryRepository, ORDER_ID, WAREHOUSE } from './support/fakes';

/** The `stock.*` -> topic mapping the real repository uses. */
const TOPICS = {
  'stock.reserved': Topics.STOCK_RESERVED,
  'stock.rejected': Topics.STOCK_REJECTED,
  'stock.released': Topics.STOCK_RELEASED,
  'stock.changed': Topics.STOCK_CHANGED,
} as const;

const testConfig = (overrides: Partial<InventoryConfig> = {}): InventoryConfig => ({
  defaultWarehouse: WAREHOUSE,
  safetyDefault: 0,
  grpcDeadlineMs: 5_000,
  ...overrides,
});

const context = () => {
  const repository = new InMemoryInventoryRepository(TOPICS);
  const config = testConfig();

  return {
    repository,
    config,
    reserve: new ReserveHandler(repository, config),
    release: new ReleaseHandler(repository),
    ship: new ShipHandler(repository),
    adjust: new AdjustStockHandler(repository, config),
    available: new GetAvailableHandler(repository, config),
  };
};

/** Puts `onHand` on the shelf for one SKU through the public correction path. */
const stock = async (
  harness: ReturnType<typeof context>,
  sku: string,
  onHand: number,
  adjustmentId = `adj-${sku}`,
): Promise<void> => {
  await harness.adjust.execute(
    new AdjustStockCommand(sku, onHand, adjustmentId, 'seed the shelf'),
  );
  harness.repository.outbox.length = 0;
  harness.repository.saved.length = 0;
};

describe('ReserveCommand', () => {
  it('holds every line and answers with the reservation it made', async () => {
    const harness = context();
    await stock(harness, 'SKU-1', 10);
    await stock(harness, 'SKU-2', 5);

    const result = await harness.reserve.execute(
      new ReserveCommand(ORDER_ID, [
        { sku: 'SKU-1', qty: 4 },
        { sku: 'SKU-2', qty: 2 },
      ]),
    );

    expect(result).toMatchObject({ fullyAccepted: true, replayed: false, rejected: [] });
    expect(result.reserved).toHaveLength(2);
    expect(result.reserved.map((line) => line.sku)).toEqual(['SKU-1', 'SKU-2']);
    expect(new Set(result.reserved.map((line) => line.reservationId)).size).toBe(1);

    const held = harness.repository.reservations.get(ORDER_ID);
    expect(held?.status).toBe('active');
    expect(held?.lines.map((line) => [line.sku, line.qty])).toEqual([
      ['SKU-1', 4],
      ['SKU-2', 2],
    ]);
  });

  it('answers a retry with the hold it already made, and writes nothing new', async () => {
    const harness = context();
    await stock(harness, 'SKU-1', 10);
    const first = await harness.reserve.execute(
      new ReserveCommand(ORDER_ID, [{ sku: 'SKU-1', qty: 4 }]),
    );
    const outboxAfterFirst = harness.repository.outbox.length;

    const again = await harness.reserve.execute(
      new ReserveCommand(ORDER_ID, [{ sku: 'SKU-1', qty: 4 }]),
    );

    expect(again.replayed).toBe(true);
    expect(again.fullyAccepted).toBe(true);
    expect(again.reserved).toEqual(first.reserved);
    // A second hold for the same order would collide on the unique `order_id`, and a
    // second batch of `stock.reserved` would tell the order side it holds 8.
    expect(harness.repository.outbox).toHaveLength(outboxAfterFirst);
    expect(
      harness.repository.stockLevels.get(`SKU-1|${WAREHOUSE}`)?.reserved,
    ).toBe(4);
  });

  it('refuses the whole batch when one line cannot be covered, and announces why', async () => {
    const harness = context();
    await stock(harness, 'SKU-1', 10);

    const result = await harness.reserve.execute(
      new ReserveCommand(ORDER_ID, [
        { sku: 'SKU-1', qty: 4 },
        { sku: 'SKU-2', qty: 3 },
      ]),
    );

    expect(result).toMatchObject({ fullyAccepted: false, replayed: false });
    expect(result.reserved).toEqual([]);
    expect(result.rejected).toEqual([
      { sku: 'SKU-2', qty: 3, reason: 'insufficient_stock' },
    ]);
    // Nothing moved: the covered line stayed on the shelf rather than being held alone.
    expect(harness.repository.stockLevels.get(`SKU-1|${WAREHOUSE}`)?.reserved).toBe(0);
    expect(harness.repository.reservations.has(ORDER_ID)).toBe(false);
    expect(harness.repository.outbox.map((event) => event.eventType)).toEqual([
      'stock.rejected',
    ]);
    expect(harness.repository.outbox[0].dedupKey).toBe(`stock.rejected:${ORDER_ID}:1`);
  });

  it('announces one event per held line, indexed from one', async () => {
    const harness = context();
    await stock(harness, 'SKU-1', 10);
    await stock(harness, 'SKU-2', 10);

    const result = await harness.reserve.execute(
      new ReserveCommand(ORDER_ID, [
        { sku: 'SKU-1', qty: 1 },
        { sku: 'SKU-2', qty: 2 },
      ]),
    );

    const reservationId = result.reserved[0].reservationId;
    expect(harness.repository.outbox.map((event) => event.dedupKey)).toEqual([
      `stock.reserved:${ORDER_ID}:1`,
      `stock.reserved:${ORDER_ID}:2`,
    ]);
    expect(harness.repository.outbox.every((event) => event.topic === Topics.STOCK_RESERVED)).toBe(
      true,
    );
    expect(harness.repository.outbox[0].payload).toMatchObject({
      orderId: ORDER_ID,
      reservationId,
      warehouseId: WAREHOUSE,
    });
  });

  it('sums a request that names the same sku twice instead of double-counting', async () => {
    const harness = context();
    await stock(harness, 'SKU-1', 10);

    const result = await harness.reserve.execute(
      new ReserveCommand(ORDER_ID, [
        { sku: 'SKU-1', qty: 3 },
        { sku: 'SKU-1', qty: 3 },
      ]),
    );

    expect(result.fullyAccepted).toBe(true);
    expect(result.reserved).toEqual([
      { sku: 'SKU-1', qty: 6, reservationId: expect.any(String) },
    ]);
    expect(harness.repository.stockLevels.get(`SKU-1|${WAREHOUSE}`)?.reserved).toBe(6);
  });

  it('falls back to the configured warehouse when the caller names none', async () => {
    const harness = context();
    await stock(harness, 'SKU-1', 10);

    await harness.reserve.execute(new ReserveCommand(ORDER_ID, [{ sku: 'SKU-1', qty: 1 }]));

    expect(harness.repository.reservations.get(ORDER_ID)?.warehouse_id).toBe(WAREHOUSE);
  });

  it('refuses a malformed request before the repository is touched', async () => {
    const harness = context();

    await expect(harness.reserve.execute(new ReserveCommand('  '))).rejects.toBeInstanceOf(
      ValidationException,
    );
    await expect(
      harness.reserve.execute(new ReserveCommand(ORDER_ID, [])),
    ).rejects.toBeInstanceOf(ValidationException);
    await expect(
      harness.reserve.execute(new ReserveCommand(ORDER_ID, [{ sku: ' ', qty: 1 }])),
    ).rejects.toBeInstanceOf(ValidationException);
    await expect(
      harness.reserve.execute(new ReserveCommand(ORDER_ID, [{ sku: 'SKU-1', qty: 0 }])),
    ).rejects.toBeInstanceOf(ValidationException);
    await expect(
      harness.reserve.execute(new ReserveCommand(ORDER_ID, [{ sku: 'SKU-1', qty: 1.5 }])),
    ).rejects.toBeInstanceOf(ValidationException);

    // Validation happens in the handler: no transaction was ever opened.
    expect(harness.repository.commits).toBe(0);
  });

  it('refuses to resurrect a hold that already finished', async () => {
    const harness = context();
    await stock(harness, 'SKU-1', 10);
    await harness.reserve.execute(new ReserveCommand(ORDER_ID, [{ sku: 'SKU-1', qty: 4 }]));
    await harness.release.execute(new ReleaseCommand(ORDER_ID));

    await expect(
      harness.reserve.execute(new ReserveCommand(ORDER_ID, [{ sku: 'SKU-1', qty: 4 }])),
    ).rejects.toBeInstanceOf(InvalidStateTransitionException);
    // The refusal left the released hold exactly as it was.
    expect(harness.repository.reservations.get(ORDER_ID)?.status).toBe('released');
  });
});

describe('ReleaseCommand', () => {
  const reserve = async (harness: ReturnType<typeof context>): Promise<void> => {
    await stock(harness, 'SKU-1', 10);
    await harness.reserve.execute(new ReserveCommand(ORDER_ID, [{ sku: 'SKU-1', qty: 4 }]));
    harness.repository.outbox.length = 0;
  };

  it('gives every held unit back and announces one release', async () => {
    const harness = context();
    await reserve(harness);

    const result = await harness.release.execute(new ReleaseCommand(ORDER_ID));

    expect(result.releasedLines).toBe(1);
    expect(harness.repository.stockLevels.get(`SKU-1|${WAREHOUSE}`)?.reserved).toBe(0);
    expect(harness.repository.reservations.get(ORDER_ID)?.status).toBe('released');
    expect(harness.repository.outbox.map((event) => event.eventType)).toEqual([
      'stock.released',
    ]);
    expect(harness.repository.outbox[0].dedupKey).toBe(`stock.released:${ORDER_ID}:1`);
    expect(harness.repository.outbox[0].topic).toBe(Topics.STOCK_RELEASED);
  });

  it('is a no-op the second time: no write, no second announcement', async () => {
    const harness = context();
    await reserve(harness);
    await harness.release.execute(new ReleaseCommand(ORDER_ID));
    harness.repository.outbox.length = 0;
    const commitsBefore = harness.repository.commits;

    const again = await harness.release.execute(new ReleaseCommand(ORDER_ID));

    // The cancel path retries by design; a failure here would make a cancelled order look
    // like it never was.
    expect(again.releasedLines).toBe(0);
    expect(harness.repository.outbox).toHaveLength(0);
    expect(harness.repository.commits).toBe(commitsBefore + 1);
  });

  it('answers zero for an order that never held anything', async () => {
    const harness = context();

    await expect(harness.release.execute(new ReleaseCommand(ORDER_ID))).resolves.toEqual({
      releasedLines: 0,
    });
  });

  it('refuses a blank order id', async () => {
    const harness = context();

    await expect(harness.release.execute(new ReleaseCommand(' '))).rejects.toBeInstanceOf(
      ValidationException,
    );
  });

  it('does not default the warehouse: the hold is released wherever it lives', async () => {
    const harness = context();
    // Stock counted into a warehouse the config does not name.
    await harness.adjust.execute(
      new AdjustStockCommand('SKU-1', 10, 'overflow-count', 'counted in overflow', 'overflow'),
    );
    await harness.reserve.execute(
      new ReserveCommand(ORDER_ID, [{ sku: 'SKU-1', qty: 2 }], 'overflow'),
    );

    const result = await harness.release.execute(new ReleaseCommand(ORDER_ID));

    expect(result.releasedLines).toBe(1);
    expect(harness.repository.stockLevels.get('SKU-1|overflow')?.reserved).toBe(0);
  });
});

describe('ShipCommand', () => {
  const held = async (harness: ReturnType<typeof context>): Promise<void> => {
    await stock(harness, 'SKU-1', 10);
    await harness.reserve.execute(new ReserveCommand(ORDER_ID, [{ sku: 'SKU-1', qty: 4 }]));
    harness.repository.outbox.length = 0;
  };

  it('takes the units off the shelf and out of the hold', async () => {
    const harness = context();
    await held(harness);

    const result = await harness.ship.execute(
      new ShipCommand(ORDER_ID, [{ sku: 'SKU-1', qty: 4 }]),
    );

    expect(result.shipped).toBe(true);
    const level = harness.repository.stockLevels.get(`SKU-1|${WAREHOUSE}`);
    expect(level).toMatchObject({ on_hand: 6, reserved: 0 });
    expect(harness.repository.reservations.get(ORDER_ID)?.status).toBe('shipped');
    // A shipment is announced by the order side; a third view of the numbers is a third
    // place for them to disagree.
    expect(harness.repository.outbox).toHaveLength(0);
  });

  it('refuses a shipment the hold never agreed to, moving nothing', async () => {
    const harness = context();
    await held(harness);

    await expect(
      harness.ship.execute(new ShipCommand(ORDER_ID, [{ sku: 'SKU-1', qty: 5 }])),
    ).rejects.toBeInstanceOf(InvalidStateTransitionException);

    expect(harness.repository.stockLevels.get(`SKU-1|${WAREHOUSE}`)).toMatchObject({
      on_hand: 10,
      reserved: 4,
    });
    expect(harness.repository.reservations.get(ORDER_ID)?.status).toBe('active');
  });

  it('refuses an order with no active hold', async () => {
    const harness = context();

    await expect(
      harness.ship.execute(new ShipCommand(ORDER_ID, [{ sku: 'SKU-1', qty: 1 }])),
    ).rejects.toBeInstanceOf(InvalidStateTransitionException);
  });

  it('refuses a malformed request before the repository is touched', async () => {
    const harness = context();

    await expect(harness.ship.execute(new ShipCommand(' '))).rejects.toBeInstanceOf(
      ValidationException,
    );
    await expect(harness.ship.execute(new ShipCommand(ORDER_ID, []))).rejects.toBeInstanceOf(
      ValidationException,
    );
    await expect(
      harness.ship.execute(new ShipCommand(ORDER_ID, [{ sku: '', qty: 1 }])),
    ).rejects.toBeInstanceOf(ValidationException);
    await expect(
      harness.ship.execute(new ShipCommand(ORDER_ID, [{ sku: 'SKU-1', qty: -1 }])),
    ).rejects.toBeInstanceOf(ValidationException);

    expect(harness.repository.commits).toBe(0);
  });
});

describe('AdjustStockCommand', () => {
  it('creates the row on the first correction and applies the configured safety', async () => {
    const harness = context();
    const withSafety = new AdjustStockHandler(
      harness.repository,
      testConfig({ safetyDefault: 3 }),
    );

    const result = await withSafety.execute(
      new AdjustStockCommand('SKU-1', 10, 'recount-1', 'opening count'),
    );

    expect(result).toMatchObject({ onHand: 10, available: 7, replayed: false });
    expect(harness.repository.stockLevels.get(`SKU-1|${WAREHOUSE}`)).toMatchObject({
      on_hand: 10,
      safety: 3,
    });
    expect(harness.repository.outbox.map((event) => event.eventType)).toEqual([
      'stock.changed',
    ]);
    expect(harness.repository.outbox[0].topic).toBe(Topics.STOCK_CHANGED);
    expect(harness.repository.outbox[0].dedupKey).toBe(`stock.changed:SKU-1:2`);
  });

  it('applies a negative correction without stranding a hold', async () => {
    const harness = context();
    await stock(harness, 'SKU-1', 10);
    await harness.reserve.execute(new ReserveCommand(ORDER_ID, [{ sku: 'SKU-1', qty: 4 }]));

    const result = await harness.adjust.execute(
      new AdjustStockCommand('SKU-1', -4, 'breakage', 'damaged in transit'),
    );

    expect(result).toMatchObject({ onHand: 6, available: 2 });
    // Exactly on the reservation: the shelf still backs every promised unit.
    expect(() =>
      harness.adjust.execute(new AdjustStockCommand('SKU-1', -1, 'breakage-2', 'more')),
    ).not.toThrow();
  });

  it('answers a retried adjustment with the figures it already produced', async () => {
    const harness = context();
    await stock(harness, 'SKU-1', 10);
    const outboxAfterFirst = harness.repository.outbox.length;

    const again = await harness.adjust.execute(
      new AdjustStockCommand('SKU-1', 5, 'adj-SKU-1', 'seed the shelf'),
    );

    expect(again).toMatchObject({ onHand: 10, replayed: true });
    expect(harness.repository.stockLevels.get(`SKU-1|${WAREHOUSE}`)?.on_hand).toBe(10);
    expect(harness.repository.outbox).toHaveLength(outboxAfterFirst);
  });

  it('refuses a correction that would unback the hold, writing nothing', async () => {
    const harness = context();
    await stock(harness, 'SKU-1', 10);
    await harness.reserve.execute(new ReserveCommand(ORDER_ID, [{ sku: 'SKU-1', qty: 6 }]));
    harness.repository.outbox.length = 0;

    await expect(
      harness.adjust.execute(new AdjustStockCommand('SKU-1', -5, 'recount', 'wrong count')),
    ).rejects.toBeInstanceOf(ValidationException);

    expect(harness.repository.stockLevels.get(`SKU-1|${WAREHOUSE}`)).toMatchObject({
      on_hand: 10,
      reserved: 6,
    });
    // The refusal happens inside the aggregate: no correction row, no `stock.changed`.
    expect(harness.repository.adjustments.has('recount')).toBe(false);
    expect(harness.repository.outbox).toHaveLength(0);
  });

  it('refuses a request that could not be made idempotent', async () => {
    const harness = context();

    await expect(
      harness.adjust.execute(new AdjustStockCommand(' ', 1, 'adj', 'why')),
    ).rejects.toBeInstanceOf(ValidationException);
    await expect(
      harness.adjust.execute(new AdjustStockCommand('SKU-1', 1, '  ', 'why')),
    ).rejects.toBeInstanceOf(ValidationException);
    await expect(
      harness.adjust.execute(new AdjustStockCommand('SKU-1', 1, 'adj', ' ')),
    ).rejects.toBeInstanceOf(ValidationException);
    await expect(
      harness.adjust.execute(new AdjustStockCommand('SKU-1', 1.5, 'adj', 'why')),
    ).rejects.toBeInstanceOf(ValidationException);

    expect(harness.repository.commits).toBe(0);
  });
});

describe('GetAvailableQuery', () => {
  it('reads the derived triple for a pair that has been stocked', async () => {
    const harness = context();
    await stock(harness, 'SKU-1', 10);
    await harness.reserve.execute(new ReserveCommand(ORDER_ID, [{ sku: 'SKU-1', qty: 4 }]));

    await expect(harness.available.execute(new GetAvailableQuery('SKU-1'))).resolves.toEqual({
      sku: 'SKU-1',
      warehouseId: WAREHOUSE,
      onHand: 10,
      reserved: 4,
      safety: 0,
      available: 6,
    });
  });

  it('answers zeros for a pair nobody has ever stocked', async () => {
    const harness = context();

    // "Nothing here yet" is a fact, not a 404: every caller already handles a zero.
    await expect(harness.available.execute(new GetAvailableQuery('SKU-9'))).resolves.toEqual({
      sku: 'SKU-9',
      warehouseId: WAREHOUSE,
      onHand: 0,
      reserved: 0,
      safety: 0,
      available: 0,
    });
  });

  it('reads the warehouse the caller names, not only the default', async () => {
    const harness = context();
    await harness.adjust.execute(
      new AdjustStockCommand('SKU-1', 5, 'overflow-count', 'counted in overflow', 'overflow'),
    );

    await expect(
      harness.available.execute(new GetAvailableQuery('SKU-1', 'overflow')),
    ).resolves.toMatchObject({ warehouseId: 'overflow', available: 5 });
    await expect(harness.available.execute(new GetAvailableQuery('SKU-1'))).resolves.toMatchObject(
      { warehouseId: WAREHOUSE, available: 0 },
    );
  });

  it('refuses a blank sku', async () => {
    const harness = context();

    await expect(harness.available.execute(new GetAvailableQuery(' '))).rejects.toBeInstanceOf(
      ValidationException,
    );
  });
});
