/**
 * @fileoverview Releasing a hold: the cancel path's half of the reserve.
 *
 * @remarks Idempotent by construction rather than by a lookup table: the repository
 * answers `releasedLines: 0` for a hold that is already gone or already finished, so a
 * retried cancel is a no-op that neither fails nor announces a second `stock.released`.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { ValidationException } from '@auth/platform/error-handling';
import {
  INVENTORY_REPOSITORY,
  type InventoryRepositoryPort,
} from '../../domain/ports/inventory-repository.port';
import { ReleaseCommand, type ReleaseResult } from './inventory.commands';

@Injectable()
@CommandHandler(ReleaseCommand)
export class ReleaseHandler implements ICommandHandler<ReleaseCommand, ReleaseResult> {
  constructor(
    @Inject(INVENTORY_REPOSITORY) private readonly inventory: InventoryRepositoryPort,
  ) {}

  async execute(command: ReleaseCommand): Promise<ReleaseResult> {
    const orderId = command.orderId?.trim() ?? '';
    if (orderId.length === 0) {
      throw new ValidationException('orderId is required', { orderId });
    }

    // Deliberately *not* defaulted: an empty warehouse means "whatever the hold is in".
    // Filling in the configured default here would refuse a perfectly valid release
    // whenever the hold lives somewhere else.
    const warehouseId = command.warehouseId?.trim() || undefined;

    return this.inventory.releaseOrder({ orderId, warehouseId });
  }
}
