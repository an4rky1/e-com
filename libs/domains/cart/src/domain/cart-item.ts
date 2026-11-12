/**
 * @fileoverview One line of a cart: a SKU, a quantity, and the price it was added at.
 *
 * @remarks The price snapshot is the reason this is a value object rather than an array of
 * plain records. A cart that re-read the catalogue on every render would show a shopper a
 * different total between the product page and the basket, and a cart that *stored* the
 * current price would silently rewrite what somebody agreed to pay. So the price is copied
 * once, on the way in, and never moved again: {@link CartItem.priceChanged} is how a
 * *later* difference is reported, not how one is erased.
 *
 * @remarks Immutable. Every change returns a new instance, which is what lets a merge fold
 * a guest line into a user line without either side's caller holding a reference that
 * quietly changed underneath it.
 */
import { ValidationException } from '@auth/platform/error-handling';

export interface CartItemProps {
  readonly sku: string;
  readonly productId: string;
  readonly name: string;
  readonly quantity: number;
  /** Integer minor units, as of {@link CartItemProps.addedAt}. Never re-read. */
  readonly unitPriceMinor: number;
  readonly currency: string;
  readonly addedAt: Date;
  readonly updatedAt: Date;
}

/** The limits a caller has to respect; supplied by the handler, read from `CART_*`. */
export interface CartItemLimits {
  readonly maxQuantityPerItem: number;
}

/** What a price lookup answers for a SKU that is currently sellable. */
export interface NewCartItemInput {
  readonly sku: string;
  readonly productId: string;
  readonly name: string;
  readonly unitPriceMinor: number;
  readonly currency: string;
  readonly quantity: number;
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class CartItem {
  private constructor(private readonly props: CartItemProps) {}

  /**
   * A line the shopper just added.
   *
   * @remarks Every rule about a line is asserted here rather than at the call sites: the
   * handler validates the *request*, this validates the *fact*, and a third entry point
   * (a future merge, a future import) inherits both instead of one.
   */
  static create(input: NewCartItemInput, limits: CartItemLimits, now: Date): CartItem {
    const sku = input.sku?.trim() ?? '';
    if (sku.length === 0) {
      throw new ValidationException('sku is required', { sku: input.sku });
    }
    if (typeof input.productId !== 'string' || input.productId.trim().length === 0) {
      throw new ValidationException('productId is required', { sku });
    }
    assertQuantity(input.quantity, limits, sku);
    assertPrice(input.unitPriceMinor, sku);
    if (!CURRENCY_PATTERN.test(input.currency)) {
      throw new ValidationException('currency must be a 3-letter ISO-4217 code', {
        sku,
        currency: input.currency,
      });
    }

    return new CartItem({
      sku,
      productId: input.productId,
      name: input.name ?? '',
      quantity: input.quantity,
      unitPriceMinor: input.unitPriceMinor,
      currency: input.currency,
      addedAt: now,
      updatedAt: now,
    });
  }

  /**
   * A line read back from storage.
   *
   * @remarks Does not re-validate. The persisted document is validated once, on the way in
   * by the store's own schema; re-checking here would be a second copy of the same rules
   * with every chance of drifting from it. What it *does* guarantee is that a stored line
   * becomes a domain object with no transformation — the shape the aggregate reasons about
   * and the shape Redis holds are the same shape.
   */
  static restore(props: CartItemProps): CartItem {
    return new CartItem({ ...props });
  }

  get sku(): string {
    return this.props.sku;
  }

  get productId(): string {
    return this.props.productId;
  }

  get name(): string {
    return this.props.name;
  }

  get quantity(): number {
    return this.props.quantity;
  }

  get unitPriceMinor(): number {
    return this.props.unitPriceMinor;
  }

  get currency(): string {
    return this.props.currency;
  }

  get addedAt(): Date {
    return this.props.addedAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  /** What this line is worth at the price it was added at. */
  get totalMinor(): number {
    return this.props.quantity * this.props.unitPriceMinor;
  }

  /** The same line at an absolute quantity. */
  withQuantity(quantity: number, limits: CartItemLimits, now: Date): CartItem {
    assertQuantity(quantity, limits, this.props.sku);
    return new CartItem({
      ...this.props,
      quantity,
      updatedAt: now,
    });
  }

  /**
   * The same line with `additional` more units — the shape a merge and an add both need.
   *
   * @remarks Deliberately does *not* re-apply {@link CartItemLimits.maxQuantityPerItem}.
   * The cap belongs to what a shopper explicitly asks for; a merge is not asking, and
   * refusing it would mean signing in could fail because two carts together hold more of
   * something than one cart is allowed to. The sum may overshoot the cap, and the shopper
   * can always lower it — the reverse (a merge that silently dropped units) could not be
   * undone at all.
   */
  plusQuantity(additional: number, now: Date): CartItem {
    if (!Number.isSafeInteger(additional) || additional < 1) {
      throw new ValidationException('quantity must be a positive integer', {
        sku: this.props.sku,
        quantity: additional,
      });
    }

    const quantity = this.props.quantity + additional;
    if (!Number.isSafeInteger(quantity)) {
      throw new ValidationException('quantity is out of range', {
        sku: this.props.sku,
        quantity,
      });
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

function assertQuantity(
  quantity: unknown,
  limits: CartItemLimits,
  sku: string,
): void {
  if (!Number.isSafeInteger(quantity)) {
    throw new ValidationException('quantity must be an integer', {
      sku,
      quantity,
    });
  }
  const value = quantity as number;
  if (value < 1) {
    throw new ValidationException('quantity must be at least 1', { sku, quantity });
  }
  if (value > limits.maxQuantityPerItem) {
    throw new ValidationException('quantity exceeds the per-item limit', {
      sku,
      quantity,
      maxQuantityPerItem: limits.maxQuantityPerItem,
    });
  }
}

function assertPrice(unitPriceMinor: unknown, sku: string): void {
  if (!Number.isSafeInteger(unitPriceMinor) || (unitPriceMinor as number) < 0) {
    throw new ValidationException(
      'unit price must be a non-negative integer of minor units',
      { sku, unitPriceMinor },
    );
  }
}
