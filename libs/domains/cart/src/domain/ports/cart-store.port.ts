/**
 * @fileoverview Storage port for the cart use cases.
 *
 * @remarks Declared in the domain and implemented in infrastructure so the workspace can
 * read and write a cart without knowing that Redis exists — and so a unit test can answer
 * with a plain object instead of a socket.
 *
 * @remarks The port is deliberately coarse: one `save` rather than `write` + `discard`,
 * because the merge that consumes a guest cart has to be *atomic* with the write that
 * records it. Split into two calls, a crash between them leaves the guest cart alive and
 * the next request merges the same quantities a second time — a shopper who signs in twice
 * and finds their basket has doubled, with no error anywhere to explain it.
 */
import type { StoredCart } from '../cart.aggregate';

export const CART_STORE = Symbol('CART_STORE');

export interface SaveCartInput {
  /** The owner key this cart is stored under. */
  readonly key: string;
  readonly cart: StoredCart;
  /** Sliding TTL applied to the key, in seconds. */
  readonly ttlSeconds: number;
  /**
   * A second key dropped in the same transaction.
   *
   * @remarks Set only when a guest cart was actually folded in. It is the guest key, and
   * dropping it is what stops the same lines being merged again on the next request.
   */
  readonly discardKey?: string;
}

export interface CartStorePort {
  /** The document under `key`, or `null` when there is none. */
  load(key: string): Promise<StoredCart | null>;

  /**
   * Writes the document and, if given, drops `discardKey` — atomically.
   *
   * @remarks A write with no change to record is the caller's decision, not this port's:
   * the workspace compares versions and simply does not call it.
   */
  save(input: SaveCartInput): Promise<void>;

  /**
   * Round-trip for the readiness probe.
   *
   * @remarks Probes the store rather than the socket: "can this service still answer a
   * GetCart?" is the question a readiness check cares about, and it is the store — not the
   * connection behind it — that would refuse first.
   */
  ping(): Promise<void>;
}
