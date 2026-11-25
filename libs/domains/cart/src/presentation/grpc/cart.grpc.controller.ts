/**
 * @fileoverview gRPC transport for cart, implementing `CartGrpcClient` server-side.
 *
 * @remarks It extends {@link GrpcControllerBase} because `mergeMicroservice` requires a
 * controller with no HTTP routes; deriving from it keeps that invariant from being
 * forgotten when a method is added.
 *
 * @remarks **Its own `@Controller()` is mandatory.** `emitDecoratorMetadata` does not
 * inherit across class inheritance: a subclass with no decorator of its own gets no
 * `design:paramtypes`, so Nest constructs it with zero arguments, the service boots
 * cleanly and the first request fails on an `undefined` facade.
 *
 * @remarks The controller translates and nothing else. Every rule about what a cart may
 * hold lives behind {@link CartService}, so a second transport (HTTP, an internal caller)
 * cannot reach a different answer — and money crosses this wire as a *string* here and
 * nowhere else, which is the only place that conversion should live.
 */
import { Controller } from '@nestjs/common';
import { GrpcControllerBase, GrpcMethod } from '@auth/infra/grpc';
import type {
  CartView,
  CheckoutLines,
  ClearCartRequest,
  GetCartRequest,
  AddItemRequest,
  MergeGuestCartRequest,
  MergeGuestCartResponse,
  RemoveItemRequest,
  UpdateItemQtyRequest,
  ValidateForCheckoutResponse,
} from '@auth/contracts';
import { toShopMoney } from '../../money';
import type { CartIdentity } from '../../domain/cart-owner';
import type { CartReadModel } from '../../application/cart-read-model';
// Value import on purpose — see the note in `session.grpc.controller.ts`.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { CartService } from '../../application/facade/cart.service';

/** Service name exactly as `libs/contracts/proto/cart.proto` declares it. */
const SERVICE = 'CartService';

/** Every `cart.v1` request carries the same two identifiers, proto3 defaults included. */
interface CartRequestLike {
  readonly sessionId?: string;
  readonly userId?: string;
}

@Controller()
export class CartGrpcController extends GrpcControllerBase {
  constructor(private readonly cart: CartService) {
    super();
  }

  @GrpcMethod(SERVICE, 'GetCart')
  async getCart(request: GetCartRequest): Promise<CartView> {
    return toCartView(await this.cart.getCart(toIdentity(request)));
  }

  @GrpcMethod(SERVICE, 'AddItem')
  async addItem(request: AddItemRequest): Promise<CartView> {
    return toCartView(
      await this.cart.addItem(
        toIdentity(request),
        request.sku ?? '',
        request.quantity ?? 0,
      ),
    );
  }

  @GrpcMethod(SERVICE, 'UpdateItemQty')
  async updateItemQty(request: UpdateItemQtyRequest): Promise<CartView> {
    return toCartView(
      await this.cart.updateItemQuantity(
        toIdentity(request),
        request.sku ?? '',
        request.quantity ?? 0,
      ),
    );
  }

  @GrpcMethod(SERVICE, 'RemoveItem')
  async removeItem(request: RemoveItemRequest): Promise<CartView> {
    return toCartView(
      await this.cart.removeItem(toIdentity(request), request.sku ?? ''),
    );
  }

  @GrpcMethod(SERVICE, 'ClearCart')
  async clearCart(request: ClearCartRequest): Promise<CartView> {
    return toCartView(await this.cart.clearCart(toIdentity(request)));
  }

  /**
   * The explicit merge: fold the guest basket `guestSessionId` names into the cart the
   * request's own identity addresses.
   *
   * @remarks `merged: false` is an ordinary answer (no guest basket existed), not a
   * failure — the edge retries nothing and reports nothing for it.
   */
  @GrpcMethod(SERVICE, 'MergeGuestCart')
  async mergeGuestCart(request: MergeGuestCartRequest): Promise<MergeGuestCartResponse> {
    const merged = await this.cart.mergeGuestCart(
      toIdentity(request),
      request.guestSessionId ?? '',
    );

    return { merged };
  }

  @GrpcMethod(SERVICE, 'GetCheckoutLines')
  async getCheckoutLines(request: GetCartRequest): Promise<CheckoutLines> {
    const snapshot = await this.cart.getCheckoutLines(toIdentity(request));

    return {
      lines: snapshot.lines.map((line) => ({
        sku: line.sku,
        productId: line.productId,
        name: line.name,
        quantity: line.quantity,
        unitPrice: toShopMoney(line.unitPrice),
      })),
      subtotal: toShopMoney(snapshot.subtotal),
      currency: snapshot.currency,
      version: snapshot.version,
    };
  }

  @GrpcMethod(SERVICE, 'ValidateForCheckout')
  async validateForCheckout(
    request: GetCartRequest,
  ): Promise<ValidateForCheckoutResponse> {
    const result = await this.cart.validateForCheckout(toIdentity(request));

    return {
      valid: result.valid,
      unavailableSkus: [...result.unavailableSkus],
      priceChanges: result.priceChanges.map((change) => ({
        sku: change.sku,
        oldPrice: toShopMoney(change.oldPrice),
        newPrice: toShopMoney(change.newPrice),
      })),
    };
  }
}

function toIdentity(request: CartRequestLike): CartIdentity {
  return {
    sessionId: request.sessionId ?? '',
    userId: request.userId ?? '',
  };
}

function toCartView(model: CartReadModel): CartView {
  return {
    sessionId: model.sessionId,
    userId: model.userId,
    items: model.items.map((item) => ({
      sku: item.sku,
      productId: item.productId,
      name: item.name,
      quantity: item.quantity,
      unitPrice: toShopMoney(item.unitPrice),
      totalPrice: toShopMoney(item.totalPrice),
      addedAt: item.addedAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
      priceChanged: item.priceChanged,
    })),
    status: model.status,
    itemCount: model.itemCount,
    // An empty cart has no currency, and inventing `USD` here would put a code on the wire
    // that no line in the basket actually uses.
    subtotal: toShopMoney(model.subtotal),
    total: toShopMoney(model.total),
    currency: model.currency,
    expiresAt: model.expiresAt ? model.expiresAt.toISOString() : '',
    version: model.version,
  };
}
