/**
 * @fileoverview The single write path for adding a line to a cart.
 *
 * @remarks The catalogue is consulted *before* the cart's lock is taken. A price lookup is
 * a network round trip, and holding a cart's mutex across one would block every other
 * request to that cart for as long as the catalogue takes to answer — the lock exists to
 * make a read-modify-write atomic, not to make a slow dependency everybody's problem.
 *
 * @remarks The lookup still decides the outcome: a SKU the catalogue will not sell is a
 * 404, not a line added at a guessed price. What it does *not* do is reprice a line that
 * is already in the cart — see {@link Cart.addItem}.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import {
  ResourceNotFoundException,
  ValidationException,
} from '@auth/platform/error-handling';
import { CartWorkspace } from '../cart-workspace';
import {
  buildCartReadModel,
  type CartReadModel,
} from '../cart-read-model';
import {
  PRODUCT_PRICING,
  type ProductPricingPort,
} from '../../domain/ports/product-pricing.port';
import { resolveCartOwner } from '../../domain/cart-owner';
import { CART_CONFIG, type CartConfig } from '../../cart.config';
import type { CartLimits } from '../../domain/cart.aggregate';
import { AddItemCommand } from './cart.commands';

@Injectable()
@CommandHandler(AddItemCommand)
export class AddItemHandler implements ICommandHandler<AddItemCommand, CartReadModel> {
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

  async execute(command: AddItemCommand): Promise<CartReadModel> {
    const sku = command.sku?.trim() ?? '';
    if (sku.length === 0) {
      throw new ValidationException('sku is required', { sku: command.sku });
    }
    if (!Number.isSafeInteger(command.quantity) || command.quantity < 1) {
      throw new ValidationException('quantity must be a positive integer', {
        sku,
        quantity: command.quantity,
      });
    }
    if (command.quantity > this.config.maxQuantityPerItem) {
      throw new ValidationException('quantity exceeds the per-item limit', {
        sku,
        quantity: command.quantity,
        maxQuantityPerItem: this.config.maxQuantityPerItem,
      });
    }

    // Refused before the catalogue is touched: a request that cannot say which cart it
    // means should not cost a round trip to find that out.
    resolveCartOwner(command.identity);

    const sellable = await this.pricing.findSellable(sku);
    if (!sellable) {
      throw new ResourceNotFoundException('the SKU is not sellable', { sku });
    }

    const cart = await this.workspace.mutate(command.identity, (target) => {
      target.addItem(
        {
          sku: sellable.sku,
          productId: sellable.productId,
          name: sellable.name,
          unitPriceMinor: sellable.priceMinor,
          currency: sellable.currency,
          quantity: command.quantity,
        },
        this.limits,
        new Date(),
      );
    });

    return buildCartReadModel(cart, {
      pricing: this.pricing,
      ttlSeconds: this.config.ttlSeconds,
    });
  }
}
