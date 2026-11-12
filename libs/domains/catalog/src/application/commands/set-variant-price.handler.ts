import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import {
  InvalidStateTransitionException,
  ResourceNotFoundException,
  ValidationException,
} from '@auth/platform/error-handling';
import {
  PRODUCT_REPOSITORY,
  type ProductRepositoryPort,
} from '../../domain/ports/product-repository.port';
import {
  SetVariantPriceCommand,
  toProductView,
  type ProductView,
} from './product.command';

/**
 * Reprices one variant of an existing product.
 *
 * @remarks Three refusals, in the order a caller can act on them: the product does not
 * exist (fix the id), the product is archived (unarchive it first — a price on a product
 * nobody can buy is a fact about nothing), the sku or the number is wrong (fix the body).
 *
 * @remarks The aggregate decides whether the change is a *change*: a reprice to the current
 * value buffers no event and bumps no version, so this handler skips the write entirely in
 * that case rather than moving `updated_at` for a fact that did not move.
 */
@Injectable()
@CommandHandler(SetVariantPriceCommand)
export class SetVariantPriceHandler
  implements ICommandHandler<SetVariantPriceCommand, ProductView>
{
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepositoryPort,
  ) {}

  async execute(command: SetVariantPriceCommand): Promise<ProductView> {
    const product = await this.products.findById(command.productId);
    if (!product) {
      throw new ResourceNotFoundException('product not found', {
        productId: command.productId,
      });
    }

    if (!product.isActive) {
      throw new InvalidStateTransitionException(
        'an archived product cannot be repriced',
        { productId: command.productId, status: 'archived' },
      );
    }

    if (!product.variant(command.sku)) {
      throw new ResourceNotFoundException('product variant not found', {
        productId: command.productId,
        sku: command.sku,
      });
    }

    if (!Number.isSafeInteger(command.priceMinor) || command.priceMinor < 0) {
      throw new ValidationException(
        'price must be a non-negative integer in minor units',
        { sku: command.sku, priceMinor: command.priceMinor },
      );
    }

    product.setVariantPrice(command.sku, command.priceMinor);

    // No event buffered means the aggregate decided nothing changed; writing the row would
    // only move `updated_at` and imply a reprice that never happened.
    if (product.domainEvents.length > 0) {
      await this.products.save(product);
    }

    return toProductView(product);
  }
}
