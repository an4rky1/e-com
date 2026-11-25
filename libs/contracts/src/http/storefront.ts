/**
 * @fileoverview The storefront bodies that cross the edge: catalog, cart, checkout, orders.
 *
 * @remarks Shapes mirror the shop gRPC contracts (`@auth/contracts` service-contracts) so a
 * page and the gateway cannot disagree about what a well-formed add-to-cart looks like. Money
 * stays a {@link ShopMoney} string pair on the wire — the same integer minor units the domain
 * reasons about, never a float.
 */
import type { ShopMoney } from '../grpc/service-contracts';
import type { CatalogProduct, ProductList, CartView, CheckoutLines, ValidateForCheckoutResponse, OrderView, ListUserOrdersResponse, InvoiceView } from '../grpc/service-contracts';

export type {
  ShopMoney,
  CatalogProduct,
  ProductList,
  CartView,
  CheckoutLines,
  ValidateForCheckoutResponse,
  OrderView,
  ListUserOrdersResponse,
  InvoiceView,
};

// ---- field limits -------------------------------------------------------------------

export const SKU_MAX_LENGTH = 64;
export const PRODUCT_NAME_MAX_LENGTH = 200;
/** An amount in minor units as a digit string — wide enough for any realistic total. */
export const MONEY_AMOUNT_MAX_LENGTH = 24;
export const PRODUCT_DESCRIPTION_MAX_LENGTH = 4_000;
export const CATEGORY_PATH_MAX_LENGTH = 200;
export const QUANTITY_MAX = 999;
export const QUANTITY_MIN = 1;
export const CURRENCY_LENGTH = 3;
/** ISO 3166-1 alpha-2, e.g. `DE`. */
export const COUNTRY_CODE_LENGTH = 2;
export const COUPON_CODE_MAX_LENGTH = 32;
/** A PSP payment-method token presented once and never stored here. */
export const PAYMENT_TOKEN_MAX_LENGTH = 512;

// ---- catalog ------------------------------------------------------------------------

export interface CatalogListQuery {
  /** Comma-joined category path segments; empty lists the root. */
  categoryPath?: string;
  page?: number;
  pageSize?: number;
}

export interface CatalogCreateProductRequest {
  name: string;
  description: string;
  categoryPath: string[];
  variants: {
    sku: string;
    price: ShopMoney;
    attrs?: Record<string, string>;
  }[];
  mediaKeys?: string[];
}

export interface CatalogSetPriceRequest {
  productId: string;
  sku: string;
  price: ShopMoney;
}

// ---- cart ---------------------------------------------------------------------------

export interface AddCartItemRequest {
  sku: string;
  quantity: number;
}

export interface UpdateCartItemRequest {
  sku: string;
  quantity: number;
}

export interface RemoveCartItemRequest {
  sku: string;
}

/**
 * The answer to `POST /cart/merge`.
 *
 * @remarks `false` is the ordinary answer — no guest basket existed — and the front treats
 * it exactly like `true`: the call succeeded, there was simply nothing to fold.
 */
export interface MergeCartResponse {
  merged: boolean;
}

// ---- checkout -----------------------------------------------------------------------

export interface CheckoutPreviewRequest {
  customerCountry?: string;
  couponCode?: string;
  currency?: string;
}

export interface CheckoutPreviewResponse {
  lines: CheckoutLines;
  validation: ValidateForCheckoutResponse;
  invoice: InvoiceView;
}

export interface CheckoutCreateRequest {
  /** The jurisdiction the preview was priced at; empty means the configured default. */
  customerCountry?: string;
  /** The coupon the preview discounted with; the charge refuses unknown codes. */
  couponCode?: string;
  currency?: string;
  paymentMethodToken?: string;
}

// ---- orders -------------------------------------------------------------------------

export interface OrderListQuery {
  page?: number;
  pageSize?: number;
}

export interface CancelOrderRequest {
  reason?: string;
}

// ---- webhook ------------------------------------------------------------------------

/** Acknowledged receipt: the PSP is told the event arrived, not that it was applied. */
export interface PaymentWebhookAck {
  received: true;
}
