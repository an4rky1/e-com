import { Inject, Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  ArchiveProductCommand,
  SetVariantPriceCommand,
  toCreateProductCommand,
  type PricedSkuView,
  type ProductView,
} from '../commands/product.command';
import {
  DEFAULT_PAGE_SIZE,
  GetPricingQuery,
  GetProductQuery,
  ListByCategoryQuery,
  type ProductListPage,
} from '../queries/product.queries';

/**
 * The only public surface of the catalog module.
 *
 * @remarks Every caller — the gRPC controller in this service, and nothing else — depends on
 * this class and nothing else. It therefore cannot reach the repository, the CQRS bus or the
 * aggregate, which is what makes this module's internals replaceable without touching a
 * single caller.
 *
 * @remarks Money is integer minor units at this boundary too. Parsing the `ShopMoney`
 * strings a proto request carries is the presentation layer's job, so that a second
 * transport (an HTTP admin route) does not have to inherit gRPC's wire format.
 */
@Injectable()
export class CatalogService {
  constructor(
    // Explicit tokens rather than relying on `design:paramtypes`: a type-only import is erased
    // before the decorator metadata is emitted, so the parameter would arrive as `Object` and
    // the container would have nothing to resolve it against.
    @Inject(CommandBus) private readonly commandBus: CommandBus,
    @Inject(QueryBus) private readonly queryBus: QueryBus,
  ) {}

  createProduct(input: {
    name: string;
    description?: string;
    categoryPath?: readonly string[];
    variants: readonly {
      readonly sku: string;
      readonly priceMinor: number;
      readonly attrs?: Record<string, string>;
    }[];
    mediaKeys?: readonly string[];
    currency?: string;
  }): Promise<ProductView> {
    return this.commandBus.execute(toCreateProductCommand(input));
  }

  setVariantPrice(input: {
    productId: string;
    sku: string;
    priceMinor: number;
  }): Promise<ProductView> {
    return this.commandBus.execute(
      new SetVariantPriceCommand(input.productId, input.sku, input.priceMinor),
    );
  }

  archiveProduct(input: { productId: string; reason?: string }): Promise<ProductView> {
    return this.commandBus.execute(
      new ArchiveProductCommand(input.productId, input.reason ?? 'archived_by_operator'),
    );
  }

  getProduct(input: { id: string }): Promise<ProductView> {
    return this.queryBus.execute(new GetProductQuery(input.id));
  }

  listByCategory(input: {
    categoryPath: readonly string[];
    page?: number;
    pageSize?: number;
  }): Promise<ProductListPage> {
    return this.queryBus.execute(
      new ListByCategoryQuery(
        input.categoryPath,
        input.page ?? 1,
        input.pageSize ?? DEFAULT_PAGE_SIZE,
      ),
    );
  }

  getPricing(input: { skus: readonly string[] }): Promise<PricedSkuView[]> {
    return this.queryBus.execute(new GetPricingQuery(input.skus));
  }
}
