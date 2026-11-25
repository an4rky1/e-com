/**
 * @fileoverview The public surface of the catalog domain.
 *
 * @remarks The barrel is deliberately explicit rather than `export *`: a consumer importing
 * from here should be able to see, in one screen, the whole contract this service offers — and
 * a wildcard would quietly widen it every time a helper is added under `src/`.
 *
 * @remarks Three audiences. {@link CatalogModule} and {@link CatalogHealthIndicator} are what
 * the app composition root wires; everything under `application/` and `domain/` exists so a
 * test — in this service or in the cart, which mirrors the same read models — can assert
 * against the same rules rather than against a copy of them.
 */

// ---- configuration ------------------------------------------------------------
export {
  CATALOG_CONFIG,
  CATALOG_PRISMA,
  Defaults as CatalogDefaults,
  catalogSchema,
  resolveCatalogConfig,
  type CatalogConfig,
  type CatalogEnvConfig,
} from './catalog.config';

// ---- module -------------------------------------------------------------------
export {
  CatalogModule,
  createCatalogModule,
  type CatalogModuleOptions,
} from './catalog.module';
export { CatalogHealthIndicator } from './catalog.health';

// ---- commands -----------------------------------------------------------------
export {
  ArchiveProductCommand,
  CreateProductCommand,
  SetVariantPriceCommand,
  toCreateProductCommand,
  toProductView,
  type PricedSkuView,
  type ProductView,
} from './application/commands/product.command';
export { CreateProductHandler } from './application/commands/create-product.handler';
export { SetVariantPriceHandler } from './application/commands/set-variant-price.handler';
export { ArchiveProductHandler } from './application/commands/archive-product.handler';

// ---- queries ------------------------------------------------------------------
export {
  DEFAULT_PAGE_SIZE,
  GetPricingHandler,
  GetPricingQuery,
  GetProductHandler,
  GetProductQuery,
  ListByCategoryHandler,
  ListByCategoryQuery,
  MAX_PAGE_SIZE,
  type ProductListPage,
} from './application/queries/product.queries';
export { SearchProductsHandler, SearchProductsQuery } from './application/queries/product.search-query';

// ---- application --------------------------------------------------------------
export { CatalogService } from './application/facade/catalog.service';

// ---- domain -------------------------------------------------------------------
export {
  Product,
  PRODUCT_AGGREGATE,
  ProductArchived,
  ProductCreated,
  ProductPriceChanged,
  PRODUCT_NAME_MAX_LENGTH,
  PRODUCT_NAME_MIN_LENGTH,
  isProductEvent,
  toAttrs,
  type ProductCreatedPayload,
  type ProductEvent,
  type ProductProps,
  type ProductRow,
  type ProductVariant,
  type ProductVariantRow,
  type ProductWriteRows,
} from './domain/product.aggregate';
export {
  ActiveProducts,
  BySku,
  PRODUCT_REPOSITORY,
  ProductSpecification,
  type ProductRepositoryPort,
} from './domain/ports/product-repository.port';

// ---- presentation -------------------------------------------------------------
export { parseShopMoney, toShopMoney } from './presentation/money';
export { CatalogGrpcController } from './presentation/grpc/catalog.grpc.controller';

// ---- infrastructure -----------------------------------------------------------
export { PrismaProductRepository } from './infrastructure/persistence/prisma-product.repository';
export {
  enqueueEvents,
  type EnqueueEventsOptions,
} from './infrastructure/persistence/outbox-enqueue';
