/**
 * @fileoverview The cart's mutex, on top of the platform's distributed lock.
 *
 * @remarks Two jobs the platform lock does not do for us. It namespaces the name with the
 * cart's own key prefix, so `lock:cart:user:42` sits next to `cart:data:user:42` and an
 * operator reading Redis sees one namespace per concern. And it takes *several* names,
 * because a merge holds the shopper's cart and the guest cart at the same time — which is
 * only safe if every caller takes that pair in the same order.
 *
 * @remarks The order is fixed here, once, rather than at each call site: a rule stated
 * where the locks are taken is a rule the next caller cannot forget, and two requests
 * acquiring the same two carts in opposite orders is a deadlock that appears only under
 * load and only on sign-in.
 */
import type { DistributedLockingService } from '@auth/infra/distributed-locking';
import type { CartLockPort } from '../../domain/ports/cart-lock.port';

export class CartLockAdapter implements CartLockPort {
  constructor(
    private readonly locking: DistributedLockingService,
    private readonly keyPrefix: string,
  ) {}

  async withLock<T>(names: readonly string[], fn: () => Promise<T>): Promise<T> {
    // De-duplicated first: a guest request's owner key *is* its guest key, and locking the
    // same name twice on one path would wait for itself until the acquisition timed out.
    const ordered = [...new Set(names)].sort();

    const acquire = (index: number): Promise<T> =>
      index === ordered.length
        ? fn()
        : this.locking.withLock(`${this.keyPrefix}:${ordered[index]}`, () =>
            acquire(index + 1),
          );

    return acquire(0);
  }
}
