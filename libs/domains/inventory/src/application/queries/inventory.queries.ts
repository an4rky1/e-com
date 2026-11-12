/**
 * @fileoverview What an availability check answers.
 *
 * @remarks Like every query in this workspace it is a class: `QueryBus.execute` resolves a
 * handler from `query.constructor`, and a plain object cannot dispatch.
 *
 * @remarks The read model is the derived triple, not a stored column: `available` is
 * computed by the aggregate so the number a caller acts on is the same number the reserve
 * check uses. A second, SQL-side copy would drift from it.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Query, QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { ValidationException } from '@auth/platform/error-handling';
import {
  INVENTORY_REPOSITORY,
  type InventoryRepositoryPort,
} from '../../domain/ports/inventory-repository.port';
import type { StockAvailability } from '../../domain/stock-level.aggregate';
import { INVENTORY_CONFIG } from '../../inventory.config';
import type { InventoryConfig } from '../../inventory.config';

export class GetAvailableQuery extends Query<StockAvailability> {
  readonly queryId: string = crypto.randomUUID();

  constructor(
    readonly sku: string,
    readonly warehouseId?: string,
  ) {
    super();
  }
}

@Injectable()
@QueryHandler(GetAvailableQuery)
export class GetAvailableHandler
  implements IQueryHandler<GetAvailableQuery, StockAvailability>
{
  constructor(
    @Inject(INVENTORY_REPOSITORY) private readonly inventory: InventoryRepositoryPort,
    @Inject(INVENTORY_CONFIG) private readonly config: InventoryConfig,
  ) {}

  async execute(query: GetAvailableQuery): Promise<StockAvailability> {
    const sku = query.sku?.trim() ?? '';
    if (sku.length === 0) {
      throw new ValidationException('sku is required', { sku: query.sku });
    }

    // Reading defaults to the configured warehouse: a caller that names nothing is the
    // single-warehouse deployment, and answering with a blank key would return zeros for
    // a SKU that is in stock.
    const warehouseId = query.warehouseId?.trim() || this.config.defaultWarehouse;

    return this.inventory.getAvailable(sku, warehouseId);
  }
}
