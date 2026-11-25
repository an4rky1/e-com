/**
 * @fileoverview One line of a cart: a SKU, a quantity, and the price it was added at.
 *
 * @remarks The price snapshot is the reason this is a value object rather than an array of
 * plain records. A cart that re-read the catalogue on every render would show a shopper a
 * different total between the product page and the basket, and a cart that *stored* the
 * current price would silently rewrite what somebody agreed to pay. So the price is copied
 * once, on the way in, and never moved again: `priceChanged` on the read model is how a
 * *later* difference is reported, not how one is erased.
 *
 * @remarks Immutable. Every change returns a new instance, which is what lets a merge fold
 * a guest line into a user line without either side's caller holding a reference that
 * quietly changed underneath it.
 *
 * @remarks Every field with a rule is a value object: {@link Sku} for identity,
 * {@link ProductId} for the catalogue reference, {@link Quantity} for the count and
 * {@link Money} for the price. A line therefore cannot be constructed from a raw string and
 * a loose number that each call site validated slightly differently.
 */
import type { Money } from './value-objects/money';
import type { ProductId } from './value-objects/product-id.vo';
import type { Quantity } from './value-objects/quantity.vo';
import type { Sku } from './value-objects/sku.vo';

export interface CartItemProps {
  readonly sku: Sku;
  readonly productId: ProductId;
  readonly name: string;
  readonly quantity: Quantity;
  /** The price snapshot, as of {@link CartItemProps.addedAt}. Never re-read. */
  readonly unitPrice: Money;
  readonly addedAt: Date;
  readonly updatedAt: Date;
}

/** The limits a caller has to respect; supplied by the handler, read from `CART_*`. */
export interface CartItemLimits {
  readonly maxQuantityPerItem: number;
}

/** What a price lookup answers for a SKU that is currently sellable. */
export interface NewCartItemInput {
  readonly sku: Sku;
  readonly productId: ProductId;
  readonly name: string;
  readonly unitPrice: Money;
  readonly quantity: Quantity;
}

export class CartItem {
  private constructor(private readonly props: CartItemProps) {}

  /**
   * A line the shopper just added.
   *
   * @remarks The inputs are already value objects, so there is nothing left to parse here:
   * the handler validated the *request*, and this method enforces the one rule that belongs
   * to the cart — the per-item ceiling.
   */
  static create(input: NewCartItemInput, limits: CartItemLimits, now: Date): CartItem {
    input.quantity.assertAtMost(limits.maxQuantityPerItem, {
      sku: input.sku.value,
    });

    return new CartItem({
      sku: input.sku,
      productId: input.productId,
      name: input.name ?? '',
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      addedAt: now,
      updatedAt: now,
    });
  }

  /**
   * A line read back from storage.
   *
   * @remarks Does not re-validate limits. The persisted document is validated once, on the
   * way in by the store's own schema; re-checking the ceiling here would break a merge that
   * deliberately produced a larger quantity and then round-tripped through Redis. The value
   * objects themselves are restored through their constructors by `storedItemToProps`.
   */
  static restore(props: CartItemProps): CartItem {
    return new CartItem({ ...props });
  }

  get sku(): Sku {
    return this.props.sku;
  }

  get productId(): ProductId {
    return this.props.productId;
  }

  get name(): string {
    return this.props.name;
  }

  get quantity(): Quantity {
    return this.props.quantity;
  }

  get unitPrice(): Money {
    return this.props.unitPrice;
  }

  get addedAt(): Date {
    return this.props.addedAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  /** What this line is worth at the price it was added at. */
  get total(): Money {
    return this.props.unitPrice.multiply(this.props.quantity.value);
  }

  /** The same line at an absolute quantity. */
  withQuantity(quantity: Quantity, limits: CartItemLimits, now: Date): CartItem {
    quantity.assertAtMost(limits.maxQuantityPerItem, {
      sku: this.props.sku.value,
    });

    return new CartItem({
      ...this.props,
      quantity,
      updatedAt: now,
    });
  }

  /**
   * The same line with `additional` more units — the shape a merge and an add both need.
   *
   * @remarks The optional ceiling is passed by an *add*, where the shopper is explicitly
   * asking for more and the resulting line has to respect the per-item limit. A merge
   * deliberately omits it: refusing a sign-in because two carts together hold more of one
   * SKU than a single cart may would strand the guest's units. The merge may overshoot the
   * cap, and the shopper can always lower it — the reverse (a merge that silently dropped
   * units) could not be undone at all.
   */
  plusQuantity(
    additional: Quantity,
    now: Date,
    maxQuantityPerItem?: number,
  ): CartItem {
    const quantity = this.props.quantity.plus(additional);

    if (maxQuantityPerItem !== undefined) {
      quantity.assertAtMost(maxQuantityPerItem, { sku: this.props.sku.value });
    }

    return new CartItem({
      ...this.props,
      quantity,
      updatedAt: now,
    });
  }

  toProps(): CartItemProps {
    return { ...this.props };
  }
}
