/**
 * @fileoverview Empties a cart.
 *
 * @remarks The document is kept rather than deleted, and an already-empty cart is left
 * exactly as it is: "make this basket empty" is satisfied by an empty basket, so a repeat
 * answers with the same cart it answered with the first time. That is what makes this the
 * one mutation in `cart.v1` a caller may safely retry after a dropped connection.
 *
 * @remarks The guest cart is folded in *before* the clear, not after. A shopper who signs
 * in and then empties the basket means both carts — theirs and the one they were using as
 * a guest — and merging afterwards would put the guest's lines straight back.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { CartWorkspace } from '../cart-workspace';
import { buildCartReadModel, type CartReadModel } from '../cart-read-model';
import {
  PRODUCT_PRICING,
  type ProductPricingPort,
} from '../../domain/ports/product-pricing.port';
import { CART_CONFIG, type CartConfig } from '../../cart.config';
import { ClearCartCommand } from './cart.commands';

@Injectable()
@CommandHandler(ClearCartCommand)
export class ClearCartHandler implements ICommandHandler<ClearCartCommand, CartReadModel> {
  constructor(
    @Inject(CartWorkspace) private readonly workspace: CartWorkspace,
    @Inject(PRODUCT_PRICING) private readonly pricing: ProductPricingPort,
    @Inject(CART_CONFIG) private readonly config: CartConfig,
  ) {}

  async execute(command: ClearCartCommand): Promise<CartReadModel> {
    const cart = await this.workspace.mutate(command.identity, (target) => {
      target.clear(new Date());
    });

    return buildCartReadModel(cart, {
      pricing: this.pricing,
      ttlSeconds: this.config.ttlSeconds,
    });
  }
}
