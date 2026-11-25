/**
 * @fileoverview The storefront surface: catalog, cart, checkout, orders.
 *
 * @remarks Sequences, never decides — the same rule as {@link GatewayService}. Each method
 * hands one (or, for checkout preview, two) peer calls their answers; a pricing rule or a
 * stock rule written here would be a rule only the edge enforces.
 *
 * @remarks Cart and order identity always comes from the principal, never from a body field.
 * A body that could choose `userId` would be a second authority next to the JWT, and the one
 * a client forgets to spoof is the one that gets believed.
 */
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  BILLING_CLIENT,
  CART_CLIENT,
  CATALOG_CLIENT,
  ORDER_CLIENT,
  type BillingClientPort,
  type CartClientPort,
  type CartIdentityInput,
  type CatalogClientPort,
  type GatewayCartView,
  type GatewayCatalogProduct,
  type GatewayCheckoutLines,
  type GatewayCheckoutValidation,
  type GatewayInvoiceView,
  type GatewayOrderView,
  type OrderClientPort,
  type ShopMoney,
} from '../ports/peer-clients.port';
import { cartIdentityFrom } from '../cart-identity';
import type { GatewayPrincipal } from '../ports/gateway-principal';

export interface CatalogListInput {
  readonly categoryPath: readonly string[];
  readonly page: number;
  readonly pageSize: number;
}

export interface CatalogSearchInput {
  readonly text: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface CheckoutPreviewInput {
  readonly customerCountry?: string;
  readonly couponCode?: string;
  readonly currency?: string;
}

export interface CheckoutCreateInput {
  /** The jurisdiction the preview was priced at; the charge must reconcile against it. */
  readonly customerCountry?: string;
  /** The coupon the preview discounted with; passed through so the two cannot diverge. */
  readonly couponCode?: string;
  readonly currency?: string;
  readonly paymentMethodToken?: string;
  /** From the `Idempotency-Key` header; generated when the client did not send one. */
  readonly idempotencyKey?: string;
}

export interface CheckoutPreviewResult {
  readonly lines: GatewayCheckoutLines;
  readonly validation: GatewayCheckoutValidation;
  readonly invoice: GatewayInvoiceView;
}

@Injectable()
export class StorefrontService {
  constructor(
    @Inject(CATALOG_CLIENT) private readonly catalog: CatalogClientPort,
    @Inject(CART_CLIENT) private readonly cart: CartClientPort,
    @Inject(ORDER_CLIENT) private readonly orders: OrderClientPort,
    @Inject(BILLING_CLIENT) private readonly billing: BillingClientPort,
  ) {}

  // ---- catalog ----------------------------------------------------------------------

  listProducts(input: CatalogListInput): Promise<{
    products: readonly GatewayCatalogProduct[];
    total: number;
  }> {
    return this.catalog.listByCategory(input);
  }

  /** The storefront's text search: products the catalog engine matched, relevance ordered. */
  searchProducts(input: CatalogSearchInput): Promise<{
    products: readonly GatewayCatalogProduct[];
    total: number;
  }> {
    return this.catalog.searchByText(input);
  }

  getProduct(id: string): Promise<GatewayCatalogProduct> {
    return this.catalog.getProduct(id);
  }

  createProduct(input: {
    name: string;
    description: string;
    categoryPath: readonly string[];
    variants: readonly {
      sku: string;
      price: ShopMoney;
      attrs?: Record<string, string>;
    }[];
    mediaKeys?: readonly string[];
  }): Promise<GatewayCatalogProduct> {
    return this.catalog.createProduct(input);
  }

  setVariantPrice(input: {
    productId: string;
    sku: string;
    price: ShopMoney;
  }): Promise<GatewayCatalogProduct> {
    return this.catalog.setVariantPrice(input);
  }

  // ---- cart --------------------------------------------------------------------------

  getCart(principal: GatewayPrincipal): Promise<GatewayCartView> {
    return this.cart.getCart(cartIdentityFrom(principal));
  }

  addItem(
    principal: GatewayPrincipal,
    input: { sku: string; quantity: number },
  ): Promise<GatewayCartView> {
    return this.cart.addItem(cartIdentityFrom(principal), input);
  }

  updateItem(
    principal: GatewayPrincipal,
    input: { sku: string; quantity: number },
  ): Promise<GatewayCartView> {
    return this.cart.updateItemQty(cartIdentityFrom(principal), input);
  }

  removeItem(
    principal: GatewayPrincipal,
    input: { sku: string },
  ): Promise<GatewayCartView> {
    return this.cart.removeItem(cartIdentityFrom(principal), input);
  }

  clearCart(principal: GatewayPrincipal): Promise<GatewayCartView> {
    return this.cart.clearCart(cartIdentityFrom(principal));
  }

  /**
   * Folds the guest basket this browser presented while anonymous into the caller's cart.
   *
   * @remarks Called once, right after sign-in — the one moment both identities exist at
   * once: the account being signed into and the guest id the browser still holds. The
   * guest id comes from a header rather than a body for the same reason cart identity
   * does: it is transport metadata, and a body field that could name a cart is a second
   * authority next to the bearer.
   */
  mergeGuestCart(principal: GatewayPrincipal, guestSessionId: string): Promise<{ merged: boolean }> {
    return this.cart.mergeGuestCart(cartIdentityFrom(principal), guestSessionId);
  }

  // ---- checkout ----------------------------------------------------------------------

  /**
   * Cart lines + validation, then billing's totals over those lines.
   *
   * @remarks Two calls on purpose: the cart owns "what is in the basket and is it still
   * buyable", billing owns "what does that cost with tax and a coupon". Composing them here
   * is the one place the edge has to sequence, because no single service answers both —
   * and `POST /checkout` itself is a single `CreateOrder` whose saga does the rest.
   */
  async previewCheckout(
    principal: GatewayPrincipal,
    input: CheckoutPreviewInput = {},
  ): Promise<CheckoutPreviewResult> {
    const identity = cartIdentityFrom(principal);
    const [lines, validation] = await Promise.all([
      this.cart.getCheckoutLines(identity),
      this.cart.validateForCheckout(identity),
    ]);

    const invoice = await this.billing.previewTotals({
      customerCountry: input.customerCountry ?? '',
      couponCode: input.couponCode ?? '',
      lines: lines.lines.map((line) => ({
        sku: line.sku,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
      })),
      currency: input.currency ?? lines.currency,
    });

    return { lines, validation, invoice };
  }

  /**
   * Creates the order, forwarding the pricing terms the preview was quoted with.
   *
   * @remarks Jurisdiction and coupon are not this edge's to re-derive: billing prices
   * the charge inside the saga, and only the customer's own inputs keep that figure
   * equal to the one displayed one screen ago.
   */
  createCheckout(
    principal: GatewayPrincipal,
    input: CheckoutCreateInput = {},
  ): Promise<GatewayOrderView> {
    return this.orders.createOrder({
      userId: principal.userId,
      sessionId: principal.sessionId,
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
      customerCountry: input.customerCountry ?? '',
      couponCode: input.couponCode ?? '',
      currency: input.currency ?? 'USD',
      paymentMethodToken: input.paymentMethodToken,
    });
  }

  // ---- webhooks --------------------------------------------------------------------

  /**
   * Forwards one provider webhook to billing.
   *
   * @remarks No principal and no session: the signature is the credential, and billing
   * verifies it. The edge's only job is to hand over the exact bytes it received.
   */
  handlePaymentWebhook(input: {
    rawBody: string;
    signature: string;
  }): Promise<{ outcome: string; paymentId: string; status: string }> {
    return this.billing.handlePaymentWebhook(input);
  }

  // ---- orders ------------------------------------------------------------------------

  listOrders(
    principal: GatewayPrincipal,
    input: { page: number; pageSize: number },
  ): Promise<{ orders: readonly GatewayOrderView[]; total: number }> {
    return this.orders.listUserOrders({
      userId: principal.userId,
      page: input.page,
      pageSize: input.pageSize,
    });
  }

  getOrder(principal: GatewayPrincipal, orderId: string): Promise<GatewayOrderView> {
    return this.orders.getOrder({ orderId, userId: principal.userId });
  }

  cancelOrder(
    principal: GatewayPrincipal,
    input: { orderId: string; reason: string },
  ): Promise<GatewayOrderView> {
    return this.orders.cancelOrder({
      orderId: input.orderId,
      userId: principal.userId,
      reason: input.reason,
    });
  }
}

