/**
 * @fileoverview The single write path for correcting stock.
 *
 * @remarks `adjustmentId` is the idempotency key: a recount job that retries must not
 * apply the same delta twice, and the unique index on `stock_adjustments.adjustment_id`
 * is what makes the retry answer with the figures it already produced instead of moving
 * stock again.
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
import { AdjustStockCommand, type AdjustResult } from './inventory.commands';

@Injectable()
@CommandHandler(AdjustStockCommand)
export class AdjustStockHandler
  implements ICommandHandler<AdjustStockCommand, AdjustResult>
{
  constructor(
    @Inject(INVENTORY_REPOSITORY) private readonly inventory: InventoryRepositoryPort,
    @Inject(INVENTORY_CONFIG) private readonly config: InventoryConfig,
  ) {}

  async execute(command: AdjustStockCommand): Promise<AdjustResult> {
    const sku = command.sku?.trim() ?? '';
    if (sku.length === 0) {
      throw new ValidationException('sku is required', { sku: command.sku });
    }

    const adjustmentId = command.adjustmentId?.trim() ?? '';
    if (adjustmentId.length === 0) {
      // Without it there is no idempotency: every retry would be a fresh correction, and
      // a recount that runs twice would apply its delta twice.
      throw new ValidationException('adjustmentId is required', { sku });
    }

    if (!Number.isSafeInteger(command.delta)) {
      throw new ValidationException('delta must be an integer', { sku, delta: command.delta });
    }

    const reason = command.reason?.trim() ?? '';
    if (reason.length === 0) {
      throw new ValidationException('reason is required', { sku, adjustmentId });
    }

    const warehouseId = command.warehouseId?.trim() || this.config.defaultWarehouse;

    return this.inventory.adjustStock({
      sku,
      warehouseId,
      delta: command.delta,
      reason,
      adjustmentId,
      safetyDefault: this.config.safetyDefault,
    });
  }
}
