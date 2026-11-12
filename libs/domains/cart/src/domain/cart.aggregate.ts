/**
 * @fileoverview The cart aggregate: everything a shopper has decided to buy so far.
 *
 * @remarks One cart per owner key, held in Redis rather than a database, and treated here
 * exactly as any other aggregate is treated — invariants in one place, every mutation
 * through a method, nothing written that the aggregate did not agree to.
 *
 * @remarks Two rules the aggregate owns because no caller can be trusted to keep them.
 * First, a cart is single-currency: the first line fixes it and a second currency is
 * refused, because a subtotal that adds dollars to euros is not a number any downstream
 * service can interpret. Second, the version advances on *every* write, which is what
 * makes it usable as the optimistic token `cart.v1` puts on the wire.
 *
 * @remarks Status is modelled but not transitioned: `cart.proto` names the whole lifecycle
 * (`active | converting | converted | expired | abandoned`) and phase E5's checkout saga is
 * the first thing that will move a cart off `active`. Nothing here invents a transition
 * the contract has not defined yet.
 */
import { AggregateRoot } from '@auth/core';
import { ResourceNotFoundException, ValidationException } from '@auth/platform/error-handling';
import { CartItem, type CartItemProps, type NewCartItemInput } from './cart-item';
import type { CartIdentity } from './cart-owner';

export const CART_STATUSES = [
  'active',
  'converting',
  'converted',
  'expired',
  'abandoned',
] as const;

export type CartStatus = (typeof CART_STATUSES)[number];

export function isCartStatus(value: unknown): value is CartStatus {
  return typeof value === 'string' && (CART_STATUSES as readonly string[]).includes(value);
}

/** The limits one cart is allowed to grow to; read from `CART_*` by the handlers. */
export interface CartLimits {
  readonly maxItems: number;
  readonly maxQuantityPerItem: number;
}

/** The address a cart is created under: its owner key plus the identities on the request. */
export interface CartAddress extends CartIdentity {
  readonly ownerKey: string;
}

/**
 * The line as Redis holds it.
 *
 * @remarks Declared here rather than in the store so the aggregate's `toStored` and the
 * store's schema agree by construction — and so a test can build a document without
 * importing ioredis. Dates are ISO strings because that is what a JSON blob carries.
 */
export interface StoredCartItem {
  readonly sku: string;
  readonly productId: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly currency: string;
  readonly addedAt: string;
  readonly updatedAt: string;
}

/** The document Redis holds under one cart key. */
export interface StoredCart {
  readonly sessionId: string;
  readonly userId: string;
  readonly status: CartStatus;
  readonly version: number;
  /** When the document was last written; the TTL slides from here. */
  readonly updatedAt: string;
  readonly items: readonly StoredCartItem[];
}

interface CartProps {
  sessionId: string;
  userId: string;
  status: CartStatus;
  version: number;
  items: CartItem[];
}

export class Cart extends AggregateRoot<string> {
  private constructor(
    id: string,
    private readonly props: CartProps,
    createdAt: Date,
    updatedAt: Date,
  ) {
    super(id, createdAt, updatedAt, null);
  }

  /**
   * The cart a request addresses when there is nothing stored yet.
   *
   * @remarks Built, never saved: a read of a cart nobody has opened must not create a key,
   * or every window that renders a basket would extend the life of an empty document.
   */
  static empty(address: CartAddress, now: Date): Cart {
    return new Cart(
      address.ownerKey,
      {
        sessionId: address.sessionId,
        userId: address.userId,
        status: 'active',
        version: 0,
        items: [],
      },
      now,
      now,
    );
  }

  /**
   * Rehydration from a document the store has already validated.
   *
   * @remarks The owner key is supplied rather than stored: the Redis key *is* the address,
   * and a second copy inside the document would be a second thing to keep in step with it.
   *
   * @remarks Takes no clock. The document carries the only `updatedAt` that matters — the
   * TTL slides from it — so stamping this read with "now" would move a cart's expiry
   * forward every time somebody merely looked at it.
   */
  static fromStored(ownerKey: string, stored: StoredCart): Cart {
    const items = stored.items.map((item) => CartItem.restore(storedItemToProps(item)));
    const updatedAt = new Date(stored.updatedAt);

    return new Cart(
      ownerKey,
      {
        sessionId: stored.sessionId,
        userId: stored.userId,
        status: isCartStatus(stored.status) ? stored.status : 'active',
        version: stored.version,
        items,
      },
      updatedAt,
      updatedAt,
    );
  }

  get sessionId(): string {
    return this.props.sessionId;
  }

  get userId(): string {
    return this.props.userId;
  }

  get status(): CartStatus {
    return this.props.status;
  }

  get items(): readonly CartItem[] {
    return this.props.items;
  }

  /**
   * Position of this cart in its own write stream.
   *
   * @remarks Overrides the base implementation, which counts *buffered events* and would
   * read `0` immediately after they were drained — two carts would then share a version
   * and an optimistic-concurrency check would pass against the wrong document.
   */
  override get version(): number {
    return this.props.version;
  }

  /** Units in the cart, not distinct lines: three of one SKU counts as three. */
  get itemCount(): number {
    return this.props.items.reduce((sum, item) => sum + item.quantity, 0);
  }

  /** Sum of the lines at the prices they were added at. */
  get subtotalMinor(): number {
    return this.props.items.reduce((sum, item) => sum + item.totalMinor, 0);
  }

  /**
   * The cart's one currency, or `''` when it holds nothing.
   *
   * @remarks Derived rather than stored: a currency field that could disagree with the
   * lines it summarises is a field that eventually will.
   */
  get currency(): string {
    return this.props.items[0]?.currency ?? '';
  }

  get isEmpty(): boolean {
    return this.props.items.length === 0;
  }

  /**
   * Adds a line, or tops one up.
   *
   * @remarks The price that was just looked up is used only when the SKU is *new*. An
   * existing line keeps the price it was added at, even though the catalogue may have
   * moved: rewriting it here is exactly the silent total change `cart.v1.price_changed`
   * exists to prevent. The lookup still happened, and its answer still decides whether
   * the SKU may be added at all.
   *
   * @remarks A second currency is refused rather than summed. The first line fixes the
   * cart's currency, and a cart that mixed them would produce a subtotal no downstream
   * service could interpret.
   */
  addItem(input: NewCartItemInput, limits: CartLimits, now: Date): void {
    const existing = this.props.items.find((item) => item.sku === input.sku.trim());

    // Checked for a *new* line as well as a top-up. Testing only the existing-SKU case
    // would let a second SKU in another currency in through the front door, and a subtotal
    // that adds dollars to euros is not a number any downstream service can interpret.
    if (!this.isEmpty && this.currency !== input.currency) {
      throw new ValidationException('a cart holds one currency only', {
        sku: input.sku,
        cartCurrency: this.currency,
        itemCurrency: input.currency,
      });
    }

    if (!existing && this.props.items.length >= limits.maxItems) {
      throw new ValidationException('the cart is full', {
        sku: input.sku,
        maxItems: limits.maxItems,
      });
    }

    if (existing) {
      const index = this.props.items.indexOf(existing);
      const items = [...this.props.items];
      items[index] = existing.plusQuantity(input.quantity, now);
      this.props.items = items;
      this.bump(now);
      return;
    }

    const items = [...this.props.items];
    items.push(CartItem.create(input, limits, now));
    this.props.items = items;
    this.bump(now);
  }

  /** Sets a line to an absolute quantity. */
  updateQuantity(sku: string, quantity: number, limits: CartLimits, now: Date): void {
    const index = this.indexOf(sku);
    const items = [...this.props.items];
    items[index] = items[index].withQuantity(quantity, limits, now);
    this.props.items = items;
    this.bump(now);
  }

  /** Drops a line. Refuses a SKU that is not there rather than pretending to remove it. */
  removeItem(sku: string, now: Date): void {
    const index = this.indexOf(sku);
    this.props.items = this.props.items.filter((_, position) => position !== index);
    this.bump(now);
  }

  /** Empties the cart. Keeps the document — an empty cart is still this shopper's cart. */
  clear(now: Date): void {
    if (this.props.items.length === 0) return;
    this.props.items = [];
    this.bump(now);
  }

  /**
   * Folds a guest cart into this one, line by line.
   *
   * @remarks Deduplicated by SKU with quantities summed, and the *user's* snapshot wins
   * when both carts hold the same SKU: the price they saw when they added it is the price
   * they agreed to, and replacing it with the guest's older or newer figure would be the
   * silent rewrite this service exists to avoid. The `price_changed` flag reports the
   * difference against the catalogue instead.
   *
   * @remarks Skips the per-item ceiling on purpose. Refusing the merge would mean signing
   * in can fail because two carts together hold more of something than one cart may hold;
   * clamping would silently drop units the shopper can never get back. The sum may
   * overshoot, and they can always lower it.
   *
   * @remarks A no-op for an empty guest cart, so a read that found nothing to merge does
   * not spend a version number on it.
   */
  mergeGuest(guestItems: readonly CartItemProps[], now: Date): void {
    if (guestItems.length === 0) return;

    const items = [...this.props.items];

    for (const guest of guestItems) {
      const index = items.findIndex((item) => item.sku === guest.sku);

      if (index >= 0) {
        items[index] = items[index].plusQuantity(guest.quantity, now);
        continue;
      }

      items.push(
        CartItem.restore({
          ...guest,
          updatedAt: now,
        }),
      );
    }

    this.props.items = items;
    this.bump(now);
  }

  /** The document this cart is written back as. */
  toStored(): StoredCart {
    return {
      sessionId: this.props.sessionId,
      userId: this.props.userId,
      status: this.props.status,
      version: this.props.version,
      updatedAt: this.updatedAt.toISOString(),
      items: this.props.items.map((item) => {
        const props = item.toProps();
        return {
          sku: props.sku,
          productId: props.productId,
          name: props.name,
          quantity: props.quantity,
          unitPriceMinor: props.unitPriceMinor,
          currency: props.currency,
          addedAt: props.addedAt.toISOString(),
          updatedAt: props.updatedAt.toISOString(),
        };
      }),
    };
  }

  private indexOf(sku: string): number {
    const trimmed = sku?.trim() ?? '';
    const index = this.props.items.findIndex((item) => item.sku === trimmed);

    if (index < 0) {
      throw new ResourceNotFoundException('the cart has no such item', {
        sku: trimmed,
        sessionId: this.props.sessionId,
      });
    }

    return index;
  }

  /** Every mutation goes through here, so `version` can never lag behind a write. */
  private bump(now: Date): void {
    this.props.version += 1;
    this.updatedAt = now;
  }
}

/**
 * A stored line as the value object spells it.
 *
 * @remarks The one conversion between the two shapes, shared by rehydration and by the
 * merge: a conversion stated twice is a conversion that eventually differs between the
 * read path and the write path, and the difference would only surface as a cart that
 * sums differently depending on how it was opened.
 */
export function storedItemToProps(item: StoredCartItem): CartItemProps {
  return {
    sku: item.sku,
    productId: item.productId,
    name: item.name,
    quantity: item.quantity,
    unitPriceMinor: item.unitPriceMinor,
    currency: item.currency,
    addedAt: new Date(item.addedAt),
    updatedAt: new Date(item.updatedAt),
  };
}
