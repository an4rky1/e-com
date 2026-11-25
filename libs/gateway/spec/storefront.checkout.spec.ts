/**
 * @fileoverview Checkout pass-through, as a use case rather than as HTTP.
 *
 * @remarks What is under test is forwarding: the jurisdiction and coupon the shopper sent
 * are the ones the peers receive, because a preview priced at `DE/SAVE10` and a charge
 * issued under `''` is a silent mispricing no reconciliation can catch after the fact.
 * The peers are in-memory doubles, so a passing assertion is about this edge's delegation
 * and not about a peer being up.
 */
import { StorefrontService } from '../src/application/facade/storefront.service';
import { CheckoutController } from '../src/presentation/checkout.controller';
import { CheckoutCreateDto, CheckoutPreviewDto } from '../src/presentation/dto/storefront.dto';
import type {
  BillingClientPort,
  CartClientPort,
  CatalogClientPort,
  GatewayCheckoutLines,
  GatewayCheckoutValidation,
  GatewayInvoiceView,
  GatewayOrderView,
  OrderClientPort,
} from '../src/application/ports/peer-clients.port';
import { SESSION_ID, USER_ID, principalOf } from './testing/peer-doubles';

const money = (amountMinor: string) => ({ amountMinor, currency: 'USD' });

const LINES: GatewayCheckoutLines = {
  lines: [
    { sku: 'widget', productId: 'p-1', name: 'Widget', quantity: 2, unitPrice: money('500') },
  ],
  subtotal: money('1000'),
  currency: 'USD',
  version: 3,
};

const VALIDATION: GatewayCheckoutValidation = {
  valid: true,
  unavailableSkus: [],
  priceChanges: [],
};

const INVOICE: GatewayInvoiceView = {
  invoiceId: 'inv-1',
  orderId: 'ord-1',
  status: 'preview',
  lines: [],
  subtotal: money('1000'),
  discount: money('0'),
  taxTotal: money('100'),
  shipping: money('500'),
  total: money('1600'),
  currency: 'USD',
  couponCode: '',
  issuedAt: '2026-11-14T00:00:00.000Z',
};

const ORDER: GatewayOrderView = {
  id: 'ord-1',
  userId: USER_ID,
  status: 'paid',
  lines: [],
  subtotal: money('1000'),
  total: money('1600'),
  currency: 'USD',
  paymentId: 'pay-1',
  createdAt: '2026-11-14T00:00:00.000Z',
  updatedAt: '2026-11-14T00:00:00.000Z',
  version: 1,
  cancelReason: '',
};

class RecordingBilling implements BillingClientPort {
  readonly previews: Parameters<BillingClientPort['previewTotals']>[0][] = [];

  async previewTotals(
    input: Parameters<BillingClientPort['previewTotals']>[0],
  ): Promise<GatewayInvoiceView> {
    this.previews.push(input);
    return INVOICE;
  }

  async handlePaymentWebhook(): Promise<never> {
    throw new Error('not under test');
  }
}

class RecordingOrders implements OrderClientPort {
  readonly created: Parameters<OrderClientPort['createOrder']>[0][] = [];

  async createOrder(input: Parameters<OrderClientPort['createOrder']>[0]): Promise<GatewayOrderView> {
    this.created.push(input);
    return ORDER;
  }

  async getOrder(): Promise<never> {
    throw new Error('not under test');
  }

  async listUserOrders(): Promise<never> {
    throw new Error('not under test');
  }

  async cancelOrder(): Promise<never> {
    throw new Error('not under test');
  }
}

class LinesCart implements CartClientPort {
  async getCheckoutLines(): Promise<GatewayCheckoutLines> {
    return LINES;
  }

  async validateForCheckout(): Promise<GatewayCheckoutValidation> {
    return VALIDATION;
  }

  async getCart(): Promise<never> {
    throw new Error('not under test');
  }

  async addItem(): Promise<never> {
    throw new Error('not under test');
  }

  async updateItemQty(): Promise<never> {
    throw new Error('not under test');
  }

  async removeItem(): Promise<never> {
    throw new Error('not under test');
  }

  async clearCart(): Promise<never> {
    throw new Error('not under test');
  }

  async mergeGuestCart(): Promise<never> {
    throw new Error('not under test');
  }
}

const CATALOG_STUB = {
  listByCategory: () => {
    throw new Error('not under test');
  },
  getProduct: () => {
    throw new Error('not under test');
  },
  createProduct: () => {
    throw new Error('not under test');
  },
  setVariantPrice: () => {
    throw new Error('not under test');
  },
} as unknown as CatalogClientPort;

const storefrontWith = (ports: {
  billing?: RecordingBilling;
  orders?: RecordingOrders;
} = {}) => {
  const billing = ports.billing ?? new RecordingBilling();
  const orders = ports.orders ?? new RecordingOrders();
  const service = new StorefrontService(
    CATALOG_STUB,
    new LinesCart(),
    orders,
    billing,
  );
  return { service, billing, orders };
};

describe('StorefrontService — checkout pricing terms', () => {
  it('prices the preview under the jurisdiction and coupon the client sent', async () => {
    const { service, billing } = storefrontWith();

    await service.previewCheckout(principalOf(), {
      customerCountry: 'DE',
      couponCode: 'SAVE10',
      currency: 'EUR',
    });

    expect(billing.previews[0]).toMatchObject({
      customerCountry: 'DE',
      couponCode: 'SAVE10',
      currency: 'EUR',
    });
  });

  it('defaults absent terms the way the order side will, not to a price of its own', async () => {
    const { service, billing } = storefrontWith();

    await service.previewCheckout(principalOf());

    expect(billing.previews[0]).toMatchObject({
      customerCountry: '',
      couponCode: '',
      currency: 'USD',
    });
  });

  it('forwards the pricing terms and the client idempotency key with the create', async () => {
    const { service, orders } = storefrontWith();

    await service.createCheckout(principalOf(), {
      customerCountry: 'DE',
      couponCode: 'SAVE10',
      currency: 'EUR',
      idempotencyKey: 'key-1',
    });

    expect(orders.created[0]).toMatchObject({
      userId: USER_ID,
      sessionId: SESSION_ID,
      idempotencyKey: 'key-1',
      customerCountry: 'DE',
      couponCode: 'SAVE10',
      currency: 'EUR',
    });
  });

  it('generates a key when the client sent none, and still defaults the terms', async () => {
    const { service, orders } = storefrontWith();

    await service.createCheckout(principalOf());

    const sent = orders.created[0];
    expect(sent.idempotencyKey).toEqual(expect.any(String));
    expect(sent.idempotencyKey).not.toHaveLength(0);
    expect(sent).toMatchObject({ customerCountry: '', couponCode: '' });
  });
});

describe('CheckoutController — body to facade', () => {
  it('carries the create body and the header key to the facade untouched', async () => {
    const { orders } = storefrontWith();
    const controller = new CheckoutController(storefrontWith({ orders }).service);

    const body = new CheckoutCreateDto();
    body.customerCountry = 'DE';
    body.couponCode = 'SAVE10';
    body.currency = 'EUR';
    body.paymentMethodToken = 'pm_card_visa';

    await controller.create(principalOf(), body, 'header-key');

    expect(orders.created[0]).toMatchObject({
      customerCountry: 'DE',
      couponCode: 'SAVE10',
      currency: 'EUR',
      paymentMethodToken: 'pm_card_visa',
      idempotencyKey: 'header-key',
    });
  });

  it('carries the preview body to the facade untouched', async () => {
    const { billing } = storefrontWith();
    const controller = new CheckoutController(storefrontWith({ billing }).service);

    const body = new CheckoutPreviewDto();
    body.customerCountry = 'FR';
    body.couponCode = 'SAVE10';
    body.currency = 'EUR';

    await controller.preview(principalOf(), body);

    expect(billing.previews[0]).toMatchObject({
      customerCountry: 'FR',
      couponCode: 'SAVE10',
      currency: 'EUR',
    });
  });

  it('keeps the principal on the wire, never a body field', async () => {
    const { orders } = storefrontWith();
    const controller = new CheckoutController(storefrontWith({ orders }).service);

    await controller.create(principalOf({ userId: 'someone-else' }), new CheckoutCreateDto());

    expect(orders.created[0].userId).toBe('someone-else');
    expect(orders.created[0].userId).not.toBe(USER_ID);
  });
});
