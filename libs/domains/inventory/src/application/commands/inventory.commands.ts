/**
 * @fileoverview Commands for the stock ledger, and the results they return.
 *
 * @remarks A command is an intent, not a DTO: it carries the caller's *decision*, while the
 * transport shape stays in the presentation layer. Keeping them apart means renaming a
 * proto field never reaches the domain.
 *
 * @remarks Classes, not interfaces. `CommandBus.execute` resolves a handler from
 * `command.constructor`, and `@CommandHandler` reads its metadata off the class it is
 * given — a plain object literal cannot dispatch at all.
 */
import { Command } from '@nestjs/cqrs';
import type {
  AdjustResult,
  ReleaseResult,
  ReserveLineInput,
  ReserveResult,
  ShipResult,
} from '../../domain/ports/inventory-repository.port';

/**
 * The results a command answers with, re-exported so a caller needs only this module.
 *
 * @remarks Aliases, not copies: a second definition of `ReserveResult` would be a list of
 * fields that can drift from the port the repository actually implements, and the drift
 * would only show up as a missing property at runtime.
 */
export type {
  AdjustResult,
  ReleaseResult,
  ReserveResult,
  ShipResult,
} from '../../domain/ports/inventory-repository.port';

/**
 * Holds every line for an order, or none of them.
 *
 * @remarks `warehouseId` is optional on purpose: a single-warehouse deployment should not
 * have to repeat a value the configuration already knows.
 */
export class ReserveCommand extends Command<ReserveResult> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly orderId: string,
    readonly lines: readonly ReserveLineInput[],
    readonly warehouseId?: string,
  ) {
    super();
  }
}

/** Gives back everything the order still holds. Safe to retry: a repeat changes nothing. */
export class ReleaseCommand extends Command<ReleaseResult> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly orderId: string,
    readonly warehouseId?: string,
  ) {
    super();
  }
}

/** Consumes the requested lines out of the hold and off the shelf. */
export class ShipCommand extends Command<ShipResult> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly orderId: string,
    readonly lines: readonly ReserveLineInput[],
    readonly warehouseId?: string,
  ) {
    super();
  }
}

/** Applies a signed correction, once per `adjustmentId`. */
export class AdjustStockCommand extends Command<AdjustResult> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly sku: string,
    readonly delta: number,
    readonly adjustmentId: string,
    readonly reason: string,
    readonly warehouseId?: string,
  ) {
    super();
  }
}
