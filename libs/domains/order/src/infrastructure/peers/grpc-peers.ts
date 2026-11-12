/**
 * @fileoverview The three peers the checkout/cancel sagas call, over gRPC.
 *
 * @remarks Each adapter takes a {@link GrpcChannel} rather than a `ClientGrpcProxy`, so no
 * adapter here knows about Nest transport. That also makes a unit test a plain object
 * literal instead of an open socket.
 *
 * @remarks Failures are translated here rather than left for the caller, and only into the
 * two shapes a caller can act on: "the peer did not answer in time" and "the peer is not
 * there". Anything else — a wiring bug, a rejected request — is rethrown untouched, because
 * a missing proto address that surfaced as an outage would be retried forever by callers
 * doing exactly the right thing.
 */
import { GrpcStatus, statusCodeOf, type GrpcChannel } from '@auth/infra/grpc';
import {
  DependencyTimeoutException,
  DependencyUnavailableException,
} from '@auth/platform/error-handling';
import type {
  ChargeOrderRequest,
  ChargeOrderResponse,
  CheckoutLines,
  RefundOrderRequest,
  RefundOrderResponse,
  ReleaseResponse,
  ReserveResponse,
  ValidateForCheckoutResponse,
} from '@auth/contracts';
import { parseShopMoney } from '../../money';
import type { OrderConfig } from '../../order.config';
import type {
  BillingPeerPort,
  CartPeerPort,
  InventoryPeerPort,
  PeerReserveLine,
} from '../../domain/ports/peer-ports';

/** Full method paths, so a mistyped service name fails here rather than at the broker. */
const METHOD = {
  VALIDATE_FOR_CHECKOUT: '/cart.v1.CartService/ValidateForCheckout',
  GET_CHECKOUT_LINES: '/cart.v1.CartService/GetCheckoutLines',
  CLEAR_CART: '/cart.v1.CartService/ClearCart',
  RESERVE: '/inventory.v1.InventoryService/Reserve',
  RELEASE: '/inventory.v1.InventoryService/Release',
  CHARGE: '/billing.v1.BillingService/ChargeOrder',
  REFUND: '/billing.v1.BillingService/RefundOrder',
} as const;

/** Shared call + translate plumbing. */
abstract class PeerAdapter {
  constructor(
    protected readonly channel: GrpcChannel,
    protected readonly config: OrderConfig,
  ) {}

  protected call<TRequest extends object, TResponse>(
    method: string,
    request: TRequest,
  ): Promise<TResponse> {
    // The deadline is computed per call rather than captured once: it is an absolute
    // instant, so a value captured at construction would already have expired.
    return this.channel
      .unary<TRequest, TResponse>(method, request, {
        deadline: Date.now() + this.config.grpcDeadlineMs,
      })
      .catch((error: unknown) => {
        throw this.translate(error, method);
      });
  }

  private translate(error: unknown, method: string): unknown {
    if (typeof (error as { code?: unknown } | null)?.code !== 'number') {
      // Not a transport status — a proto that was never loaded, an address that was never
      // given. Masking it as an outage would send callers into a retry that can never
      // succeed, and would hide the wiring bug behind a dashboard showing a sick dependency.
      return error;
    }

    const status = statusCodeOf(error);
    const peer = method.split('/')[1]?.split('.')[0] ?? 'peer';

    if (status === GrpcStatus.DEADLINE_EXCEEDED) {
      return new DependencyTimeoutException(
        `${peer} did not answer in time`,
        { method },
        error,
      );
    }

    if (
      status === GrpcStatus.UNAVAILABLE ||
      status === GrpcStatus.UNIMPLEMENTED
    ) {
      return new DependencyUnavailableException(
        `${peer} could not be reached`,
        { method },
        error,
      );
    }

    return error;
  }
}

export class GrpcCartPeer extends PeerAdapter implements CartPeerPort {
  validateForCheckout(
    sessionId: string,
    userId: string,
  ): Promise<ValidateForCheckoutResponse> {
    return this.call(METHOD.VALIDATE_FOR_CHECKOUT, { sessionId, userId });
  }

  getCheckoutLines(sessionId: string, userId: string): Promise<CheckoutLines> {
    return this.call(METHOD.GET_CHECKOUT_LINES, { sessionId, userId });
  }

  async clearCart(sessionId: string, userId: string): Promise<void> {
    await this.call(METHOD.CLEAR_CART, { sessionId, userId });
  }
}

export class GrpcInventoryPeer extends PeerAdapter implements InventoryPeerPort {
  reserve(
    orderId: string,
    lines: readonly PeerReserveLine[],
    warehouseId: string,
  ): Promise<ReserveResponse> {
    return this.call(METHOD.RESERVE, {
      orderId,
      warehouseId,
      lines: lines.map((line) => ({ sku: line.sku, qty: line.qty })),
    });
  }

  release(orderId: string, warehouseId: string): Promise<ReleaseResponse> {
    return this.call(METHOD.RELEASE, { orderId, warehouseId });
  }
}

export class GrpcBillingPeer extends PeerAdapter implements BillingPeerPort {
  async charge(request: ChargeOrderRequest): Promise<ChargeOrderResponse> {
    // Money is re-serialised here rather than passed through: the peer's wire shape wants
    // strings, and a caller that already holds minor units should not have to know that.
    return this.call(METHOD.CHARGE, {
      orderId: request.orderId,
      idempotencyKey: request.idempotencyKey,
      amount: {
        amountMinor: String(request.amount.amountMinor),
        currency: request.amount.currency,
      },
      paymentMethodToken: request.paymentMethodToken,
      customerId: request.customerId,
      lines: request.lines.map((line) => ({
        sku: line.sku,
        quantity: line.quantity,
        unitPrice: {
          amountMinor: String(line.unitPrice.amountMinor),
          currency: line.unitPrice.currency,
        },
      })),
      customerCountry: request.customerCountry,
    });
  }

  async refund(request: RefundOrderRequest): Promise<RefundOrderResponse> {
    return this.call(METHOD.REFUND, {
      orderId: request.orderId,
      paymentId: request.paymentId,
      // Empty amount means a full refund — the proto's own convention, passed through.
      amount: request.amount
        ? {
            amountMinor: String(request.amount.amountMinor),
            currency: request.amount.currency,
          }
        : undefined,
      reason: request.reason,
      idempotencyKey: request.idempotencyKey,
    });
  }
}

/** Re-exported so a test can assert money parsing matches the cart's own rules. */
export { parseShopMoney };
