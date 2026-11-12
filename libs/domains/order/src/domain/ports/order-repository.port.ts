/**
 * @fileoverview The persistence port for the order aggregate.
 *
 * @remarks Application code depends on this interface and never on Prisma, so a handler
 * can be unit-tested with an in-memory double and the Prisma implementation can be
 * swapped without touching a single command.
 */
import type { Order } from '../order.aggregate';

/** DI token for the repository. */
export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');

/** Page of orders for a user, newest first. */
export interface OrderPage {
  readonly orders: readonly Order[];
  readonly total: number;
}

export interface OrderRepositoryPort {
  /**
   * Writes the order, its lines and its events atomically.
   *
   * @remarks The transactional-outbox guarantee: the row and the event envelopes go in
   * together, so either a consumer eventually hears about the order or nothing about it
   * exists at all.
   */
  save(order: Order): Promise<void>;

  findById(orderId: string): Promise<Order | null>;

  /**
   * Finds by the caller-chosen idempotency key.
   *
   * @remarks The unique index on `orders.idempotency_key` is what makes a redelivered
   * CreateOrder return the same order instead of minting a second one.
   */
  findByIdempotencyKey(key: string): Promise<Order | null>;

  /**
   * Newest-first page for one user.
   *
   * @remarks `page`/`pageSize` are 1-based; `total` is the full count so a pager can render
   * without a second query shape.
   */
  listForUser(
    userId: string,
    page: number,
    pageSize: number,
  ): Promise<OrderPage>;

  /** Health probe: can we talk to the store at all? */
  probe(): Promise<number>;
}
