/**
 * @fileoverview The only public surface of the order module.
 *
 * @remarks Everything that talks to this service — the gRPC controller, a test in another
 * lib — depends on this class and nothing else. It therefore cannot reach the repository,
 * the CQRS bus's handlers or the sagas, which is what makes the module's internals
 * replaceable without touching a single caller.
 *
 * @remarks It speaks in read models (`OrderView`), never in proto messages: the transport
 * shape belongs to the presentation layer, and a second copy of it here would be a second
 * thing to keep in step with `order.proto`.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import type { OrderView } from '@auth/contracts';
import { CreateOrderCommand, CancelOrderCommand } from '../commands/order.command';
import { GetOrderQuery, ListUserOrdersQuery, type OrderListResult } from '../queries/order.queries';

@Injectable()
export class OrderService {
  constructor(
    // Explicit tokens rather than relying on `design:paramtypes`: a type-only import is
    // erased before the decorator metadata is emitted, so the parameter would arrive as
    // `Object` and the container would have nothing to resolve it against.
    @Inject(CommandBus) private readonly commandBus: CommandBus,
    @Inject(QueryBus) private readonly queryBus: QueryBus,
  ) {}

  /**
   * Creates an order from a cart snapshot and runs the checkout saga.
   *
   * @remarks `idempotencyKey` is required: the same key with the same payload returns the
   * same order; with a different payload it is an IDEMPOTENCY_CONFLICT, not a second order.
   */
  createOrder(input: {
    userId: string;
    sessionId: string;
    idempotencyKey: string;
    currency: string;
    paymentMethodToken?: string;
    customerCountry?: string;
    couponCode?: string;
  }): Promise<OrderView> {
    return this.commandBus.execute(
      new CreateOrderCommand(
        input.userId,
        input.sessionId,
        input.idempotencyKey,
        input.currency,
        input.paymentMethodToken ?? '',
        input.customerCountry ?? '',
        input.couponCode ?? '',
      ),
    );
  }

  /** One order, or a 404 — including when it belongs to somebody else. */
  getOrder(orderId: string, userId: string): Promise<OrderView> {
    return this.queryBus.execute(new GetOrderQuery(orderId, userId));
  }

  /** Newest-first page of a user's orders. */
  listUserOrders(input: {
    userId: string;
    page: number;
    pageSize: number;
  }): Promise<OrderListResult> {
    return this.queryBus.execute(
      new ListUserOrdersQuery(input.userId, input.page, input.pageSize),
    );
  }

  /**
   * Cancels an order, refunding and releasing stock as the status requires.
   *
   * @remarks Idempotent: cancelling an already-canceled order returns it unchanged.
   */
  cancelOrder(input: {
    orderId: string;
    userId: string;
    reason?: string;
  }): Promise<OrderView> {
    return this.commandBus.execute(
      new CancelOrderCommand(input.orderId, input.userId, input.reason ?? 'canceled_by_user'),
    );
  }
}
