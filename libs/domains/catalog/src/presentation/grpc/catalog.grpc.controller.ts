import { Controller } from '@nestjs/common';
import { GrpcControllerBase, GrpcMethod } from '@auth/infra/grpc';
import type {
  ArchiveProductRequest,
  CatalogProduct,
  CatalogVariant,
  CreateProductRequest,
  GetPricingRequest,
  GetPricingResponse,
  ListByCategoryRequest,
  ProductList,
  SetVariantPriceRequest,
} from '@auth/contracts';
import { ValidationException } from '@auth/platform/error-handling';
import { CatalogService } from '../../application/facade/catalog.service';
import type { ProductView } from '../../application/commands/product.command';
import { toShopMoney, parseShopMoney } from '../money';

const SERVICE = 'CatalogService';

/**
 * gRPC transport for catalog, implementing `CatalogGrpcClient` server-side.
 *
 * @remarks It extends {@link GrpcControllerBase} because `mergeMicroservice` requires a
 * controller with no HTTP routes; deriving from it keeps that invariant from being forgotten
 * when a method is added.
 *
 * @remarks Money is converted here and nowhere else. The facade speaks integers, the proto
 * speaks `ShopMoney` strings, and a boundary is exactly the place where exactly one
 * conversion should live — otherwise a second transport starts guessing at the format too.
 */
@Controller()
export class CatalogGrpcController extends GrpcControllerBase {
  constructor(private readonly catalog: CatalogService) {
    super();
  }

  @GrpcMethod(SERVICE, 'GetProduct')
  async getProduct(request: { id: string }): Promise<CatalogProduct> {
    return toCatalogProduct(await this.catalog.getProduct({ id: request?.id ?? '' }));
  }

  @GrpcMethod(SERVICE, 'ListByCategory')
  async listByCategory(request: ListByCategoryRequest): Promise<ProductList> {
    // proto3 zeroes an unset scalar, and `0` is not a page: the wire cannot distinguish
    // "caller asked for page 1" from "caller asked for nothing", so both are page 1.
    const page = request.page > 0 ? request.page : 1;
    const pageSize = request.pageSize > 0 ? request.pageSize : undefined;

    const result = await this.catalog.listByCategory({
      categoryPath: request.categoryPath ?? [],
      page,
      ...(pageSize !== undefined ? { pageSize } : {}),
    });

    return {
      products: result.products.map(toCatalogProduct),
      total: result.total,
    };
  }

  @GrpcMethod(SERVICE, 'GetPricing')
  async getPricing(request: GetPricingRequest): Promise<GetPricingResponse> {
    const result = await this.catalog.getPricing({ skus: request.skus ?? [] });

    return {
      prices: result.map((price) => ({
        sku: price.sku,
        productId: price.productId,
        price: toShopMoney(price.priceMinor, price.currency),
        active: price.active,
      })),
    };
  }

  @GrpcMethod(SERVICE, 'CreateProduct')
  async createProduct(request: CreateProductRequest): Promise<CatalogProduct> {
    const variants = request.variants ?? [];
    if (variants.length === 0) {
      // Named here rather than left to the aggregate: an empty `repeated` is indistinguishable
      // from a missing one on the wire, and "at least one variant" is the first thing a caller
      // needs to be told when their request round-tripped as nothing.
      throw new ValidationException('a product needs at least one variant', {
        name: request.name ?? '',
      });
    }

    return toCatalogProduct(
      await this.catalog.createProduct({
        name: request.name ?? '',
        description: request.description ?? '',
        categoryPath: request.categoryPath ?? [],
        variants: variants.map((variant) => ({
          sku: variant.sku ?? '',
          priceMinor: parseShopMoney(variant.price, 'variants.price'),
          ...(variant.attrs ? { attrs: { ...variant.attrs } } : {}),
        })),
        mediaKeys: request.mediaKeys ?? [],
        // `CreateProductRequest` carries no currency, so the configured default is what the
        // product is minted in. Adding a field here is a contract change, not a fallback.
      }),
    );
  }

  @GrpcMethod(SERVICE, 'SetVariantPrice')
  async setVariantPrice(request: SetVariantPriceRequest): Promise<CatalogProduct> {
    return toCatalogProduct(
      await this.catalog.setVariantPrice({
        productId: request.productId ?? '',
        sku: request.sku ?? '',
        priceMinor: parseShopMoney(request.price, 'price'),
      }),
    );
  }

  @GrpcMethod(SERVICE, 'ArchiveProduct')
  async archiveProduct(request: ArchiveProductRequest): Promise<CatalogProduct> {
    return toCatalogProduct(
      await this.catalog.archiveProduct({
        productId: request.productId ?? '',
        ...(request.reason ? { reason: request.reason } : {}),
      }),
    );
  }
}

/** Projects the read model onto the `Product` message, money included. */
function toCatalogProduct(view: ProductView): CatalogProduct {
  const variants: CatalogVariant[] = view.variants.map((variant) => ({
    sku: variant.sku,
    price: toShopMoney(variant.priceMinor, view.currency),
    attrs: { ...variant.attrs },
    active: variant.active,
  }));

  return {
    id: view.id,
    name: view.name,
    description: view.description,
    categoryPath: [...view.categoryPath],
    variants,
    mediaKeys: [...view.mediaKeys],
    active: view.active,
    version: view.version,
    // Absent rather than zero: a product with no variants has no lowest price, and a
    // `Money(0)` would be read by every consumer as "free".
    ...(view.priceRangeMin !== null
      ? { priceRangeMin: toShopMoney(view.priceRangeMin, view.currency) }
      : {}),
    ...(view.priceRangeMax !== null
      ? { priceRangeMax: toShopMoney(view.priceRangeMax, view.currency) }
      : {}),
  };
}
