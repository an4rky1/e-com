import { Inject, Injectable, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { ResourceNotFoundException } from '@auth/platform/error-handling';
import {
  PRODUCT_REPOSITORY,
  type ProductRepositoryPort,
} from '../../domain/ports/product-repository.port';
import {
  PRODUCT_SEARCH_INDEXER,
  type ProductSearchIndexer,
} from '../../domain/ports/product-search-indexer.port';
import {
  ArchiveProductCommand,
  toProductView,
  type ProductView,
} from './product.command';

/**
 * Withdraws a product from sale.
 *
 * @remarks Archiving is deliberately *not* a deletion: the row, its skus and its price
 * history stay so that an order placed yesterday still resolves against the document it was
 * priced from. What changes is `active`, which every sellability question reads.
 *
 * @remarks Idempotent — archiving an already-archived product is a no-op that buffers no
 * event, so the handler skips the write rather than announcing a fact twice. Operator
 * tooling retries "retire this product" jobs, and a second `product.archived` on the same
 * aggregate version would collide on `dedup_key` anyway.
 */
@Injectable()
@CommandHandler(ArchiveProductCommand)
export class ArchiveProductHandler
  implements ICommandHandler<ArchiveProductCommand, ProductView>
{
  private static readonly logger = new Logger(ArchiveProductHandler.name);

  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepositoryPort,
    @Inject(PRODUCT_SEARCH_INDEXER) private readonly searchIndexer: ProductSearchIndexer,
  ) {}

  async execute(command: ArchiveProductCommand): Promise<ProductView> {
    const product = await this.products.findById(command.productId);
    if (!product) {
      throw new ResourceNotFoundException('product not found', {
        productId: command.productId,
      });
    }

    product.archive(command.reason);

    if (product.domainEvents.length > 0) {
      await this.products.save(product);
    }

    // The document is dropped on the same fact the caller already has (`isActive`), so the
    // write path stays best-effort exactly like the index one: the product is already
    // withdrawn from sale; the search index is a projection of it.
    if (!product.isActive) {
      try {
        await this.searchIndexer.remove(product);
      } catch (error) {
        ArchiveProductHandler.logger.warn(
          `search index removal failed for product ${product.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return toProductView(product);
  }
}
