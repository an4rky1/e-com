/**
 * @fileoverview Sets a line to an absolute quantity.
 *
 * @remarks Refuses `0` rather than treating it as a removal. `cart.proto` has a dedicated
 * `RemoveItem` for that, and a number that means two different things depending on whether
 * it is zero is the kind of overloading that survives a rewrite of the client and then
 * removes something on a decrement that was meant to be a decrement.
 *
 * @remarks A SKU the cart does not hold is a 404, not a silent success: the caller asked
 * to change something that is not there, and answering "done" would hide a stale screen.
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
import type { CartLimits } from '../../domain/cart.aggregate';
import { UpdateItemQtyCommand } from './cart.commands';

@Injectable()
@CommandHandler(UpdateItemQtyCommand)
export class UpdateItemQtyHandler
  implements ICommandHandler<UpdateItemQtyCommand, CartReadModel>
{
  private readonly limits: CartLimits;

  constructor(
    @Inject(CartWorkspace) private readonly workspace: CartWorkspace,
    @Inject(PRODUCT_PRICING) private readonly pricing: ProductPricingPort,
    @Inject(CART_CONFIG) private readonly config: CartConfig,
  ) {
    this.limits = {
      maxItems: config.maxItems,
      maxQuantityPerItem: config.maxQuantityPerItem,
    };
  }

  async execute(command: UpdateItemQtyCommand): Promise<CartReadModel> {
    const sku = command.sku?.trim() ?? '';
    if (sku.length === 0) {
      throw new ValidationException('sku is required', { sku: command.sku });
    }
    if (!Number.isSafeInteger(command.quantity) || command.quantity < 1) {
      throw new ValidationException(
        'quantity must be a positive integer; use RemoveItem to drop a line',
        { sku, quantity: command.quantity },
      );
    }
    if (command.quantity > this.config.maxQuantityPerItem) {
      throw new ValidationException('quantity exceeds the per-item limit', {
        sku,
        quantity: command.quantity,
        maxQuantityPerItem: this.config.maxQuantityPerItem,
      });
    }

    const cart = await this.workspace.mutate(command.identity, (target) => {
      target.updateQuantity(sku, command.quantity, this.limits, new Date());
    });

    return buildCartReadModel(cart, {
      pricing: this.pricing,
      ttlSeconds: this.config.ttlSeconds,
    });
  }
}
