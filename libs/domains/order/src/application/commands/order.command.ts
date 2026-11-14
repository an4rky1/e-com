/**
 * @fileoverview Commands and their results for the order module.
 *
 * @remarks Commands are classes rather than plain interfaces so `CommandBus.execute` can
 * dispatch by type — the same reason every other domain in this repo declares them.
 */
import type { OrderView } from '@auth/contracts';

/**
 * Creates an order from a cart snapshot and runs the checkout saga.
 *
 * @remarks `idempotencyKey` is required and caller-chosen: the same key with the same
 * payload returns the same order; with a different payload it is a conflict, not a silent
 * second order.
 */
export class CreateOrderCommand {
  constructor(
    readonly userId: string,
    readonly sessionId: string,
    readonly idempotencyKey: string,
    readonly currency: string,
    readonly paymentMethodToken: string,
    /** The jurisdiction billing priced the preview at; empty means its default. */
    readonly customerCountry = '',
    /** The coupon the preview discounted with; empty means none. */
    readonly couponCode = '',
  ) {}
}

export class CancelOrderCommand {
  constructor(
    readonly orderId: string,
    readonly userId: string,
    readonly reason: string,
  ) {}
}

/** What `CreateOrder` returns to the caller: the frozen order as a read model. */
export type CreatedOrder = OrderView;
export type CanceledOrder = OrderView;
