/**
 * @fileoverview The only public surface of the inventory module.
 *
 * @remarks Everything that talks to this service — the gRPC controller, a future saga, a
 * test in another lib — depends on this class and nothing else. It therefore cannot reach
 * the repository, the CQRS bus or the aggregates, which is what makes the module's
 * internals replaceable without touching a single caller.
 *
 * @remarks It speaks in domain results, never in proto messages: the transport shape
 * belongs to the presentation layer, and a second copy of it here would be a second thing
 * to keep in step with `inventory.proto`.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  AdjustStockCommand,
  ReleaseCommand,
  ReserveCommand,
  ShipCommand,
  type AdjustResult,
  type ReleaseResult,
  type ReserveResult,
  type ShipResult,
} from '../commands/inventory.commands';
import type { ReserveLineInput } from '../../domain/ports/inventory-repository.port';
import type { StockAvailability } from '../../domain/stock-level.aggregate';
import { GetAvailableQuery } from '../queries/inventory.queries';

@Injectable()
export class InventoryService {
  constructor(
    // Explicit tokens rather than relying on `design:paramtypes`: a type-only import is
    // erased before the decorator metadata is emitted, so the parameter would arrive as
    // `Object` and the container would have nothing to resolve it against.
    @Inject(CommandBus) private readonly commandBus: CommandBus,
    @Inject(QueryBus) private readonly queryBus: QueryBus,
  ) {}

  /**
   * Reserves every line for an order, or none of them.
   *
   * @remarks A retry for the same order answers with the hold it already made — see
   * {@link ReserveResult.replayed} for how a caller tells the two apart in a log.
   */
  reserve(input: {
    orderId: string;
    lines: readonly ReserveLineInput[];
    warehouseId?: string;
  }): Promise<ReserveResult> {
    return this.commandBus.execute(
      new ReserveCommand(input.orderId, input.lines, input.warehouseId),
    );
  }

  /** Gives back everything the order still holds. Repeating it changes nothing. */
  release(input: { orderId: string; warehouseId?: string }): Promise<ReleaseResult> {
    return this.commandBus.execute(new ReleaseCommand(input.orderId, input.warehouseId));
  }

  /** Consumes the requested lines out of the hold and off the shelf. */
  ship(input: {
    orderId: string;
    lines: readonly ReserveLineInput[];
    warehouseId?: string;
  }): Promise<ShipResult> {
    return this.commandBus.execute(
      new ShipCommand(input.orderId, input.lines, input.warehouseId),
    );
  }

  /** Applies a signed correction once per `adjustmentId`; a repeat changes nothing. */
  adjustStock(input: {
    sku: string;
    delta: number;
    adjustmentId: string;
    reason: string;
    warehouseId?: string;
  }): Promise<AdjustResult> {
    return this.commandBus.execute(
      new AdjustStockCommand(
        input.sku,
        input.delta,
        input.adjustmentId,
        input.reason,
        input.warehouseId,
      ),
    );
  }

  /**
   * Reads one `(sku, warehouse)` availability.
   *
   * @remarks Answers zeros for a pair that has never been stocked rather than failing:
   * "nothing here yet" is a fact, and every caller already has to handle a zero.
   */
  getAvailable(input: { sku: string; warehouseId?: string }): Promise<StockAvailability> {
    return this.queryBus.execute(new GetAvailableQuery(input.sku, input.warehouseId));
  }
}
