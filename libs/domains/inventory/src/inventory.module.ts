/**
 * @fileoverview Nest wiring for the inventory service.
 *
 * @remarks A factory rather than a static `@Module`, so the configuration is resolved when
 * the module is built rather than when its metadata is evaluated at import time — a module
 * that reads the environment during `import` cannot be tested, and cannot be told which
 * environment it is in.
 *
 * @remarks Every provider is bound through a `Symbol` token declared by a port, so the
 * application layer never names a class from `infrastructure/`. The wiring is the only
 * place that knows a Prisma client is the implementation of the port the aggregates were
 * written against.
 *
 * @remarks The outbox is wired here rather than left to the host. `OutboxModule` is
 * global, and a global module cannot see a provider declared by the module that imports
 * it — so an outbox repository supplied "from outside" is never injected, and the relay
 * fails to bind to *this* service's tables.
 *
 * @remarks `InventoryGrpcController` is registered here but attached in the app's
 * bootstrap with `connectMicroservice`: a microservice has to join an existing HTTP server
 * rather than open its own.
 */
import { Module, type DynamicModule } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { PrismaService } from '@auth/infra/prisma';
import {
  createOutboxModule,
  PrismaOutboxRepository,
  type EventPublisher,
} from '@auth/infra/outbox';
import { PrismaClient } from './generated/prisma/client';
import { ReserveHandler } from './application/commands/reserve.handler';
import { ReleaseHandler } from './application/commands/release.handler';
import { ShipHandler } from './application/commands/ship.handler';
import { AdjustStockHandler } from './application/commands/adjust-stock.handler';
import { GetAvailableHandler } from './application/queries/inventory.queries';
import { InventoryService } from './application/facade/inventory.service';
import { INVENTORY_REPOSITORY } from './domain/ports/inventory-repository.port';
import { PrismaInventoryRepository } from './infrastructure/persistence/prisma-inventory.repository';
import { InventoryGrpcController } from './presentation/grpc/inventory.grpc.controller';
import { InventoryHealthIndicator } from './inventory.health';
import {
  INVENTORY_CONFIG,
  INVENTORY_PRISMA,
  resolveInventoryConfig,
} from './inventory.config';

/**
 * DI token carrying the factory's options.
 *
 * @remarks Kept from the E0 shell so a consumer that imported it before the domain was
 * filled in still resolves; nothing in this module reads it back, because the publisher is
 * handed straight to the outbox.
 */
export const INVENTORY_MODULE_OPTIONS = Symbol('INVENTORY_MODULE_OPTIONS');

@Module({})
export class InventoryModule {}

export interface InventoryModuleOptions {
  /** Transport the outbox publishes through; supplied by the app, which owns process wiring. */
  publisher: EventPublisher;
}

/**
 * Assembles the inventory service.
 *
 * @remarks One Prisma client is shared by the repository and the outbox. A second client
 * would open a second connection and commit independently, which is exactly what the
 * outbox exists to prevent.
 */
export function createInventoryModule(
  options: InventoryModuleOptions,
): DynamicModule {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // Refusing to boot beats a wrong default: this client must never be able to point at
    // another service's database.
    throw new Error('DATABASE_URL is required by the inventory module');
  }

  const prisma = new PrismaService(new PrismaClient({ datasourceUrl: databaseUrl }));
  const outboxRepository = new PrismaOutboxRepository(prisma);

  return {
    module: InventoryModule,
    imports: [
      CqrsModule.forRoot(),
      createOutboxModule({
        repository: outboxRepository,
        publisher: options.publisher,
      }),
    ],
    controllers: [InventoryGrpcController],
    providers: [
      { provide: INVENTORY_PRISMA, useValue: prisma },
      { provide: INVENTORY_CONFIG, useFactory: () => resolveInventoryConfig() },
      { provide: INVENTORY_REPOSITORY, useClass: PrismaInventoryRepository },
      // Carried for consumers that need to read the wiring back; the outbox receives the
      // publisher directly, because a global module cannot see this one's providers.
      { provide: INVENTORY_MODULE_OPTIONS, useValue: options },

      ReserveHandler,
      ReleaseHandler,
      ShipHandler,
      AdjustStockHandler,
      GetAvailableHandler,

      InventoryService,
      InventoryHealthIndicator,
    ],
    // The gRPC controller is deliberately not exported: it is attached to the microservice
    // by the app's bootstrap, not injected by a consumer.
    exports: [
      InventoryService,
      InventoryHealthIndicator,
      INVENTORY_REPOSITORY,
      INVENTORY_MODULE_OPTIONS,
    ],
  };
}
