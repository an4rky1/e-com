/**
 * The gRPC surface, and the CQRS wiring underneath it.
 *
 * @remarks Two things are asserted here that no other suite in this service can see. The
 * first is the translation at the boundary: money crosses this wire as a *string* and must
 * arrive at the domain as an integer of minor units — parsed on the way in, formatted on
 * the way out — so a figure that never became a number, a line error that lost its index,
 * or a proto3 default that reached a handler as `undefined` instead of `''` are bugs only
 * this suite can catch. The second is that every handler is registered against a *class*:
 * `CommandBus.execute` resolves a handler from `command.constructor`, so a string key or a
 * plain object literal cannot dispatch at all — and that failure mode is an import-time
 * throw in some versions and a silent no-op in others.
 *
 * @remarks The facade and the handlers are real; only the two buses are doubled, by a
 * `DispatchBus` that resolves `command.constructor` exactly the way Nest does. The
 * repository is the in-memory double and the provider is the real fake adapter, so a
 * charge through this suite moves money exactly as far as production would.
 */
import 'reflect-metadata';
import { COMMAND_HANDLER_METADATA, QUERY_HANDLER_METADATA } from '@nestjs/cqrs/dist/decorators/constants';
import type {
  ChargeOrderRequest,
  ChargeOrderResponse,
  InvoiceView,
  PreviewTotalsRequest,
  RefundOrderRequest,
  RefundOrderResponse,
  ShopMoney,
} from '@auth/contracts';
import { ResourceNotFoundException, ValidationException } from '@auth/platform/error-handling';
import { BillingGrpcController } from '../src/presentation/grpc/billing.grpc.controller';
import { BillingService } from '../src/application/facade/billing.service';
import { ChargeOrderCommand, RefundOrderCommand } from '../src/application/commands/billing.commands';
import { ChargeOrderHandler } from '../src/application/commands/charge-order.handler';
import { RefundOrderHandler } from '../src/application/commands/refund-order.handler';
import {
  GetInvoiceHandler,
  GetInvoiceQuery,
  PreviewTotalsHandler,
  PreviewTotalsQuery,
} from '../src/application/queries/billing.queries';
import { Invoice } from '../src/domain/invoice.entity';
import { FakePaymentProvider } from '../src/infrastructure/payment/fake-payment.provider';
import {
  InMemoryBillingRepository,
  ORDER_ID,
  OTHER_ORDER_ID,
  testBillingConfig,
} from './support/fakes';

/** 2 × 10.00: at the default 0% jurisdiction that is exactly 2000 to pay. */
const TOTAL_US = 2_000;
/** The same lines under German VAT: 2000 + 19% = 2380. */
const TOTAL_DE = 2_380;

const money = (amountMinor: string, currency = 'EUR'): ShopMoney => ({ amountMinor, currency });

/** Dispatches by `command.constructor`, exactly the way `CommandBus` resolves a handler. */
class DispatchBus {
  constructor(private readonly handlers: Map<object, (input: object) => Promise<unknown>>) {}

  execute(command: object): Promise<unknown> {
    const handler = this.handlers.get(command.constructor);
    if (!handler) throw new Error(`no handler registered for ${command.constructor.name}`);
    return handler(command);
  }
}

function build() {
  const repository = new InMemoryBillingRepository();
  const provider = new FakePaymentProvider();
  const config = testBillingConfig();

  const commandHandlers = new Map<object, (command: object) => Promise<unknown>>(
    [
      [ChargeOrderCommand, new ChargeOrderHandler(repository, provider, config)],
      [RefundOrderCommand, new RefundOrderHandler(repository, provider)],
    ].map(([command, handler]) => [
      command,
      (input: object) =>
        (handler as { execute: (command: object) => Promise<unknown> }).execute(input),
    ]) as [object, (command: object) => Promise<unknown>][],
  );

  const queryHandlers = new Map<object, (query: object) => Promise<unknown>>(
    [
      [GetInvoiceQuery, new GetInvoiceHandler(repository)],
      [PreviewTotalsQuery, new PreviewTotalsHandler(repository, config)],
    ].map(([query, handler]) => [
      query,
      (input: object) => (handler as { execute: (query: object) => Promise<unknown> }).execute(input),
    ]) as [object, (query: object) => Promise<unknown>][],
  );

  // One narrowing cast, at the boundary where the fake takes the place of Nest's bus. The
  // facade itself is real, so the test exercises the handlers it really calls.
  const facade = new BillingService(
    new DispatchBus(commandHandlers) as unknown as never,
    new DispatchBus(queryHandlers) as unknown as never,
  );

  return { controller: new BillingGrpcController(facade), repository, provider, config };
}

const chargeRequest = (overrides: Partial<ChargeOrderRequest> = {}): ChargeOrderRequest => ({
  orderId: ORDER_ID,
  idempotencyKey: `order:${ORDER_ID}:charge:1`,
  amount: money('2000'),
  paymentMethodToken: 'pm_card_visa',
  customerId: 'customer-1',
  lines: [{ sku: 'SKU-1', quantity: 2, unitPrice: money('1000') }],
  customerCountry: '',
  ...overrides,
});

const refundRequest = (
  paymentId: string,
  overrides: Partial<RefundOrderRequest> = {},
): RefundOrderRequest => ({
  orderId: ORDER_ID,
  paymentId,
  reason: 'customer cancelled',
  idempotencyKey: `order:${ORDER_ID}:refund:1`,
  ...overrides,
});

const previewRequest = (overrides: Partial<PreviewTotalsRequest> = {}): PreviewTotalsRequest => ({
  customerCountry: '',
  couponCode: '',
  lines: [{ sku: 'SKU-1', quantity: 2, unitPrice: money('1000') }],
  currency: 'EUR',
  ...overrides,
});

/** Charges once through the public path, so a refund test starts from a settled payment. */
const seedCharge = async (
  controller: BillingGrpcController,
  overrides: Partial<ChargeOrderRequest> = {},
): Promise<{ paymentId: string }> => {
  const response = await controller.chargeOrder(chargeRequest(overrides));
  return { paymentId: response.paymentId };
};

describe('BillingService dispatch', () => {
  it('routes every command to a handler registered against its class', async () => {
    // If any of these were registered against a string, `command.constructor` would resolve to
    // `Object` and the bus would find nothing — which is exactly the failure mode the class
    // requirement exists to prevent.
    const { controller, repository } = build();

    const response = await controller.chargeOrder(chargeRequest());

    expect(response.status).toBe('succeeded');
    expect(repository.payments.size).toBe(1);
  });

  it('registers each handler under the exact class it handles', () => {
    // `@CommandHandler(cls)` stores the class on the handler itself; reading it back is the
    // only way to prove the decorator was given the class and not a string. A string key
    // throws at import, so reaching this line at all is half the assertion.
    for (const [handler, command] of [
      [ChargeOrderHandler, ChargeOrderCommand],
      [RefundOrderHandler, RefundOrderCommand],
    ] as const) {
      expect(Reflect.getMetadata(COMMAND_HANDLER_METADATA, handler)).toBe(command);
    }

    for (const [handler, query] of [
      [GetInvoiceHandler, GetInvoiceQuery],
      [PreviewTotalsHandler, PreviewTotalsQuery],
    ] as const) {
      expect(Reflect.getMetadata(QUERY_HANDLER_METADATA, handler)).toBe(query);
    }
  });
});

describe('BillingGrpcController.ChargeOrder', () => {
  it('parses wire money into minor units before the handler sees it', async () => {
    const { controller, provider, repository } = build();

    const response = await controller.chargeOrder(chargeRequest());

    expect(response.status).toBe('succeeded');
    // The provider's contract is integers: a `"2000"` that stayed a string would multiply
    // against a numeric quantity as `"2000" * 2` in some paths and `NaN` in others.
    expect(provider.charges[0]).toMatchObject({ amountMinor: TOTAL_US, currency: 'EUR' });
    expect(repository.invoices.get(ORDER_ID)).toMatchObject({
      status: 'paid',
      subtotalMinor: TOTAL_US,
      totalMinor: TOTAL_US,
    });
  });

  it('answers a retry with the same payment without charging twice', async () => {
    // The proto's core promise: the idempotency key must reach the handler intact, or a
    // retried checkout takes the money again.
    const { controller, provider } = build();
    const first = await controller.chargeOrder(chargeRequest());

    const again = await controller.chargeOrder(chargeRequest());

    expect(again.paymentId).toBe(first.paymentId);
    expect(provider.charges).toHaveLength(1);
  });

  it('carries the amount mismatch the handler refuses, not a charge', async () => {
    const { controller, provider, repository } = build();

    await expect(controller.chargeOrder(chargeRequest({ amount: money('1999') }))).rejects.toThrow(
      /charge amount does not match lines/,
    );
    expect(provider.charges).toHaveLength(0);
    expect(repository.commits).toBe(0);
  });

  it('rejects a malformed amount with the field named', async () => {
    const { controller, provider } = build();

    await expect(
      controller.chargeOrder(chargeRequest({ amount: money('10.50') })),
    ).rejects.toThrow(/amount\.amountMinor must be a non-negative integer literal/);
    expect(provider.charges).toHaveLength(0);
  });

  it('rejects a missing amount rather than reading it as free', async () => {
    // proto3 gives an omitted message its own default instance; a controller that coerced
    // it to zero would charge nothing for an order the caller meant to pay for.
    const { controller, provider } = build();

    await expect(controller.chargeOrder(chargeRequest({ amount: undefined }))).rejects.toThrow(
      /amount is required/,
    );
    expect(provider.charges).toHaveLength(0);
  });

  it('names the line index when a line price is malformed', async () => {
    const { controller, provider } = build();

    await expect(
      controller.chargeOrder(
        chargeRequest({
          lines: [
            { sku: 'SKU-1', quantity: 2, unitPrice: money('1000') },
            { sku: 'SKU-2', quantity: 1, unitPrice: money('10.50') },
          ],
        }),
      ),
    ).rejects.toThrow(/lines\[1\]\.unitPrice\.amountMinor must be a non-negative integer literal/);
    expect(provider.charges).toHaveLength(0);
  });

  it('rejects an omitted line list the way proto3 delivers it', async () => {
    const { controller, provider } = build();

    await expect(controller.chargeOrder(chargeRequest({ lines: undefined }))).rejects.toThrow(
      /charge requires at least one line/,
    );
    expect(provider.charges).toHaveLength(0);
  });

  it('defaults the omitted proto3 scalars to the empty string handlers expect', async () => {
    const { controller, repository } = build();

    const response = await controller.chargeOrder(
      chargeRequest({
        paymentMethodToken: undefined,
        customerId: undefined,
        customerCountry: undefined,
      }),
    );

    // An unknown (here: empty) token succeeds — the storefront's default fixture card.
    expect(response.status).toBe('succeeded');
    expect(repository.payments.get(response.paymentId)).toMatchObject({ customerId: '' });
    // No jurisdiction means the configured default, and `''` stores as "no country named".
    expect(repository.invoices.get(ORDER_ID)?.country).toBeNull();
    expect(repository.invoices.get(ORDER_ID)?.taxMinor).toBe(0);
  });

  it('taxes at the jurisdiction the wire names', async () => {
    const { controller, repository } = build();

    await controller.chargeOrder(
      chargeRequest({ amount: money('2380'), customerCountry: 'DE' }),
    );

    expect(repository.invoices.get(ORDER_ID)).toMatchObject({
      status: 'paid',
      taxMinor: 380,
      totalMinor: TOTAL_DE,
      country: 'DE',
    });
  });

  it('omits nextAction entirely when the provider did not ask for a challenge', async () => {
    // `toEqual` ignores `undefined` properties, so this fails if `nextAction` arrives as an
    // empty message: a client would render `type: ""` — a redirect nowhere.
    const { controller } = build();

    const response = await controller.chargeOrder(chargeRequest());

    expect(response).toEqual({
      paymentId: expect.any(String),
      status: 'succeeded',
      failureCode: '',
    });
    expect(response.nextAction).toBeUndefined();
  });

  it('passes a challenge through with the fields the client needs', async () => {
    const { controller } = build();

    const response = await controller.chargeOrder(
      chargeRequest({ paymentMethodToken: 'pm_requires_action_visa' }),
    );

    expect(response.status).toBe('requires_action');
    expect(response.nextAction).toEqual({
      type: 'redirect',
      redirectUrl: expect.stringContaining(ORDER_ID),
      sdkPayload: '',
    });
  });

  it('reports a decline as a status with a code, not as an error', async () => {
    // A declined card is a conversation with the customer, not a server fault: surfacing it
    // as a gRPC error would make a retry look like an outage.
    const { controller } = build();

    const response = await controller.chargeOrder(
      chargeRequest({ paymentMethodToken: 'pm_decline_visa' }),
    );

    expect(response).toEqual({
      paymentId: expect.any(String),
      status: 'failed',
      failureCode: 'card_declined',
    });
    expect(response.nextAction).toBeUndefined();
  });

  it('keeps `replayed` off the wire — the proto has no such field', async () => {
    // `ChargeResult.replayed` is for logs; inventing a response field the proto does not
    // declare would break clients that validate against the descriptor.
    const { controller } = build();
    const first = await controller.chargeOrder(chargeRequest());

    const again: ChargeOrderResponse = await controller.chargeOrder(chargeRequest());

    expect(Object.keys(again).sort()).toEqual(
      Object.keys(first).sort(),
    );
    expect(again).not.toHaveProperty('replayed');
  });
});

describe('BillingGrpcController.RefundOrder', () => {
  it('treats an omitted amount as the full refund the proto promises', async () => {
    const { controller, repository, provider } = build();
    const { paymentId } = await seedCharge(controller);

    const response: RefundOrderResponse = await controller.refundOrder(refundRequest(paymentId));

    expect(response).toEqual({
      refundId: expect.any(String),
      status: 'succeeded',
      refundedTotal: { amountMinor: '2000', currency: 'EUR' },
    });
    expect(repository.invoices.get(ORDER_ID)?.status).toBe('void');
    expect(provider.refunds).toHaveLength(1);
  });

  it('treats a blank amount message as the full refund too', async () => {
    // proto3's default instance arrives as `{ amountMinor: '' }` rather than as `undefined`,
    // and a caller that padded the field with whitespace meant "everything" as well.
    for (const amount of [money(''), money('   ')]) {
      const { controller, provider } = build();
      const { paymentId } = await seedCharge(controller);

      const response = await controller.refundOrder(refundRequest(paymentId, { amount }));

      expect(response.refundedTotal).toEqual({ amountMinor: '2000', currency: 'EUR' });
      expect(provider.refunds).toHaveLength(1);
    }
  });

  it('parses a partial amount and formats the running total back out', async () => {
    const { controller, repository } = build();
    const { paymentId } = await seedCharge(controller);

    const response = await controller.refundOrder(
      refundRequest(paymentId, { amount: money('500') }),
    );

    expect(response.refundedTotal).toEqual({ amountMinor: '500', currency: 'EUR' });
    // Not fully refunded, so the bill stays alive.
    expect(repository.invoices.get(ORDER_ID)?.status).toBe('paid');
    expect(repository.payments.get(paymentId)?.refundedMinor).toBe(500);
  });

  it('rejects a malformed amount with the field named, before anything moves', async () => {
    const { controller, provider } = build();
    const { paymentId } = await seedCharge(controller);

    await expect(
      controller.refundOrder(refundRequest(paymentId, { amount: money('5.00') })),
    ).rejects.toThrow(/amount\.amountMinor must be a non-negative integer literal/);
    // The seed charge never refunds, and the malformed amount stops before the adapter:
    // a malformed figure must not become a partial refund nobody computed.
    expect(provider.refunds).toHaveLength(0);
  });

  it('refuses a payment that does not exist, through the wire', async () => {
    const { controller, provider } = build();

    await expect(
      controller.refundOrder(
        refundRequest('0e9d8c7b-6a5f-4e3d-2c1b-0a9f8e7d6c5b'),
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);
    expect(provider.refunds).toHaveLength(0);
  });
});

describe('BillingGrpcController.GetInvoice', () => {
  it('formats a stored bill as the wire spells money', async () => {
    const { controller } = build();
    await seedCharge(controller);

    const view: InvoiceView = await controller.getInvoice({ orderId: ORDER_ID });

    expect(view).toEqual({
      invoiceId: expect.any(String),
      orderId: ORDER_ID,
      status: 'paid',
      lines: [
        {
          sku: 'SKU-1',
          quantity: 2,
          unitPrice: { amountMinor: '1000', currency: 'EUR' },
          lineSubtotal: { amountMinor: '2000', currency: 'EUR' },
          tax: { amountMinor: '0', currency: 'EUR' },
        },
      ],
      subtotal: { amountMinor: '2000', currency: 'EUR' },
      discount: { amountMinor: '0', currency: 'EUR' },
      taxTotal: { amountMinor: '0', currency: 'EUR' },
      total: { amountMinor: '2000', currency: 'EUR' },
      currency: 'EUR',
      couponCode: '',
      issuedAt: expect.any(String),
    });
    expect(Date.parse(view.issuedAt)).not.toBeNaN();
  });

  it('spells a coupon through, and an absent issue date as the empty string', async () => {
    const { controller, repository } = build();
    repository.invoices.set(
      ORDER_ID,
      Invoice.fromRow({
        id: '3c2b1a00-0000-4000-8000-000000000001',
        order_id: ORDER_ID,
        status: 'issued',
        subtotal_minor: 2_000,
        discount_minor: 0,
        tax_minor: 0,
        total_minor: 2_000,
        currency: 'EUR',
        coupon_code: 'SAVE10',
        country: 'DE',
        issued_at: null,
        version: 1,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-01-01T00:00:00.000Z'),
        lines: [
          {
            id: '3c2b1a00-0000-4000-8000-000000000002',
            invoice_id: '3c2b1a00-0000-4000-8000-000000000001',
            sku: 'SKU-1',
            quantity: 2,
            unit_price_minor: 1_000,
            line_subtotal_minor: 2_000,
            tax_minor: 0,
          },
        ],
      }),
    );

    const view = await controller.getInvoice({ orderId: ORDER_ID });

    // proto3 has no null: an absent coupon and an absent timestamp both arrive as `""`.
    expect(view.couponCode).toBe('SAVE10');
    expect(view.issuedAt).toBe('');
  });

  it('refuses an order that was never billed, rather than answering an empty bill', async () => {
    const { controller } = build();

    await expect(controller.getInvoice({ orderId: OTHER_ORDER_ID })).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
  });
});

describe('BillingGrpcController.PreviewTotals', () => {
  it('answers with a draft that carries no identity, having written nothing', async () => {
    const { controller, repository, provider } = build();

    const response = await controller.previewTotals(previewRequest());

    expect(response.invoice).toEqual({
      invoiceId: '',
      orderId: '',
      status: 'draft',
      lines: [
        {
          sku: 'SKU-1',
          quantity: 2,
          unitPrice: { amountMinor: '1000', currency: 'EUR' },
          lineSubtotal: { amountMinor: '2000', currency: 'EUR' },
          tax: { amountMinor: '0', currency: 'EUR' },
        },
      ],
      subtotal: { amountMinor: '2000', currency: 'EUR' },
      discount: { amountMinor: '0', currency: 'EUR' },
      taxTotal: { amountMinor: '0', currency: 'EUR' },
      total: { amountMinor: '2000', currency: 'EUR' },
      currency: 'EUR',
      couponCode: '',
      issuedAt: '',
    });
    // A preview is a read: no transaction, no rows, no provider call.
    expect(repository.commits).toBe(0);
    expect(repository.invoices.size).toBe(0);
    expect(provider.charges).toHaveLength(0);
  });

  it('echoes the coupon only when it actually discounted the price', async () => {
    const { controller, repository } = build();
    repository.coupons.set('SAVE10', { code: 'SAVE10', percentOff: 10, active: true });

    const response = await controller.previewTotals(previewRequest({ couponCode: ' SAVE10 ' }));

    expect(response.invoice.couponCode).toBe('SAVE10');
    expect(response.invoice.discount).toEqual({ amountMinor: '200', currency: 'EUR' });
    expect(response.invoice.total).toEqual({ amountMinor: '1800', currency: 'EUR' });
  });

  it('stays quiet about a coupon that discounted nothing', async () => {
    // The domain refuses a 0% coupon outright, so the only way a valid coupon discounts
    // nothing is a cart that is already free. Echoing its code would advertise a saving
    // the preview never applied.
    const { controller, repository } = build();
    repository.coupons.set('SAVE10', { code: 'SAVE10', percentOff: 10, active: true });

    const response = await controller.previewTotals(
      previewRequest({
        lines: [{ sku: 'SKU-1', quantity: 1, unitPrice: money('0') }],
        couponCode: 'SAVE10',
      }),
    );

    expect(response.invoice.discount).toEqual({ amountMinor: '0', currency: 'EUR' });
    expect(response.invoice.couponCode).toBe('');
  });

  it('taxes at the jurisdiction the wire names', async () => {
    const { controller } = build();

    const response = await controller.previewTotals(previewRequest({ customerCountry: 'DE' }));

    expect(response.invoice.taxTotal).toEqual({ amountMinor: '380', currency: 'EUR' });
    expect(response.invoice.total).toEqual({ amountMinor: '2380', currency: 'EUR' });
  });

  it('refuses an unknown coupon rather than previewing a price it will not honour', async () => {
    const { controller } = build();

    await expect(
      controller.previewTotals(previewRequest({ couponCode: 'NOPE' })),
    ).rejects.toBeInstanceOf(ValidationException);
  });

  it('refuses an empty currency the way an omitted proto3 string arrives', async () => {
    const { controller } = build();

    await expect(controller.previewTotals(previewRequest({ currency: undefined }))).rejects.toThrow(
      /currency is required/,
    );
  });
});
