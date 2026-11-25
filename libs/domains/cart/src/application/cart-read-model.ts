/**
 * @fileoverview What a cart reads as: the shapes every caller of this module gets back.
 *
 * @remarks Read models, not proto messages. `cart.proto` is the transport's business and
 * lives in the presentation layer; these are the figures the service itself reasons about,
 * in integer minor units, so a second transport does not inherit gRPC's string money by
 * accident.
 *
 * @remarks `total` equals `subtotal` and that is deliberate. The cart never computes tax,
 * discounts or shipping — `cart.proto` says so in as many words, and order (with billing
 * behind it) is where a checkout total is decided. A cart that guessed at a total would
 * show a shopper a number nobody intends to charge them.
 *
 * @remarks Money stays a {@link Money} here rather than becoming a bare number plus a
 * currency code. The read model is still internal to the service; the gRPC controller is
 * the one boundary that flattens it for the wire.
 */
import { Logger } from '@nestjs/common';
import type { Cart } from '../domain/cart.aggregate';
import type { CartStatus } from '../domain/value-objects/cart-status.vo';
import type { Money } from '../domain/value-objects/money';
import type {
  CurrentPrice,
  ProductPricingPort,
} from '../domain/ports/product-pricing.port';

const logger = new Logger('CartReadModel');

export interface CartItemReadModel {
  readonly sku: string;
  readonly productId: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly totalPrice: Money;
  readonly addedAt: Date;
  readonly updatedAt: Date;
  /**
   * The catalogue has moved away from this line's snapshot.
   *
   * @remarks `false` when the SKU is no longer listed, because there is then no price to
   * compare against — unavailability is reported by `ValidateForCheckout`, which is the
   * call that has to be authoritative about it.
   */
  readonly priceChanged: boolean;
}

export interface CartReadModel {
  readonly sessionId: string;
  readonly userId: string;
  readonly status: CartStatus;
  readonly version: number;
  readonly itemCount: number;
  /** `null` for an empty cart, which has no currency. */
  readonly subtotal: Money | null;
  readonly total: Money | null;
  readonly currency: string;
  /** When the stored document expires, or `null` when nothing is stored yet. */
  readonly expiresAt: Date | null;
  readonly items: readonly CartItemReadModel[];
}

export interface CheckoutLineReadModel {
  readonly sku: string;
  readonly productId: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPrice: Money;
}

export interface CheckoutLinesReadModel {
  readonly lines: readonly CheckoutLineReadModel[];
  readonly subtotal: Money | null;
  readonly currency: string;
  readonly version: number;
}

export interface PriceChangeReadModel {
  readonly sku: string;
  readonly oldPrice: Money;
  readonly newPrice: Money;
}

export interface CheckoutValidationReadModel {
  readonly valid: boolean;
  readonly unavailableSkus: readonly string[];
  readonly priceChanges: readonly PriceChangeReadModel[];
}

export interface CartViewDeps {
  readonly pricing: ProductPricingPort;
  readonly ttlSeconds: number;
}

/**
 * A cart as every one of its five `Cart`-returning RPCs answers.
 *
 * @remarks The price check is best-effort on purpose. It runs on every read, which means a
 * catalogue outage would otherwise take the basket down with it — and a shopper who cannot
 * *see* what is in their basket cannot be told anything about it either. So the snapshot
 * is always served and the flag simply stays `false`, with a warning in the log; the call
 * that must be authoritative about prices, `ValidateForCheckout`, does not degrade this
 * way.
 */
export async function buildCartReadModel(
  cart: Cart,
  deps: CartViewDeps,
): Promise<CartReadModel> {
  const current = await lookupPrices(
    cart.items.map((item) => item.sku.value),
    deps.pricing,
  );

  return {
    sessionId: cart.sessionId,
    userId: cart.userId,
    status: cart.status,
    version: cart.version,
    itemCount: cart.itemCount,
    subtotal: cart.subtotal,
    total: cart.subtotal,
    currency: cart.currency,
    expiresAt:
      cart.version === 0 ? null : new Date(cart.updatedAt.getTime() + deps.ttlSeconds * 1_000),
    items: cart.items.map((item) => {
      const latest = current.get(item.sku.value);
      return {
        sku: item.sku.value,
        productId: item.productId.value,
        name: item.name,
        quantity: item.quantity.value,
        unitPrice: item.unitPrice,
        totalPrice: item.total,
        addedAt: item.addedAt,
        updatedAt: item.updatedAt,
        priceChanged:
          latest !== undefined &&
          latest.active &&
          !latest.price.equals(item.unitPrice),
      };
    }),
  };
}

/** The lines the order service copies when it creates an order. */
export function buildCheckoutLines(cart: Cart): CheckoutLinesReadModel {
  return {
    lines: cart.items.map((item) => ({
      sku: item.sku.value,
      productId: item.productId.value,
      name: item.name,
      quantity: item.quantity.value,
      unitPrice: item.unitPrice,
    })),
    subtotal: cart.subtotal,
    currency: cart.currency,
    version: cart.version,
  };
}

/**
 * Which lines would stop a checkout, and why.
 *
 * @remarks Unlike the read model above this one never degrades: a validation that skipped
 * the catalogue during an outage would answer `valid: true` for a basket full of prices
 * nobody has checked. Failing instead is the honest answer, and the caller already has a
 * 503 for it.
 */
export async function buildCheckoutValidation(
  cart: Cart,
  pricing: ProductPricingPort,
): Promise<CheckoutValidationReadModel> {
  const skus = cart.items.map((item) => item.sku.value);
  if (skus.length === 0) {
    return { valid: true, unavailableSkus: [], priceChanges: [] };
  }

  const current = new Map<string, CurrentPrice>(
    (await pricing.findPrices(skus)).map((price) => [price.sku, price]),
  );

  const unavailableSkus: string[] = [];
  const priceChanges: PriceChangeReadModel[] = [];

  for (const item of cart.items) {
    const latest = current.get(item.sku.value);

    // Absent from the reply, or listed but withdrawn: either way it cannot be bought.
    if (!latest || !latest.active) {
      unavailableSkus.push(item.sku.value);
      continue;
    }

    if (!latest.price.equals(item.unitPrice)) {
      priceChanges.push({
        sku: item.sku.value,
        oldPrice: item.unitPrice,
        newPrice: latest.price,
      });
    }
  }

  return {
    // A price that moved is a price the shopper has not agreed to *yet*, so the answer is
    // "not valid" until they confirm it — not "valid, but here is a surprise".
    valid: unavailableSkus.length === 0 && priceChanges.length === 0,
    unavailableSkus,
    priceChanges,
  };
}

/**
 * Current prices for a basket, or nothing.
 *
 * @remarks Shared by the read model only. `buildCheckoutValidation` deliberately calls the
 * port directly so the two paths cannot quietly acquire the same degrade-on-failure
 * behaviour.
 */
async function lookupPrices(
  skus: readonly string[],
  pricing: ProductPricingPort,
): Promise<Map<string, CurrentPrice>> {
  if (skus.length === 0) return new Map();

  try {
    const prices = await pricing.findPrices(skus);
    return new Map(prices.map((price) => [price.sku, price]));
  } catch (error) {
    logger.warn(
      `price check failed; serving snapshot prices unchanged: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return new Map();
  }
}
