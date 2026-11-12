import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { ResourceNotFoundException } from '@auth/platform/error-handling';
import {
  PRODUCT_REPOSITORY,
  type ProductRepositoryPort,
} from '../../domain/ports/product-repository.port';
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
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepositoryPort,
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

    return toProductView(product);
  }
}
