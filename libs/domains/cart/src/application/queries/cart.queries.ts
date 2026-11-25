/**
 * @fileoverview The three reads this service offers: a basket, the lines checkout copies,
 * and the answer to "is this basket still safe to buy?".
 *
 * @remarks Like every query in this workspace they are classes: `QueryBus.execute` resolves
 * a handler from `query.constructor`, and a plain object cannot dispatch.
 *
 * @remarks Money stays a `Money` on the way out. The gRPC layer converts to
 * `ShopMoney` strings at the edge; a query that had already stringified a price would
 * make the presentation layer the place where the domain's number format is decided.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Query, QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { CartWorkspace } from '../cart-workspace';
import {
  buildCartReadModel,
  buildCheckoutLines,
  buildCheckoutValidation,
  type CartReadModel,
  type CheckoutLinesReadModel,
  type CheckoutValidationReadModel,
} from '../cart-read-model';
import {
  PRODUCT_PRICING,
  type ProductPricingPort,
} from '../../domain/ports/product-pricing.port';
import { CART_CONFIG, type CartConfig } from '../../cart.config';
import type { CartIdentity } from '../../domain/cart-owner';

export class GetCartQuery extends Query<CartReadModel> {
  readonly queryId: string = crypto.randomUUID();

  constructor(readonly identity: CartIdentity) {
    super();
  }
}

export class GetCheckoutLinesQuery extends Query<CheckoutLinesReadModel> {
  readonly queryId: string = crypto.randomUUID();

  constructor(readonly identity: CartIdentity) {
    super();
  }
}

export class ValidateForCheckoutQuery extends Query<CheckoutValidationReadModel> {
  readonly queryId: string = crypto.randomUUID();

  constructor(readonly identity: CartIdentity) {
    super();
  }
}

@Injectable()
@QueryHandler(GetCartQuery)
export class GetCartHandler implements IQueryHandler<GetCartQuery, CartReadModel> {
  constructor(
    @Inject(CartWorkspace) private readonly workspace: CartWorkspace,
    @Inject(PRODUCT_PRICING) private readonly pricing: ProductPricingPort,
    @Inject(CART_CONFIG) private readonly config: CartConfig,
  ) {}

  async execute(query: GetCartQuery): Promise<CartReadModel> {
    const cart = await this.workspace.read(query.identity);

    return buildCartReadModel(cart, {
      pricing: this.pricing,
      ttlSeconds: this.config.ttlSeconds,
    });
  }
}

@Injectable()
@QueryHandler(GetCheckoutLinesQuery)
export class GetCheckoutLinesHandler
  implements IQueryHandler<GetCheckoutLinesQuery, CheckoutLinesReadModel>
{
  constructor(@Inject(CartWorkspace) private readonly workspace: CartWorkspace) {}

  /**
   * A snapshot, not a quote.
   *
   * @remarks Prices come from the lines' own snapshots and the catalogue is not consulted
   * at all: the order service copies exactly what the shopper saw, and a price that had
   * moved since would be caught — and reported — by `ValidateForCheckout`, which is the
   * call that has to be authoritative about it.
   */
  async execute(query: GetCheckoutLinesQuery): Promise<CheckoutLinesReadModel> {
    const cart = await this.workspace.read(query.identity);
    return buildCheckoutLines(cart);
  }
}

@Injectable()
@QueryHandler(ValidateForCheckoutQuery)
export class ValidateForCheckoutHandler
  implements IQueryHandler<ValidateForCheckoutQuery, CheckoutValidationReadModel>
{
  constructor(
    @Inject(CartWorkspace) private readonly workspace: CartWorkspace,
    @Inject(PRODUCT_PRICING) private readonly pricing: ProductPricingPort,
  ) {}

  async execute(query: ValidateForCheckoutQuery): Promise<CheckoutValidationReadModel> {
    const cart = await this.workspace.read(query.identity);
    return buildCheckoutValidation(cart, this.pricing);
  }
}
