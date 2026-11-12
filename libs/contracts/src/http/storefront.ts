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
export const CATEGORY_PATH_MAX_LENGTH = 200;
export const QUANTITY_MAX = 999;
export const CURRENCY_LENGTH = 3;
export const PAGE_SIZE_MAX = 100;

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
