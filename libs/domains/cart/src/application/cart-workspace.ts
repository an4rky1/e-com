/**
 * @fileoverview The one place a cart is loaded, changed and written back.
 *
 * @remarks Every handler in this service goes through here, because four things have to
 * happen together and none of them is safe alone: the cart is addressed, a guest cart is
 * folded in if this is the first authenticated request to touch it, the whole section runs
 * under the cart's lock, and the result is written back — with the guest key dropped in the
 * same transaction, so the next request cannot merge the same quantities a second time.
 *
 * @remarks Handlers therefore express intent only ("add three") and never see a lock, a
 * key or a TTL. That is what makes them testable with an in-memory store and what keeps
 * the merge rule — the one genuinely subtle thing this service does — in exactly one file.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Cart, storedItemToProps, type CartAddress } from '../domain/cart.aggregate';
import {
  lockNamesFor,
  resolveCartOwner,
  type CartIdentity,
  type CartOwner,
} from '../domain/cart-owner';
import { CART_LOCK, type CartLockPort } from '../domain/ports/cart-lock.port';
import { CART_STORE, type CartStorePort } from '../domain/ports/cart-store.port';
import { CART_CONFIG, type CartConfig } from '../cart.config';

@Injectable()
export class CartWorkspace {
  constructor(
    @Inject(CART_STORE) private readonly store: CartStorePort,
    @Inject(CART_LOCK) private readonly lock: CartLockPort,
    @Inject(CART_CONFIG) private readonly config: CartConfig,
  ) {}

  /**
   * The cart as it stands, folding a guest cart in when there is one to fold.
   *
   * @remarks Returns a built-but-unsaved cart when nothing is stored, rather than `null`:
   * every reader of this service wants a basket to render, and "you have no basket" is a
   * view of an empty cart, not a missing response. The `version: 0` that comes with it is
   * how a caller tells the two apart.
   *
   * @remarks This *can* write. The first authenticated request after sign-in persists the
   * merge; that is the merge-on-sign-in, and there is no separate RPC in `cart.proto` to
   * ask for it.
   */
  read(identity: CartIdentity): Promise<Cart> {
    return this.run(identity, null);
  }

  /**
   * Applies `mutate` to the cart and writes the result back.
   *
   * @remarks Nothing is written when nothing changed — a clear on an already-empty cart,
   * or a merge with no guest — so a read-shaped request that found no work does not spend
   * a version number or refresh a TTL it did not touch.
   */
  mutate(identity: CartIdentity, mutate: (cart: Cart) => void): Promise<Cart> {
    return this.run(identity, mutate);
  }

  private async run(
    identity: CartIdentity,
    mutate: ((cart: Cart) => void) | null,
  ): Promise<Cart> {
    const owner = resolveCartOwner(identity);

    // One section for load, merge, change and save. The two names are taken in a fixed
    // order by the lock, which is what stops a merge deadlocking against a guest request
    // that is locking the same pair the other way round.
    return this.lock.withLock(lockNamesFor(owner), async () => {
      const { cart, loadedVersion, guestLoaded } = await this.prepare(identity, owner);

      mutate?.(cart);

      await this.commit(owner, cart, loadedVersion, guestLoaded);
      return cart;
    });
  }

  private async prepare(
    identity: CartIdentity,
    owner: CartOwner,
  ): Promise<{ cart: Cart; loadedVersion: number; guestLoaded: boolean }> {
    const now = new Date();
    const stored = await this.store.load(owner.key);
    const guestKey =
      owner.guestKey !== null && this.config.autoMerge ? owner.guestKey : null;
    const guest = guestKey !== null ? await this.store.load(guestKey) : null;

    const address: CartAddress = {
      ownerKey: owner.key,
      sessionId: identity.sessionId?.trim() ?? '',
      userId: identity.userId?.trim() ?? '',
    };

    const cart = stored
      ? Cart.fromStored(owner.key, stored)
      : Cart.empty(address, now);

    if (guest !== null) {
      cart.mergeGuest(guest.items.map(storedItemToProps), now);
    }

    return {
      cart,
      loadedVersion: stored?.version ?? 0,
      guestLoaded: guest !== null,
    };
  }

  private async commit(
    owner: CartOwner,
    cart: Cart,
    loadedVersion: number,
    guestLoaded: boolean,
  ): Promise<void> {
    const changed = cart.version !== loadedVersion;
    if (!changed && !guestLoaded) return;

    await this.store.save({
      key: owner.key,
      cart: cart.toStored(),
      ttlSeconds: this.config.ttlSeconds,
      // Only set when a guest document was actually read: dropping a key that was never
      // there is harmless, but naming one that a *different* request still owns would not be.
      discardKey: guestLoaded && owner.guestKey !== null ? owner.guestKey : undefined,
    });
  }
}
