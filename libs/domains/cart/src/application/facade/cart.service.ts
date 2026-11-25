/**
 * @fileoverview The only public surface of the cart module.
 *
 * @remarks Everything that talks to this service — the gRPC controller, the order saga
 * when it snapshots a basket, a test in another lib — depends on this class and nothing
 * else. It therefore cannot reach the store, the lock, the CQRS bus's handlers or the
 * aggregate, which is what makes the module's internals replaceable without touching a
 * single caller.
 *
 * @remarks It speaks in read models, never in proto messages: the transport shape belongs
 * to the presentation layer, and a second copy of it here would be a second thing to keep
 * in step with `cart.proto`.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  AddItemCommand,
  ClearCartCommand,
  MergeGuestCartCommand,
  RemoveItemCommand,
  UpdateItemQtyCommand,
} from '../commands/cart.commands';
import {
  GetCartQuery,
  GetCheckoutLinesQuery,
  ValidateForCheckoutQuery,
} from '../queries/cart.queries';
import type {
  CartReadModel,
  CheckoutLinesReadModel,
  CheckoutValidationReadModel,
} from '../cart-read-model';
import type { CartIdentity } from '../../domain/cart-owner';

@Injectable()
export class CartService {
  constructor(
    // Explicit tokens rather than relying on `design:paramtypes`: a type-only import is
    // erased before the decorator metadata is emitted, so the parameter would arrive as
    // `Object` and the container would have nothing to resolve it against.
    @Inject(CommandBus) private readonly commandBus: CommandBus,
    @Inject(QueryBus) private readonly queryBus: QueryBus,
  ) {}

  /** The basket as it stands, with a `version` of `0` when nothing is stored yet. */
  getCart(identity: CartIdentity): Promise<CartReadModel> {
    return this.queryBus.execute(new GetCartQuery(identity));
  }

  /**
   * Adds a line, or tops one up.
   *
   * @remarks Refuses a SKU the catalogue will not sell. The price is looked up here, not
   * taken from the caller — a cart that trusted a client's price would let checkout
   * proceed at whatever figure the client cared to send.
   */
  addItem(
    identity: CartIdentity,
    sku: string,
    quantity: number,
  ): Promise<CartReadModel> {
    return this.commandBus.execute(new AddItemCommand(identity, sku, quantity));
  }

  /** Sets a line to an absolute quantity. `0` is refused; use `removeItem`. */
  updateItemQuantity(
    identity: CartIdentity,
    sku: string,
    quantity: number,
  ): Promise<CartReadModel> {
    return this.commandBus.execute(new UpdateItemQtyCommand(identity, sku, quantity));
  }

  /** Drops a line. A SKU that is not there is a 404, not a no-op. */
  removeItem(identity: CartIdentity, sku: string): Promise<CartReadModel> {
    return this.commandBus.execute(new RemoveItemCommand(identity, sku));
  }

  /** Empties the basket. Safe to repeat: a second call answers exactly as the first. */
  clearCart(identity: CartIdentity): Promise<CartReadModel> {
    return this.commandBus.execute(new ClearCartCommand(identity));
  }

  /**
   * Folds the guest basket this browser presented at sign-in into the signed-in cart.
   *
   * @remarks Answers `false` when there was no guest basket to fold — the ordinary answer
   * for a shopper who signed in without browsing anonymously first, and the one that makes
   * the call safe to repeat after a partial failure.
   */
  mergeGuestCart(identity: CartIdentity, guestSessionId: string): Promise<boolean> {
    return this.commandBus.execute(new MergeGuestCartCommand(identity, guestSessionId));
  }

  /**
   * The lines the order service copies when it creates an order.
   *
   * @remarks A snapshot at the prices the lines were added at. It never consults the
   * catalogue: `ValidateForCheckout` is the call that has to be authoritative about
   * whether those prices are still current.
   */
  getCheckoutLines(identity: CartIdentity): Promise<CheckoutLinesReadModel> {
    return this.queryBus.execute(new GetCheckoutLinesQuery(identity));
  }

  /**
   * Which lines changed price or vanished since they were added.
   *
   * @remarks Unlike the read paths this one never degrades to "everything is fine": a
   * validation that skipped the catalogue during an outage would clear a basket full of
   * prices nobody has checked. It fails instead, and the caller already has a 503 for that.
   */
  validateForCheckout(identity: CartIdentity): Promise<CheckoutValidationReadModel> {
    return this.queryBus.execute(new ValidateForCheckoutQuery(identity));
  }
}
