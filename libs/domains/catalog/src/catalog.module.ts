/**
 * @fileoverview Nest wiring for the catalog service.
 *
 * @remarks A factory rather than a static `@Module`, for the same reason as its siblings:
 * the options (publisher, channel) are chosen by the composition root, and a module whose
 * metadata is evaluated at import time cannot receive them.
 *
 * @remarks Every provider is bound through a `Symbol` token declared by a port, so the
 * application layer never names a class from `infrastructure/`. The wiring is the only place
 * that knows a Prisma client is the implementation of the port the aggregate was written
 * against.
 *
 * @remarks One Prisma client is shared by the repository and the outbox. A second client
 * would open a second connection and commit independently, which is exactly what the outbox
 * exists to prevent.
 */
import { Module, type DynamicModule } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { PrismaService } from '@auth/infra/prisma';
import { ElasticsearchModule } from '@auth/infra/elasticsearch';
import {
  createOutboxModule,
  PrismaOutboxRepository,
  type EventPublisher,
} from '@auth/infra/outbox';
import { PrismaClient } from './generated/prisma/client';
import { CreateProductHandler } from './application/commands/create-product.handler';
import { SetVariantPriceHandler } from './application/commands/set-variant-price.handler';
import { ArchiveProductHandler } from './application/commands/archive-product.handler';
import {
  GetPricingHandler,
  GetProductHandler,
  ListByCategoryHandler,
} from './application/queries/product.queries';
import { SearchProductsHandler } from './application/queries/product.search-query';
import { CatalogService } from './application/facade/catalog.service';
import { PRODUCT_REPOSITORY } from './domain/ports/product-repository.port';
import { PRODUCT_SEARCH } from './domain/ports/product-search.port';
import { PRODUCT_SEARCH_INDEXER } from './domain/ports/product-search-indexer.port';
import { PrismaProductRepository } from './infrastructure/persistence/prisma-product.repository';
import { ElasticsearchProductSearch } from './infrastructure/search/elasticsearch-product-search';
import { ElasticsearchProductIndexer } from './infrastructure/search/elasticsearch-product-indexer';
import { CatalogGrpcController } from './presentation/grpc/catalog.grpc.controller';
import { CatalogHealthIndicator } from './catalog.health';
import { CATALOG_CONFIG, CATALOG_PRISMA, resolveCatalogConfig } from './catalog.config';

@Module({})
export class CatalogModule {}

export interface CatalogModuleOptions {
  /**
   * Transport the outbox publishes through.
   *
   * @remarks Supplied by the app because a module factory runs inside an `@Module` decorator,
   * where no injection container exists yet to hand over a Kafka producer. The domain layer
   * still only ever sees the {@link EventPublisher} port.
   */
  publisher: EventPublisher;
}

/**
 * Assembles the catalog service.
 *
 * @remarks The outbox is wired here rather than left to the host. `OutboxModule` is global,
 * and a global module cannot see a provider declared by the module that imports it — so an
 * outbox repository supplied "from outside" is never injected, and `OutboxService` fails to
 * resolve at boot. Passing the repository in is what makes the relay bind to *this*
 * service's `outbox_events` table.
 *
 * @remarks The controller is registered here rather than in the app: the gRPC surface is this
 * module's, and a composition root that listed it would be the one place a transport could be
 * added or dropped without the module's tests noticing.
 */
export function createCatalogModule(options: CatalogModuleOptions): DynamicModule {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // Refusing to boot beats a wrong default: this client must never be able to point at
    // another service's database.
    throw new Error('DATABASE_URL is required by the catalog module');
  }

  const prisma = new PrismaService(new PrismaClient({ datasourceUrl: databaseUrl }));
  const outboxRepository = new PrismaOutboxRepository(prisma);

  return {
    module: CatalogModule,
    imports: [
      CqrsModule.forRoot(),
      createOutboxModule({ repository: outboxRepository, publisher: options.publisher }),
      ElasticsearchModule.forRoot(),
    ],
    controllers: [CatalogGrpcController],
    providers: [
      { provide: CATALOG_PRISMA, useValue: prisma },
      { provide: CATALOG_CONFIG, useFactory: () => resolveCatalogConfig() },

      { provide: PRODUCT_REPOSITORY, useClass: PrismaProductRepository },
      { provide: PRODUCT_SEARCH, useClass: ElasticsearchProductSearch },
      { provide: PRODUCT_SEARCH_INDEXER, useClass: ElasticsearchProductIndexer },

      CreateProductHandler,
      SetVariantPriceHandler,
      ArchiveProductHandler,
      GetProductHandler,
      ListByCategoryHandler,
      SearchProductsHandler,
      GetPricingHandler,

      CatalogService,
      CatalogHealthIndicator,
    ],
    exports: [
      CatalogService,
      CatalogHealthIndicator,
      PRODUCT_REPOSITORY,
      PRODUCT_SEARCH,
      PRODUCT_SEARCH_INDEXER,
    ],
  };
}
