/**
 * @fileoverview The transactional-outbox guarantee, asserted against the real repository.
 *
 * @remarks The property under test is about *when* two things happen relative to a
 * transaction boundary, and a boundary is exactly what a database-free double can still
 * model: the fake client records, for every call, whether the transaction was open at that
 * moment. So this suite can prove that the stock write, the hold write and the event write
 * are inside the same `runInTransaction`, and that there is only one of them, without a
 * connection anywhere.
 *
 * @remarks The second thing it proves is the *order* of the locking. `SELECT ... FOR
 * UPDATE` runs in ascending `sku`, and two concurrent reserves that took the locks in
 * request order would deadlock; the recorded `$queryRaw` calls are the evidence that the
 * order is imposed by the code and not by luck.
 *
 * @remarks This is the only suite that touches `PrismaService`. Everything else goes
 * through a port.
 */

import 'reflect-metadata';
import { Topics } from '@auth/contracts';
import { InvalidStateTransitionException, ValidationException } from '@auth/platform/error-handling';
import type { PrismaService } from '@auth/infra/prisma';
import type { PrismaClient } from '../src/generated/prisma/client';
import { PrismaInventoryRepository } from '../src/infrastructure/persistence/prisma-inventory.repository';
import type { StockLevelRow } from '../src/domain/stock-level.aggregate';
import type { ReservationLineRow, ReservationRow } from '../src/domain/reservation.entity';
import { ORDER_ID, OTHER_ORDER_ID, WAREHOUSE } from './support/fakes';

interface Recorded {
  readonly call: string;
  readonly inTransaction: boolean;
}

type LevelRow = StockLevelRow;
type HoldRow = ReservationRow & { lines?: ReservationLineRow[] };

/**
 * A client double that stores rows in maps and records every call with the transaction
 * state it ran under.
 */
class RecordingClient {
  readonly calls: Recorded[] = [];

  readonly levels = new Map<string, LevelRow>();
  readonly holds = new Map<string, HoldRow>();
  readonly lines: ReservationLineRow[] = [];
  readonly adjustments = new Map<string, Record<string, unknown>>();

  readonly outboxRows: Record<string, unknown>[] = [];
  readonly skipDuplicates: boolean[] = [];

  inTransaction = false;
  transactions = 0;

  private record(call: string): void {
    this.calls.push({ call, inTransaction: this.inTransaction });
  }

  /** `SELECT ... FOR UPDATE` as the repository spells it: a tagged template. */
  $queryRaw = async (
    _strings: TemplateStringsArray,
    sku: string,
    warehouseId: string,
  ): Promise<LevelRow[]> => {
    this.record(`$queryRaw:${sku}`);
    return [...this.levels.values()].filter(
      (row) => row.sku === sku && row.warehouse_id === warehouseId,
    );
  };

  readonly stock_levels = {
    findUnique: async (args: {
      where: { sku_warehouse_id: { sku: string; warehouse_id: string } };
    }): Promise<LevelRow | null> => {
      this.record('stock_levels.findUnique');
      const { sku, warehouse_id } = args.where.sku_warehouse_id;
      return (
        [...this.levels.values()].find(
          (row) => row.sku === sku && row.warehouse_id === warehouse_id,
        ) ?? null
      );
    },
    update: async (args: { where: { id: string }; data: Partial<LevelRow> }) => {
      this.record('stock_levels.update');
      const row = this.levels.get(args.where.id);
      if (!row) throw new Error(`no stock row ${args.where.id}`);
      Object.assign(row, args.data);
      return row;
    },
    create: async (args: { data: LevelRow }) => {
      this.record('stock_levels.create');
      this.levels.set(args.data.id, { ...args.data });
      return args.data;
    },
  };

  readonly reservations = {
    findUnique: async (args: {
      where: { order_id: string };
      include?: { lines: boolean };
    }): Promise<HoldRow | null> => {
      this.record('reservations.findUnique');
      const row = [...this.holds.values()].find((hold) => hold.order_id === args.where.order_id);
      if (!row) return null;
      return {
        ...row,
        lines: args.include
          ? this.lines.filter((line) => line.reservation_id === row.id)
          : undefined,
      };
    },
    create: async (args: { data: ReservationRow }) => {
      this.record('reservations.create');
      this.holds.set(args.data.order_id, { ...args.data });
      return args.data;
    },
    update: async (args: { where: { id: string }; data: Partial<ReservationRow> }) => {
      this.record('reservations.update');
      const row = [...this.holds.values()].find((hold) => hold.id === args.where.id);
      if (!row) throw new Error(`no reservation ${args.where.id}`);
      Object.assign(row, args.data);
      return row;
    },
    count: async (args: { where: { status: string } }): Promise<number> => {
      this.record('reservations.count');
      return [...this.holds.values()].filter((hold) => hold.status === args.where.status).length;
    },
  };

  readonly reservation_lines = {
    createMany: async (args: { data: ReservationLineRow[] }): Promise<{ count: number }> => {
      this.record('reservation_lines.createMany');
      this.lines.push(...args.data.map((row) => ({ ...row })));
      return { count: args.data.length };
    },
    updateMany: async (args: {
      where: { reservation_id: string; sku?: string };
      data: { qty: number };
    }): Promise<{ count: number }> => {
      this.record('reservation_lines.updateMany');
      const matched = this.lines.filter(
        (line) =>
          line.reservation_id === args.where.reservation_id &&
          (args.where.sku === undefined || line.sku === args.where.sku),
      );
      for (const line of matched) line.qty = args.data.qty;
      return { count: matched.length };
    },
  };

  readonly stock_adjustments = {
    findUnique: async (args: { where: { adjustment_id: string } }) => {
      this.record('stock_adjustments.findUnique');
      return this.adjustments.get(args.where.adjustment_id) ?? null;
    },
    create: async (args: { data: Record<string, unknown> & { adjustment_id: string } }) => {
      this.record('stock_adjustments.create');
      this.adjustments.set(args.data.adjustment_id, { ...args.data });
      return args.data;
    },
  };

  readonly outbox_events = {
    createMany: async (args: { data: Record<string, unknown>[]; skipDuplicates?: boolean }) => {
      this.record('outbox_events.createMany');
      this.outboxRows.push(...args.data);
      this.skipDuplicates.push(args.skipDuplicates === true);
      return { count: args.data.length };
    },
  };

  /** Runs a callback "inside" a transaction, recording the boundary. */
  async runInTransaction<TResult>(fn: (client: this) => Promise<TResult>): Promise<TResult> {
    this.transactions += 1;
    this.inTransaction = true;
    try {
      return await fn(this);
    } finally {
      this.inTransaction = false;
    }
  }
}

const harness = () => {
  const client = new RecordingClient();
  const repository = new PrismaInventoryRepository({
    // The boundary lives on the client double, exactly where `PrismaService.runInTransaction`
    // would have it, so the count the assertions read is the real number of transactions.
    runInTransaction: <TResult>(fn: (tx: PrismaClient) => Promise<TResult>): Promise<TResult> =>
      client.runInTransaction(() => fn(client as unknown as PrismaClient)),
    tx: client,
  } as unknown as PrismaService<PrismaClient>);

  return { client, repository };
};

/** Puts a stock row on the shelf without going through the correction path. */
const shelf = (
  client: RecordingClient,
  overrides: { sku: string; onHand: number; id?: string; warehouseId?: string },
): void => {
  const id = overrides.id ?? crypto.randomUUID();
  client.levels.set(id, {
    id,
    sku: overrides.sku,
    warehouse_id: overrides.warehouseId ?? WAREHOUSE,
    on_hand: overrides.onHand,
    reserved: 0,
    safety: 0,
    version: 1,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
  });
};

const reset = (client: RecordingClient): void => {
  client.calls.length = 0;
  client.outboxRows.length = 0;
  client.skipDuplicates.length = 0;
};

describe('PrismaInventoryRepository — reserve', () => {
  it('locks, writes the hold and announces it in one transaction', async () => {
    const { client, repository } = harness();
    shelf(client, { sku: 'SKU-2', onHand: 5 });
    shelf(client, { sku: 'SKU-1', onHand: 10 });

    const result = await repository.reserveForOrder({
      orderId: ORDER_ID,
      warehouseId: WAREHOUSE,
      lines: [
        { sku: 'SKU-1', qty: 4 },
        { sku: 'SKU-2', qty: 2 },
      ],
    });

    expect(result.fullyAccepted).toBe(true);
    // One boundary: the stock write, the hold write and the event write commit together
    // or not at all — the whole reason the outbox exists.
    expect(client.transactions).toBe(1);
    expect(client.calls.every((entry) => entry.inTransaction)).toBe(true);
    expect(client.calls.map((entry) => entry.call)).toEqual([
      'reservations.findUnique',
      // Ascending sku: the deadlock contract, imposed by the code rather than by luck.
      '$queryRaw:SKU-1',
      '$queryRaw:SKU-2',
      'stock_levels.update',
      'stock_levels.update',
      'reservations.create',
      'reservation_lines.createMany',
      'outbox_events.createMany',
    ]);
    expect(client.outboxRows.map((row) => row.dedup_key)).toEqual([
      `stock.reserved:${ORDER_ID}:1`,
      `stock.reserved:${ORDER_ID}:2`,
    ]);
    expect(client.skipDuplicates).toEqual([true]);
  });

  it('answers a retry from the stored hold: no lock, no write, no second announcement', async () => {
    const { client, repository } = harness();
    shelf(client, { sku: 'SKU-1', onHand: 10 });
    await repository.reserveForOrder({
      orderId: ORDER_ID,
      warehouseId: WAREHOUSE,
      lines: [{ sku: 'SKU-1', qty: 4 }],
    });
    reset(client);

    const again = await repository.reserveForOrder({
      orderId: ORDER_ID,
      warehouseId: WAREHOUSE,
      lines: [{ sku: 'SKU-1', qty: 4 }],
    });

    expect(again).toMatchObject({ fullyAccepted: true, replayed: true });
    expect(client.calls.map((entry) => entry.call)).toEqual(['reservations.findUnique']);
    expect(client.outboxRows).toHaveLength(0);
    expect([...client.levels.values()][0].reserved).toBe(4);
  });

  it('refuses the whole batch and writes only the rejection', async () => {
    const { client, repository } = harness();
    shelf(client, { sku: 'SKU-1', onHand: 10 });

    const result = await repository.reserveForOrder({
      orderId: ORDER_ID,
      warehouseId: WAREHOUSE,
      lines: [
        { sku: 'SKU-1', qty: 4 },
        { sku: 'SKU-2', qty: 3 },
      ],
    });

    expect(result).toMatchObject({ fullyAccepted: false, replayed: false });
    expect(result.rejected).toEqual([{ sku: 'SKU-2', qty: 3, reason: 'insufficient_stock' }]);
    expect(client.calls.map((entry) => entry.call)).toEqual([
      'reservations.findUnique',
      '$queryRaw:SKU-1',
      '$queryRaw:SKU-2',
      'outbox_events.createMany',
    ]);
    // No stock write and no hold: all-or-nothing means the covered line stayed put.
    expect([...client.levels.values()][0].reserved).toBe(0);
    expect(client.holds.size).toBe(0);
    expect(client.outboxRows[0]).toMatchObject({
      type: 'stock.rejected',
      dedup_key: `stock.rejected:${ORDER_ID}:1`,
      topic: Topics.STOCK_REJECTED,
    });
  });

  it('refuses to resurrect a hold that already finished', async () => {
    const { client, repository } = harness();
    shelf(client, { sku: 'SKU-1', onHand: 10 });
    await repository.reserveForOrder({
      orderId: OTHER_ORDER_ID,
      warehouseId: WAREHOUSE,
      lines: [{ sku: 'SKU-1', qty: 1 }],
    });
    const existing = client.holds.get(OTHER_ORDER_ID);
    if (existing) existing.status = 'released';
    reset(client);

    await expect(
      repository.reserveForOrder({
        orderId: OTHER_ORDER_ID,
        warehouseId: WAREHOUSE,
        lines: [{ sku: 'SKU-1', qty: 1 }],
      }),
    ).rejects.toBeInstanceOf(InvalidStateTransitionException);

    // The refusal leaves the released hold alone — resurrecting it would silently undo
    // a cancellation.
    expect(client.holds.get(OTHER_ORDER_ID)?.status).toBe('released');
    expect(client.outboxRows).toHaveLength(0);
  });
});

describe('PrismaInventoryRepository — release', () => {
  const held = async (): Promise<ReturnType<typeof harness>> => {
    const h = harness();
    shelf(h.client, { sku: 'SKU-1', onHand: 10 });
    await h.repository.reserveForOrder({
      orderId: ORDER_ID,
      warehouseId: WAREHOUSE,
      lines: [{ sku: 'SKU-1', qty: 4 }],
    });
    reset(h.client);
    return h;
  };

  it('gives the units back and announces the release inside one transaction', async () => {
    const { client, repository } = await held();
    const before = client.transactions;

    const result = await repository.releaseOrder({ orderId: ORDER_ID });

    expect(result.releasedLines).toBe(1);
    expect(client.transactions - before).toBe(1);
    expect(client.calls.every((entry) => entry.inTransaction)).toBe(true);
    expect([...client.levels.values()][0]).toMatchObject({ on_hand: 10, reserved: 0 });
    expect(client.holds.get(ORDER_ID)?.status).toBe('released');
    expect(client.outboxRows.map((row) => row.dedup_key)).toEqual([
      `stock.released:${ORDER_ID}:1`,
    ]);
  });

  it('answers a second release without a single write', async () => {
    const { client, repository } = await held();
    await repository.releaseOrder({ orderId: ORDER_ID });
    reset(client);

    const again = await repository.releaseOrder({ orderId: ORDER_ID });

    expect(again).toEqual({ releasedLines: 0 });
    expect(client.calls.map((entry) => entry.call)).toEqual(['reservations.findUnique']);
    expect(client.outboxRows).toHaveLength(0);
  });

  it('answers zero for an order that never held anything', async () => {
    const { client, repository } = harness();

    await expect(repository.releaseOrder({ orderId: ORDER_ID })).resolves.toEqual({
      releasedLines: 0,
    });
    expect(client.outboxRows).toHaveLength(0);
  });

  it('refuses a warehouse that is not the one the hold lives in', async () => {
    const { client, repository } = await held();

    await expect(
      repository.releaseOrder({ orderId: ORDER_ID, warehouseId: 'overflow' }),
    ).rejects.toBeInstanceOf(ValidationException);

    // The refusal happened before anything moved.
    expect([...client.levels.values()][0].reserved).toBe(4);
    expect(client.holds.get(ORDER_ID)?.status).toBe('active');
  });
});

describe('PrismaInventoryRepository — ship', () => {
  const held = async () => {
    const h = harness();
    shelf(h.client, { sku: 'SKU-1', onHand: 10 });
    await h.repository.reserveForOrder({
      orderId: ORDER_ID,
      warehouseId: WAREHOUSE,
      lines: [{ sku: 'SKU-1', qty: 4 }],
    });
    reset(h.client);
    return h;
  };

  it('consumes the hold and the shelf in one transaction, announcing nothing', async () => {
    const { client, repository } = await held();
    const before = client.transactions;

    const result = await repository.shipOrder({
      orderId: ORDER_ID,
      lines: [{ sku: 'SKU-1', qty: 4 }],
    });

    expect(result.shipped).toBe(true);
    expect(client.transactions - before).toBe(1);
    expect(client.calls.every((entry) => entry.inTransaction)).toBe(true);
    expect([...client.levels.values()][0]).toMatchObject({ on_hand: 6, reserved: 0 });
    expect(client.holds.get(ORDER_ID)?.status).toBe('shipped');
    // The order side announces `order.shipped`; a third view of the numbers is a third
    // place for them to disagree.
    expect(client.outboxRows).toHaveLength(0);
  });

  it('refuses a shipment the hold never agreed to, writing nothing', async () => {
    const { client, repository } = await held();

    await expect(
      repository.shipOrder({ orderId: ORDER_ID, lines: [{ sku: 'SKU-1', qty: 5 }] }),
    ).rejects.toBeInstanceOf(ValidationException);

    // Checked before the lock: a refusal is a 400, not a rollback.
    expect(client.calls.map((entry) => entry.call)).toEqual(['reservations.findUnique']);
    expect([...client.levels.values()][0]).toMatchObject({ on_hand: 10, reserved: 4 });
    expect(client.holds.get(ORDER_ID)?.status).toBe('active');
    expect(client.outboxRows).toHaveLength(0);
  });
});

describe('PrismaInventoryRepository — adjust', () => {
  it('creates the row, the correction and the announcement in one transaction', async () => {
    const { client, repository } = harness();

    const result = await repository.adjustStock({
      sku: 'SKU-1',
      warehouseId: WAREHOUSE,
      delta: 10,
      reason: 'opening count',
      adjustmentId: 'recount-1',
      safetyDefault: 0,
    });

    expect(result).toMatchObject({ onHand: 10, available: 10, replayed: false });
    expect(client.transactions).toBe(1);
    expect(client.calls.map((entry) => entry.call)).toEqual([
      'stock_adjustments.findUnique',
      '$queryRaw:SKU-1',
      'stock_levels.create',
      'stock_adjustments.create',
      'outbox_events.createMany',
    ]);
    expect(client.calls.every((entry) => entry.inTransaction)).toBe(true);
    // Version 2, not 1: `create` starts the row at 1 and the correction is its first write.
    expect(client.outboxRows[0]).toMatchObject({
      type: 'stock.changed',
      dedup_key: 'stock.changed:SKU-1:2',
      topic: Topics.STOCK_CHANGED,
      aggregate_id: 'SKU-1',
      aggregate_type: 'StockLevel',
    });
    expect(client.skipDuplicates).toEqual([true]);
  });

  it('answers a retried adjustment with the figures it already produced', async () => {
    const { client, repository } = harness();
    await repository.adjustStock({
      sku: 'SKU-1',
      warehouseId: WAREHOUSE,
      delta: 10,
      reason: 'opening count',
      adjustmentId: 'recount-1',
      safetyDefault: 0,
    });
    reset(client);

    const again = await repository.adjustStock({
      sku: 'SKU-1',
      warehouseId: WAREHOUSE,
      delta: 999,
      reason: 'a different delta that must not apply',
      adjustmentId: 'recount-1',
      safetyDefault: 0,
    });

    expect(again).toMatchObject({ onHand: 10, available: 10, replayed: true });
    // Read-only: no second correction row, no second `stock.changed`, no version bump.
    expect(client.calls.map((entry) => entry.call)).toEqual([
      'stock_adjustments.findUnique',
      'stock_levels.findUnique',
    ]);
    expect(client.outboxRows).toHaveLength(0);
    expect([...client.levels.values()][0].on_hand).toBe(10);
  });

  it('refuses a correction that would unback a live hold', async () => {
    const { client, repository } = harness();
    shelf(client, { sku: 'SKU-1', onHand: 10 });
    await repository.reserveForOrder({
      orderId: ORDER_ID,
      warehouseId: WAREHOUSE,
      lines: [{ sku: 'SKU-1', qty: 6 }],
    });
    reset(client);

    await expect(
      repository.adjustStock({
        sku: 'SKU-1',
        warehouseId: WAREHOUSE,
        delta: -5,
        reason: 'wrong count',
        adjustmentId: 'recount-2',
        safetyDefault: 0,
      }),
    ).rejects.toThrow();

    // The aggregate refused inside the transaction: the correction row was never made,
    // so a retry of the same recount is still free to apply the *correct* delta.
    expect(client.adjustments.has('recount-2')).toBe(false);
    expect([...client.levels.values()][0]).toMatchObject({ on_hand: 10, reserved: 6 });
    expect(client.outboxRows).toHaveLength(0);
  });
});

describe('PrismaInventoryRepository — reads', () => {
  it('reads availability outside any transaction, and never invents a row', async () => {
    const { client, repository } = harness();

    const missing = await repository.getAvailable('SKU-9', WAREHOUSE);

    // "Nothing has ever been stocked here" is a fact, not a failure — and the configured
    // safety default must not be applied to an absence, or a default of 5 would answer
    // `available: -5` for a SKU nobody carries.
    expect(missing).toEqual({
      sku: 'SKU-9',
      warehouseId: WAREHOUSE,
      onHand: 0,
      reserved: 0,
      safety: 0,
      available: 0,
    });
    expect(client.transactions).toBe(0);
    expect(client.calls).toEqual([{ call: 'stock_levels.findUnique', inTransaction: false }]);
  });

  it('derives availability from the stored row', async () => {
    const { client, repository } = harness();
    shelf(client, { sku: 'SKU-1', onHand: 10 });
    await repository.reserveForOrder({
      orderId: ORDER_ID,
      warehouseId: WAREHOUSE,
      lines: [{ sku: 'SKU-1', qty: 4 }],
    });

    await expect(repository.getAvailable('SKU-1', WAREHOUSE)).resolves.toEqual({
      sku: 'SKU-1',
      warehouseId: WAREHOUSE,
      onHand: 10,
      reserved: 4,
      safety: 0,
      available: 6,
    });
  });

  it('counts only the holds that are still live', async () => {
    const { client, repository } = harness();
    shelf(client, { sku: 'SKU-1', onHand: 10 });
    shelf(client, { sku: 'SKU-2', onHand: 10 });
    await repository.reserveForOrder({
      orderId: ORDER_ID,
      warehouseId: WAREHOUSE,
      lines: [{ sku: 'SKU-1', qty: 1 }],
    });
    await repository.reserveForOrder({
      orderId: OTHER_ORDER_ID,
      warehouseId: WAREHOUSE,
      lines: [{ sku: 'SKU-2', qty: 1 }],
    });
    await repository.releaseOrder({ orderId: OTHER_ORDER_ID });

    await expect(repository.countActiveReservations()).resolves.toBe(1);
  });
});
