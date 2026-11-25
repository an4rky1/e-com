import { Inject, Injectable, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import {
  ResourceAlreadyExistsException,
  ValidationException,
} from '@auth/platform/error-handling';
import {
  Product,
  PRODUCT_NAME_MAX_LENGTH,
  PRODUCT_NAME_MIN_LENGTH,
} from '../../domain/product.aggregate';
import {
  PRODUCT_REPOSITORY,
  type ProductRepositoryPort,
} from '../../domain/ports/product-repository.port';
import { PRODUCT_SEARCH_INDEXER, type ProductSearchIndexer } from '../../domain/ports/product-search-indexer.port';
import { CATALOG_CONFIG, type CatalogConfig } from '../../catalog.config';
import {
  CreateProductCommand,
  toProductView,
  type ProductView,
} from './product.command';

/**
 * The single write path for listing a product.
 *
 * @remarks Commands are the only place mutations happen, so authorisation, auditing and event
 * publication have exactly one hook rather than one per entry point.
 *
 * @remarks Validation lives here *and* in the aggregate. The aggregate keeps the rule — it is
 * what makes a product a product no matter who built it — and this handler states the same
 * rules in the transport's language, so the caller gets a 400 naming the bad field instead of
 * an untranslated `DomainError` from deep inside a static factory.
 */
@Injectable()
@CommandHandler(CreateProductCommand)
export class CreateProductHandler
  implements ICommandHandler<CreateProductCommand, ProductView>
{
  private static readonly logger = new Logger(CreateProductHandler.name);

  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepositoryPort,
    @Inject(CATALOG_CONFIG) private readonly config: CatalogConfig,
    @Inject(PRODUCT_SEARCH_INDEXER) private readonly searchIndexer: ProductSearchIndexer,
  ) {}

  async execute(command: CreateProductCommand): Promise<ProductView> {
    const name = command.name?.trim() ?? '';
    if (name.length < PRODUCT_NAME_MIN_LENGTH || name.length > PRODUCT_NAME_MAX_LENGTH) {
      // A caller's mistake, so a 400 rather than a 500.
      throw new ValidationException(
        `name must be between ${PRODUCT_NAME_MIN_LENGTH} and ${PRODUCT_NAME_MAX_LENGTH} characters`,
        { name: name.slice(0, PRODUCT_NAME_MAX_LENGTH) },
      );
    }

    const variants = command.variants ?? [];
    if (variants.length === 0) {
      throw new ValidationException('a product needs at least one variant', {
        name,
      });
    }
    if (variants.length > this.config.maxVariants) {
      throw new ValidationException(
        `a product may carry at most ${this.config.maxVariants} variants`,
        { received: variants.length, maxVariants: this.config.maxVariants },
      );
    }

    const skus = new Set<string>();
    for (const variant of variants) {
      const sku = variant.sku?.trim() ?? '';
      if (sku.length === 0) {
        throw new ValidationException('variant sku must be a non-empty string', { name });
      }
      if (skus.has(sku)) {
        // Duplicate inside one request: the unique index would only catch it after the
        // first insert, at which point the caller has a half-created product.
        throw new ValidationException(`duplicate sku "${sku}" in the request`, { sku });
      }
      if (!Number.isSafeInteger(variant.priceMinor) || variant.priceMinor < 0) {
        throw new ValidationException(
          'variant price must be a non-negative integer in minor units',
          { sku, priceMinor: variant.priceMinor },
        );
      }
      skus.add(sku);
    }

    const categoryPath = (command.categoryPath ?? []).map((segment) => segment.trim());
    if (categoryPath.some((segment) => segment.length === 0)) {
      throw new ValidationException('category path segments must be non-empty', {
        categoryPath: [...categoryPath],
      });
    }

    const currency = (command.currency ?? this.config.defaultCurrency).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new ValidationException(
        'currency must be a 3-letter ISO-4217 code',
        { currency },
      );
    }

    // Checked before the insert so the common case returns a clean 409, rather than relying
    // on the unique index to surface a driver-level error code.
    for (const sku of skus) {
      if (await this.products.existsBySku(sku)) {
        throw new ResourceAlreadyExistsException(`sku "${sku}" already exists`, { sku });
      }
    }

    const product = Product.create({
      name,
      description: command.description ?? '',
      categoryPath,
      variants: variants.map((variant) => ({
        sku: variant.sku.trim(),
        priceMinor: variant.priceMinor,
        attrs: variant.attrs,
      })),
      mediaKeys: [...(command.mediaKeys ?? [])],
      currency,
      now: new Date(),
    });

    // The repository writes the row and its `product.created` event in one transaction.
    await this.products.save(product);

    // Search indexing is a projection: the product exists whether or not the engine holds
    // it yet, so a refusal to index must not fail the write or the caller would have no
    // answer for "is my product searchable?". It is logged rather than swallowed because
    // an index that stays empty is exactly what an incident starts from.
    try {
      await this.searchIndexer.index(product);
    } catch (error) {
      CreateProductHandler.logger.warn(
        `search index write failed for product ${product.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return toProductView(product);
  }
}
