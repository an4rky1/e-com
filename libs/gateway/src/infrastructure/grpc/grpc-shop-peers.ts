/**
 * @fileoverview The four shop peers, over one channel.
 *
 * @remarks Each adapter takes a {@link PeerCaller} rather than a `GrpcChannel`, so no adapter
 * can forget the deadline or the error translation — both live one call away and are applied
 * by construction. They are also among the only files in `libs/gateway` that name a gRPC
 * method path, which is what makes a renamed proto method a compile error rather than a
 * runtime "method is absent from the loaded proto definition" that only appears in production.
 *
 * @remarks Every request shape is spelled out rather than reused from a domain library. The
 * gateway cannot import `libs/domains/*` — that is the point of it — so these mirror
 * `libs/contracts/proto` one-to-one, exactly as `libs/contracts/src/grpc/service-contracts.ts`
 * does for the rest of the platform.
 */
import { Injectable } from '@nestjs/common';
// Value import on purpose. Each adapter is registered with `useClass`, so Nest resolves it
// through `design:paramtypes` — which reads the *value* binding. `import type` would emit
// `Object` and the container would fail on the first of these.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PeerCaller } from './peer-caller';
import { METHOD } from './grpc-methods';
import type {
  BillingClientPort,
  CartClientPort,
  CatalogClientPort,
  OrderClientPort,
  ShopMoney,
} from '../../application/ports/peer-clients.port';

/**
 * Shop money arrives as proto strings; the edge keeps them that way.
 *
 * @remarks No parse-to-number: a minor-unit amount that crossed as a JS number would be a
 * precision bug waiting for a large cart. The front already treats `amountMinor` as a string.
 */
type WireMoney = { amountMinor?: string; currency?: string } | undefined | null;

const toShopMoney = (wire: WireMoney): ShopMoney => ({
  amountMinor: wire?.amountMinor ?? '0',
  currency: wire?.currency ?? '',
});

type WireProduct = {
  id?: string;
  name?: string;
  description?: string;
  categoryPath?: string[];
  variants?: {
    sku?: string;
    price?: WireMoney;
    attrs?: Record<string, string>;
    active?: boolean;
  }[];
  mediaKeys?: string[];
  active?: boolean;
  version?: number;
  priceRangeMin?: WireMoney;
  priceRangeMax?: WireMoney;
};

const toProduct = (wire: WireProduct) => ({
  id: wire.id ?? '',
  name: wire.name ?? '',
  description: wire.description ?? '',
  categoryPath: wire.categoryPath ?? [],
  variants: (wire.variants ?? []).map((variant) => ({
    sku: variant.sku ?? '',
    price: toShopMoney(variant.price),
    attrs: variant.attrs,
    active: variant.active ?? false,
  })),
  mediaKeys: wire.mediaKeys ?? [],
  active: wire.active ?? false,
  version: wire.version ?? 0,
  priceRangeMin: wire.priceRangeMin ? toShopMoney(wire.priceRangeMin) : undefined,
  priceRangeMax: wire.priceRangeMax ? toShopMoney(wire.priceRangeMax) : undefined,
});

type WireCartItem = {
  sku?: string;
  productId?: string;
  name?: string;
  quantity?: number;
  unitPrice?: WireMoney;
  totalPrice?: WireMoney;
  addedAt?: string;
  updatedAt?: string;
  priceChanged?: boolean;
};

type WireCart = {
  sessionId?: string;
  userId?: string;
  items?: WireCartItem[];
  status?: string;
  itemCount?: number;
  subtotal?: WireMoney;
  total?: WireMoney;
  currency?: string;
  expiresAt?: string;
  version?: number;
};

const toCartView = (wire: WireCart) => ({
  sessionId: wire.sessionId ?? '',
  userId: wire.userId ?? '',
  items: (wire.items ?? []).map((item) => ({
    sku: item.sku ?? '',
    productId: item.productId ?? '',
    name: item.name ?? '',
    quantity: item.quantity ?? 0,
    unitPrice: toShopMoney(item.unitPrice),
    totalPrice: toShopMoney(item.totalPrice),
    addedAt: item.addedAt ?? '',
    updatedAt: item.updatedAt ?? '',
    priceChanged: item.priceChanged ?? false,
  })),
  status: wire.status ?? '',
  itemCount: wire.itemCount ?? 0,
  subtotal: toShopMoney(wire.subtotal),
  total: toShopMoney(wire.total),
  currency: wire.currency ?? '',
  expiresAt: wire.expiresAt ?? '',
  version: wire.version ?? 0,
});

type WireOrder = {
  id?: string;
  userId?: string;
  status?: string;
  lines?: {
    sku?: string;
    productId?: string;
    name?: string;
    quantity?: number;
    unitPrice?: WireMoney;
    totalPrice?: WireMoney;
  }[];
  subtotal?: WireMoney;
  total?: WireMoney;
  currency?: string;
  paymentId?: string;
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  cancelReason?: string;
};

const toOrderView = (wire: WireOrder) => ({
  id: wire.id ?? '',
  userId: wire.userId ?? '',
  status: wire.status ?? '',
  lines: (wire.lines ?? []).map((line) => ({
    sku: line.sku ?? '',
    productId: line.productId ?? '',
    name: line.name ?? '',
    quantity: line.quantity ?? 0,
    unitPrice: toShopMoney(line.unitPrice),
    totalPrice: toShopMoney(line.totalPrice),
  })),
  subtotal: toShopMoney(wire.subtotal),
  total: toShopMoney(wire.total),
  currency: wire.currency ?? '',
  paymentId: wire.paymentId ?? '',
  createdAt: wire.createdAt ?? '',
  updatedAt: wire.updatedAt ?? '',
  version: wire.version ?? 0,
  cancelReason: wire.cancelReason ?? '',
});

type WireInvoice = {
  invoiceId?: string;
  orderId?: string;
  status?: string;
  lines?: {
    sku?: string;
    quantity?: number;
    unitPrice?: WireMoney;
    lineSubtotal?: WireMoney;
    tax?: WireMoney;
  }[];
  subtotal?: WireMoney;
  discount?: WireMoney;
  taxTotal?: WireMoney;
  shipping?: WireMoney;
  total?: WireMoney;
  currency?: string;
  couponCode?: string;
  issuedAt?: string;
};

const toInvoice = (wire: WireInvoice) => ({
  invoiceId: wire.invoiceId ?? '',
  orderId: wire.orderId ?? '',
  status: wire.status ?? '',
  lines: (wire.lines ?? []).map((line) => ({
    sku: line.sku ?? '',
    quantity: line.quantity ?? 0,
    unitPrice: toShopMoney(line.unitPrice),
    lineSubtotal: toShopMoney(line.lineSubtotal),
    tax: toShopMoney(line.tax),
  })),
  subtotal: toShopMoney(wire.subtotal),
  discount: toShopMoney(wire.discount),
  taxTotal: toShopMoney(wire.taxTotal),
  shipping: toShopMoney(wire.shipping),
  total: toShopMoney(wire.total),
  currency: wire.currency ?? '',
  couponCode: wire.couponCode ?? '',
  issuedAt: wire.issuedAt ?? '',
});

/** Cart identity fields every cart RPC carries, taken from the JWT at the edge. */
const identityOf = (identity: { userId: string; sessionId: string }) => ({
  userId: identity.userId,
  sessionId: identity.sessionId,
});

@Injectable()
export class GrpcCatalogClient implements CatalogClientPort {
  constructor(private readonly peers: PeerCaller) {}

  async listByCategory(input: {
    categoryPath: readonly string[];
    page: number;
    pageSize: number;
  }): Promise<{ products: readonly ReturnType<typeof toProduct>[]; total: number }> {
    const response = await this.peers.call<{
      products?: WireProduct[];
      total?: number;
    }>(METHOD.LIST_PRODUCTS, {
      categoryPath: [...input.categoryPath],
      page: input.page,
      pageSize: input.pageSize,
    });
    return {
      products: (response.products ?? []).map(toProduct),
      total: response.total ?? 0,
    };
  }

  async getProduct(id: string): Promise<ReturnType<typeof toProduct>> {
    return toProduct(await this.peers.call<WireProduct>(METHOD.GET_PRODUCT, { id }));
  }

  async createProduct(input: {
    name: string;
    description: string;
    categoryPath: readonly string[];
    variants: readonly {
      sku: string;
      price: ShopMoney;
      attrs?: Record<string, string>;
    }[];
    mediaKeys?: readonly string[];
  }): Promise<ReturnType<typeof toProduct>> {
    return toProduct(
      await this.peers.call<WireProduct>(METHOD.CREATE_PRODUCT, {
        name: input.name,
        description: input.description,
        categoryPath: [...input.categoryPath],
        variants: input.variants.map((variant) => ({
          sku: variant.sku,
          price: { amountMinor: variant.price.amountMinor, currency: variant.price.currency },
          attrs: variant.attrs ?? {},
        })),
        mediaKeys: [...(input.mediaKeys ?? [])],
      }),
    );
  }

  async setVariantPrice(input: {
    productId: string;
    sku: string;
    price: ShopMoney;
  }): Promise<ReturnType<typeof toProduct>> {
    return toProduct(
      await this.peers.call<WireProduct>(METHOD.SET_VARIANT_PRICE, {
        productId: input.productId,
        sku: input.sku,
        price: { amountMinor: input.price.amountMinor, currency: input.price.currency },
      }),
    );
  }
}

@Injectable()
export class GrpcCartClient implements CartClientPort {
  constructor(private readonly peers: PeerCaller) {}

  async getCart(identity: { userId: string; sessionId: string }) {
    return toCartView(
      await this.peers.call<WireCart>(METHOD.CART_GET, identityOf(identity)),
    );
  }

  async addItem(
    identity: { userId: string; sessionId: string },
    input: { sku: string; quantity: number },
  ) {
    return toCartView(
      await this.peers.call<WireCart>(METHOD.CART_ADD_ITEM, {
        ...identityOf(identity),
        sku: input.sku,
        quantity: input.quantity,
      }),
    );
  }

  async updateItemQty(
    identity: { userId: string; sessionId: string },
    input: { sku: string; quantity: number },
  ) {
    return toCartView(
      await this.peers.call<WireCart>(METHOD.CART_UPDATE_QTY, {
        ...identityOf(identity),
        sku: input.sku,
        quantity: input.quantity,
      }),
    );
  }

  async removeItem(
    identity: { userId: string; sessionId: string },
    input: { sku: string },
  ) {
    return toCartView(
      await this.peers.call<WireCart>(METHOD.CART_REMOVE_ITEM, {
        ...identityOf(identity),
        sku: input.sku,
      }),
    );
  }

  async clearCart(identity: { userId: string; sessionId: string }) {
    return toCartView(
      await this.peers.call<WireCart>(METHOD.CART_CLEAR, identityOf(identity)),
    );
  }

  async getCheckoutLines(identity: { userId: string; sessionId: string }) {
    const response = await this.peers.call<{
      lines?: {
        sku?: string;
        productId?: string;
        name?: string;
        quantity?: number;
        unitPrice?: WireMoney;
      }[];
      subtotal?: WireMoney;
      currency?: string;
      version?: number;
    }>(METHOD.CART_CHECKOUT_LINES, identityOf(identity));

    return {
      lines: (response.lines ?? []).map((line) => ({
        sku: line.sku ?? '',
        productId: line.productId ?? '',
        name: line.name ?? '',
        quantity: line.quantity ?? 0,
        unitPrice: toShopMoney(line.unitPrice),
      })),
      subtotal: toShopMoney(response.subtotal),
      currency: response.currency ?? '',
      version: response.version ?? 0,
    };
  }

  async validateForCheckout(identity: { userId: string; sessionId: string }) {
    const response = await this.peers.call<{
      valid?: boolean;
      unavailableSkus?: string[];
      priceChanges?: {
        sku?: string;
        oldPrice?: WireMoney;
        newPrice?: WireMoney;
      }[];
    }>(METHOD.CART_VALIDATE, identityOf(identity));

    return {
      valid: response.valid ?? false,
      unavailableSkus: response.unavailableSkus ?? [],
      priceChanges: (response.priceChanges ?? []).map((change) => ({
        sku: change.sku ?? '',
        oldPrice: toShopMoney(change.oldPrice),
        newPrice: toShopMoney(change.newPrice),
      })),
    };
  }
}

@Injectable()
export class GrpcOrderClient implements OrderClientPort {
  constructor(private readonly peers: PeerCaller) {}

  async createOrder(input: {
    userId: string;
    sessionId: string;
    idempotencyKey: string;
    customerCountry: string;
    couponCode: string;
    currency: string;
    paymentMethodToken?: string;
  }) {
    return toOrderView(
      await this.peers.call<WireOrder>(METHOD.ORDER_CREATE, {
        userId: input.userId,
        sessionId: input.sessionId,
        idempotencyKey: input.idempotencyKey,
        customerCountry: input.customerCountry,
        couponCode: input.couponCode,
        currency: input.currency,
        paymentMethodToken: input.paymentMethodToken ?? '',
      }),
    );
  }

  async getOrder(input: { orderId: string; userId: string }) {
    return toOrderView(await this.peers.call<WireOrder>(METHOD.ORDER_GET, input));
  }

  async listUserOrders(input: { userId: string; page: number; pageSize: number }) {
    const response = await this.peers.call<{
      orders?: WireOrder[];
      total?: number;
    }>(METHOD.ORDER_LIST, input);
    return {
      orders: (response.orders ?? []).map(toOrderView),
      total: response.total ?? 0,
    };
  }

  async cancelOrder(input: { orderId: string; userId: string; reason: string }) {
    return toOrderView(await this.peers.call<WireOrder>(METHOD.ORDER_CANCEL, input));
  }
}

@Injectable()
export class GrpcBillingClient implements BillingClientPort {
  constructor(private readonly peers: PeerCaller) {}

  async previewTotals(input: {
    customerCountry: string;
    couponCode: string;
    lines: readonly { sku: string; quantity: number; unitPrice: ShopMoney }[];
    currency: string;
  }) {
    const response = await this.peers.call<{ invoice?: WireInvoice }>(
      METHOD.BILLING_PREVIEW,
      {
        customerCountry: input.customerCountry,
        couponCode: input.couponCode,
        lines: input.lines.map((line) => ({
          sku: line.sku,
          quantity: line.quantity,
          unitPrice: {
            amountMinor: line.unitPrice.amountMinor,
            currency: line.unitPrice.currency,
          },
        })),
        currency: input.currency,
      },
    );
    return toInvoice(response.invoice ?? {});
  }

  async handlePaymentWebhook(input: { rawBody: string; signature: string }) {
    return this.peers.call<{ outcome: string; paymentId: string; status: string }>(
      METHOD.BILLING_HANDLE_WEBHOOK,
      {
        rawBody: input.rawBody,
        signature: input.signature,
      },
    );
  }
}
