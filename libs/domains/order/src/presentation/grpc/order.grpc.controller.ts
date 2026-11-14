/**
 * @fileoverview gRPC transport for order, implementing `OrderGrpcClient` server-side.
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
 * @remarks The controller translates and nothing else. Every rule about what an order may
 * hold lives behind {@link OrderService}, so a second transport cannot reach a different
 * answer — and money crosses this wire as a *string* here and nowhere else.
 */
import { Controller } from '@nestjs/common';
import { GrpcControllerBase, GrpcMethod } from '@auth/infra/grpc';
import type {
  CancelOrderRequest,
  CreateOrderRequest,
  ListUserOrdersRequest,
  ListUserOrdersResponse,
  OrderView,
} from '@auth/contracts';
// Value import on purpose — see the note in `session.grpc.controller.ts`.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { OrderService } from '../../application/facade/order.service';

/** Service name exactly as `libs/contracts/proto/order.proto` declares it. */
const SERVICE = 'OrderService';

/**
 * gRPC transport for order.
 *
 * @remarks `CreateOrder` carries the idempotency key in the request body for the internal
 * transport; an external gateway may also surface it as an `Idempotency-Key` header and
 * copy it here — the domain only ever sees the field. The jurisdiction and coupon ride
 * along so the checkout saga can have billing price the charge under the same terms the
 * storefront's preview was quoted with.
 */
@Controller()
export class OrderGrpcController extends GrpcControllerBase {
  constructor(private readonly orders: OrderService) {
    super();
  }

  @GrpcMethod(SERVICE, 'CreateOrder')
  async createOrder(request: CreateOrderRequest): Promise<OrderView> {
    return this.orders.createOrder({
      userId: request.userId ?? '',
      sessionId: request.sessionId ?? '',
      idempotencyKey: request.idempotencyKey ?? '',
      currency: request.currency ?? '',
      paymentMethodToken: request.paymentMethodToken ?? '',
      customerCountry: request.customerCountry ?? '',
      couponCode: request.couponCode ?? '',
    });
  }

  @GrpcMethod(SERVICE, 'GetOrder')
  async getOrder(request: { orderId?: string; userId?: string }): Promise<OrderView> {
    return this.orders.getOrder(request.orderId ?? '', request.userId ?? '');
  }

  @GrpcMethod(SERVICE, 'ListUserOrders')
  async listUserOrders(request: ListUserOrdersRequest): Promise<ListUserOrdersResponse> {
    const result = await this.orders.listUserOrders({
      userId: request.userId ?? '',
      page: request.page ?? 1,
      pageSize: request.pageSize ?? 0,
    });

    return {
      orders: [...result.orders],
      total: result.total,
    };
  }

  @GrpcMethod(SERVICE, 'CancelOrder')
  async cancelOrder(request: CancelOrderRequest): Promise<OrderView> {
    return this.orders.cancelOrder({
      orderId: request.orderId ?? '',
      userId: request.userId ?? '',
      reason: request.reason ?? '',
    });
  }
}
