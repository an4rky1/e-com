/**
 * @fileoverview The catalogue as the cart sees it: what a SKU costs, and what it is called.
 *
 * @remarks Two questions with two different failure modes, which is why there are two
 * methods. {@link ProductPricingPort.findSellable} answers "may this be added?" — it must
 * succeed for an add to happen, and a catalogue that is unreachable is a refusal, not a
 * default price. {@link ProductPricingPort.findPrices} answers "has anything moved?" for a
 * cart that already exists — it is called on every read, so its caller is free to degrade
 * when it fails and show the prices it already has.
 *
 * @remarks The cart never asks for a product's *current* price to compute a total with.
 * Totals are built from the snapshots the lines already carry; the catalogue is consulted
 * to report a difference, never to overwrite one.
 */
import type { Money } from '../value-objects/money';

export const PRODUCT_PRICING = Symbol('PRODUCT_PRICING');

/** A SKU as the catalogue lists it right now, including the name a line is labelled with. */
export interface SellableSku {
  readonly sku: string;
  readonly productId: string;
  readonly name: string;
  /** The current price as a validated amount + currency, not two loose fields. */
  readonly price: Money;
}

/** One SKU's current price. `active: false` means it is listed but not sellable. */
export interface CurrentPrice {
  readonly sku: string;
  readonly price: Money;
  readonly active: boolean;
}

export interface ProductPricingPort {
  /**
   * Everything needed to add a line, or `null` when the SKU is not sellable.
   *
   * @remarks `null` is a real answer — archived, delisted, never existed — and distinct
   * from "the catalogue did not answer", which is a failure the caller has to see.
   */
  findSellable(sku: string): Promise<SellableSku | null>;

  /**
   * Current prices for several SKUs in one round trip.
   *
   * @remarks A SKU absent from the reply is not listed; that is how a delisted line is
   * told apart from one whose price has not moved. An empty input answers empty without
   * a call, so reading an empty cart does not touch the catalogue at all.
   */
  findPrices(skus: readonly string[]): Promise<CurrentPrice[]>;
}
