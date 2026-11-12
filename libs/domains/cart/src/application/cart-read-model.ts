/**
 * @fileoverview What a cart reads as: the shapes every caller of this module gets back.
 *
 * @remarks Read models, not proto messages. `cart.proto` is the transport's business and
 * lives in the presentation layer; these are the figures the service itself reasons about,
 * in integer minor units, so a second transport does not inherit gRPC's string money by
 * accident.
 *
 * @remarks `totalMinor` equals `subtotalMinor` and that is deliberate. The cart never
 * computes tax, discounts or shipping — `cart.proto` says so in as many words, and order
 * (with billing behind it) is where a checkout total is decided. A cart that guessed at a
 * total would show a shopper a number nobody intends to charge them.
 */
import { Logger } from '@nestjs/common';
import type { Cart, CartStatus } from '../domain/cart.aggregate';
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
  readonly unitPriceMinor: number;
  readonly totalPriceMinor: number;
  readonly currency: string;
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
  readonly subtotalMinor: number;
  readonly totalMinor: number;
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
  readonly unitPriceMinor: number;
  readonly currency: string;
}

export interface CheckoutLinesReadModel {
  readonly lines: readonly CheckoutLineReadModel[];
  readonly subtotalMinor: number;
  readonly currency: string;
  readonly version: number;
}

export interface PriceChangeReadModel {
  readonly sku: string;
  readonly oldPrice: { readonly amountMinor: number; readonly currency: string };
  readonly newPrice: { readonly amountMinor: number; readonly currency: string };
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
    cart.items.map((item) => item.sku),
    deps.pricing,
  );

  return {
    sessionId: cart.sessionId,
    userId: cart.userId,
    status: cart.status,
    version: cart.version,
    itemCount: cart.itemCount,
    subtotalMinor: cart.subtotalMinor,
    totalMinor: cart.subtotalMinor,
    currency: cart.currency,
    expiresAt:
      cart.version === 0 ? null : new Date(cart.updatedAt.getTime() + deps.ttlSeconds * 1_000),
    items: cart.items.map((item) => {
      const latest = current.get(item.sku);
      return {
        sku: item.sku,
        productId: item.productId,
        name: item.name,
        quantity: item.quantity,
        unitPriceMinor: item.unitPriceMinor,
        totalPriceMinor: item.totalMinor,
        currency: item.currency,
        addedAt: item.addedAt,
        updatedAt: item.updatedAt,
        priceChanged:
          latest !== undefined &&
          latest.active &&
          (latest.priceMinor !== item.unitPriceMinor ||
            latest.currency !== item.currency),
      };
    }),
  };
}

/** The lines the order service copies when it creates an order. */
export function buildCheckoutLines(cart: Cart): CheckoutLinesReadModel {
  return {
    lines: cart.items.map((item) => ({
      sku: item.sku,
      productId: item.productId,
      name: item.name,
      quantity: item.quantity,
      unitPriceMinor: item.unitPriceMinor,
      currency: item.currency,
    })),
    subtotalMinor: cart.subtotalMinor,
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
  const skus = cart.items.map((item) => item.sku);
  if (skus.length === 0) {
    return { valid: true, unavailableSkus: [], priceChanges: [] };
  }

  const current = new Map<string, CurrentPrice>(
    (await pricing.findPrices(skus)).map((price) => [price.sku, price]),
  );

  const unavailableSkus: string[] = [];
  const priceChanges: PriceChangeReadModel[] = [];

  for (const item of cart.items) {
    const latest = current.get(item.sku);

    // Absent from the reply, or listed but withdrawn: either way it cannot be bought.
    if (!latest || !latest.active) {
      unavailableSkus.push(item.sku);
      continue;
    }

    if (latest.priceMinor !== item.unitPriceMinor || latest.currency !== item.currency) {
      priceChanges.push({
        sku: item.sku,
        oldPrice: { amountMinor: item.unitPriceMinor, currency: item.currency },
        newPrice: { amountMinor: latest.priceMinor, currency: latest.currency },
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
