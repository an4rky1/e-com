/**
 * @fileoverview The single write path for reserving stock.
 *
 * @remarks Commands are the only place mutations happen, so validation, event publication
 * and the idempotency rule have exactly one hook rather than one per entry point.
 *
 * @remarks The all-or-nothing rule itself is enforced inside the repository's transaction
 * — this handler validates the *request*, because a malformed request is a 400 the
 * database should never have to discover.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { ValidationException } from '@auth/platform/error-handling';
import {
  INVENTORY_REPOSITORY,
  type InventoryRepositoryPort,
} from '../../domain/ports/inventory-repository.port';
import { INVENTORY_CONFIG } from '../../inventory.config';
import type { InventoryConfig } from '../../inventory.config';
import { ReserveCommand, type ReserveResult } from './inventory.commands';

@Injectable()
@CommandHandler(ReserveCommand)
export class ReserveHandler implements ICommandHandler<ReserveCommand, ReserveResult> {
  constructor(
    @Inject(INVENTORY_REPOSITORY) private readonly inventory: InventoryRepositoryPort,
    @Inject(INVENTORY_CONFIG) private readonly config: InventoryConfig,
  ) {}

  async execute(command: ReserveCommand): Promise<ReserveResult> {
    const orderId = command.orderId?.trim() ?? '';
    if (orderId.length === 0) {
      throw new ValidationException('orderId is required', { orderId });
    }

    if (command.lines.length === 0) {
      // Refused rather than vacuously accepted: an empty reserve would still create a
      // reservation row, and `reservations.order_id` is unique — so the real reserve that
      // follows would be answered with the empty hold it just collided with.
      throw new ValidationException('reserve requires at least one line', { orderId });
    }

    for (const line of command.lines) {
      if (typeof line.sku !== 'string' || line.sku.trim().length === 0) {
        throw new ValidationException('every line needs a sku', { orderId });
      }
      if (!Number.isSafeInteger(line.qty) || line.qty <= 0) {
        throw new ValidationException('line quantity must be a positive integer', {
          orderId,
          sku: line.sku,
          qty: line.qty,
        });
      }
    }

    // A reserve writes *into* a warehouse, so "no warehouse" is a value, not an absence.
    const warehouseId = command.warehouseId?.trim() || this.config.defaultWarehouse;

    return this.inventory.reserveForOrder({ orderId, warehouseId, lines: command.lines });
  }
}
