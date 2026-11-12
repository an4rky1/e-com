/**
 * @fileoverview Shipping a hold: the warehouse's half of the reserve.
 *
 * @remarks Validates the request; the all-or-nothing coverage check and the row locks
 * live in the repository, because they are properties of the transaction rather than of
 * the input.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { ValidationException } from '@auth/platform/error-handling';
import {
  INVENTORY_REPOSITORY,
  type InventoryRepositoryPort,
} from '../../domain/ports/inventory-repository.port';
import { ShipCommand, type ShipResult } from './inventory.commands';

@Injectable()
@CommandHandler(ShipCommand)
export class ShipHandler implements ICommandHandler<ShipCommand, ShipResult> {
  constructor(
    @Inject(INVENTORY_REPOSITORY) private readonly inventory: InventoryRepositoryPort,
  ) {}

  async execute(command: ShipCommand): Promise<ShipResult> {
    const orderId = command.orderId?.trim() ?? '';
    if (orderId.length === 0) {
      throw new ValidationException('orderId is required', { orderId });
    }

    if (command.lines.length === 0) {
      // Nothing to ship is a caller mistake, not a successful no-op: the response's
      // `shipped: true` would claim stock left the shelf when none did.
      throw new ValidationException('ship requires at least one line', { orderId });
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

    const warehouseId = command.warehouseId?.trim() || undefined;

    return this.inventory.shipOrder({ orderId, warehouseId, lines: command.lines });
  }
}
