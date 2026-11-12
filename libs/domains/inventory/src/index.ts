/**
 * @fileoverview The public surface of the inventory domain.
 *
 * @remarks The barrel is deliberately explicit rather than `export *`: a consumer
 * importing from here should be able to see, in one screen, the whole contract this
 * service offers — and a wildcard would quietly widen it every time a helper is added
 * under `src/`.
 *
 * @remarks Three audiences. {@link InventoryService} is what an application calls; the
 * controller and the module factory are what `apps/inventory` wires; everything else
 * exists so a test in another service can assert against the same rules.
 */

// ---- configuration -------------------------------------------------------------
export {
  INVENTORY_CONFIG,
  INVENTORY_PRISMA,
  Defaults as InventoryDefaults,
  inventorySchema,
  resolveInventoryConfig,
  type InventoryConfig,
  type InventoryEnvConfig,
} from './inventory.config';

// ---- module --------------------------------------------------------------------
export {
  INVENTORY_MODULE_OPTIONS,
  InventoryModule,
  createInventoryModule,
  type InventoryModuleOptions,
} from './inventory.module';
export { InventoryHealthIndicator } from './inventory.health';

// ---- commands ------------------------------------------------------------------
export {
  AdjustStockCommand,
  ReleaseCommand,
  ReserveCommand,
  ShipCommand,
  type AdjustResult,
  type ReleaseResult,
  type ReserveResult,
  type ShipResult,
} from './application/commands/inventory.commands';
export { ReserveHandler } from './application/commands/reserve.handler';
export { ReleaseHandler } from './application/commands/release.handler';
export { ShipHandler } from './application/commands/ship.handler';
export { AdjustStockHandler } from './application/commands/adjust-stock.handler';

// ---- queries -------------------------------------------------------------------
export {
  GetAvailableHandler,
  GetAvailableQuery,
} from './application/queries/inventory.queries';

// ---- application ---------------------------------------------------------------
export { InventoryService } from './application/facade/inventory.service';

// ---- domain --------------------------------------------------------------------
export {
  StockLevel,
  type StockAvailability,
  type StockLevelProps,
  type StockLevelRow,
} from './domain/stock-level.aggregate';
export {
  Reservation,
  TERMINAL_RESERVATION_STATUSES,
  isReservationStatus,
  type ReservationLine,
  type ReservationLineRow,
  type ReservationProps,
  type ReservationRow,
  type ReservationStatus,
} from './domain/reservation.entity';
export {
  RESERVATION_AGGREGATE,
  STOCK_LEVEL_AGGREGATE,
  StockChanged,
  StockRejected,
  StockReleased,
  StockReserved,
  stockRejectedEvents,
  stockReleasedEvent,
  stockReservedEvents,
  type RejectedLineInput,
} from './domain/inventory.events';
export {
  INVENTORY_REPOSITORY,
  type AdjustResult as InventoryAdjustResult,
  type AdjustStockInput,
  type InventoryRepositoryPort,
  type RejectedLineResult,
  type ReleaseResult as InventoryReleaseResult,
  type ReserveLineInput,
  type ReserveResult as InventoryReserveResult,
  type ShipResult as InventoryShipResult,
} from './domain/ports/inventory-repository.port';

// ---- presentation --------------------------------------------------------------
export { InventoryGrpcController } from './presentation/grpc/inventory.grpc.controller';

// ---- infrastructure ------------------------------------------------------------
export { PrismaInventoryRepository } from './infrastructure/persistence/prisma-inventory.repository';
export {
  enqueueEvents,
  type EnqueueEventsOptions,
} from './infrastructure/persistence/outbox-enqueue';
