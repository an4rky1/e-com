/**
 * @fileoverview Pessimistic concurrency control for a cart document.
 *
 * @remarks A cart is a JSON blob read, changed and written back. Two requests that read
 * the same blob and write different changes lose one of them — the classic lost update,
 * and for a cart it is a shopper whose second item silently never arrived. The lock turns
 * that read-modify-write into one section no other request can enter.
 *
 * @remarks The lock lives behind a port for the same reason the store does: the handlers
 * express *that* a section is exclusive, not how, and a test answers with a function that
 * simply runs the callback.
 */
export const CART_LOCK = Symbol('CART_LOCK');

export interface CartLockPort {
  /**
   * Runs `fn` while holding every name in `names`.
   *
   * @remarks Takes the names as a set because a merge holds two carts at once, and the
   * order they are taken in has to be fixed across all callers or two opposite requests
   * deadlock against each other. The set is the contract; the order is the lock's job.
   */
  withLock<T>(names: readonly string[], fn: () => Promise<T>): Promise<T>;
}
