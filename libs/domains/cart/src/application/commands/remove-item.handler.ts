/**
 * @fileoverview Drops one line from a cart.
 *
 * @remarks A SKU the cart does not hold is a 404 rather than a no-op. The alternative —
 * answering success — makes a stale screen and a correct one indistinguishable, and the
 * first is a bug the shopper should see rather than a request that quietly did nothing.
 *
 * @remarks `ClearCart` is the idempotent one by contrast: "make this basket empty" is
 * satisfied by an empty basket, so repeating it changes nothing and answers the same.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { ValidationException } from '@auth/platform/error-handling';
import { CartWorkspace } from '../cart-workspace';
import { buildCartReadModel, type CartReadModel } from '../cart-read-model';
import {
  PRODUCT_PRICING,
  type ProductPricingPort,
} from '../../domain/ports/product-pricing.port';
import { CART_CONFIG, type CartConfig } from '../../cart.config';
import { RemoveItemCommand } from './cart.commands';

@Injectable()
@CommandHandler(RemoveItemCommand)
export class RemoveItemHandler
  implements ICommandHandler<RemoveItemCommand, CartReadModel>
{
  constructor(
    @Inject(CartWorkspace) private readonly workspace: CartWorkspace,
    @Inject(PRODUCT_PRICING) private readonly pricing: ProductPricingPort,
    @Inject(CART_CONFIG) private readonly config: CartConfig,
  ) {}

  async execute(command: RemoveItemCommand): Promise<CartReadModel> {
    const sku = command.sku?.trim() ?? '';
    if (sku.length === 0) {
      throw new ValidationException('sku is required', { sku: command.sku });
    }

    const cart = await this.workspace.mutate(command.identity, (target) => {
      target.removeItem(sku, new Date());
    });

    return buildCartReadModel(cart, {
      pricing: this.pricing,
      ttlSeconds: this.config.ttlSeconds,
    });
  }
}
