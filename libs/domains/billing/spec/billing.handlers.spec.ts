/**
 * @fileoverview The four handlers: what a result claims, what ends up stored, and what an
 * event announces.
 *
 * @remarks The domain rules themselves are covered by `billing.aggregate.spec.ts` and
 * `billing.totals.spec.ts`; what this suite guards is the *outbound* surface of the
 * application layer. A handler that reconciled correctly but reported `replayed: false` for
 * a retry, or that charged the right amount and issued the wrong bill status, would be a
 * bug only these tests can see.
 *
 * @remarks Handlers are constructed directly rather than through a `TestingModule`: each
 * one takes ports and a config object, and a container would hide exactly the wiring these
 * assertions are about. The repository is the in-memory double, whose semantics deliberately
 * mirror `PrismaBillingRepository` — idempotent on the business keys, one invoice per order,
 * events drained at save. The provider is the real fake adapter, instrumented so a suite can
 * prove a retried command never reached the PSP twice.
 *
 * @remarks Idempotency is the recurring theme. Every retry path a caller can take — a charge
 * that lands twice, a refund that runs twice, a preview that runs at all — must answer
 * without moving money a second time and without announcing a second time.
 */
import 'reflect-metadata';
import {
  InvalidStateTransitionException,
  ResourceNotFoundException,
  ValidationException,
} from '@auth/platform/error-handling';
import { ChargeOrderHandler } from '../src/application/commands/charge-order.handler';
import { RefundOrderHandler } from '../src/application/commands/refund-order.handler';
import {
  ChargeOrderCommand,
  RefundOrderCommand,
  type ChargeLineInput,
} from '../src/application/commands/billing.commands';
import {
  GetInvoiceHandler,
  GetInvoiceQuery,
  PreviewTotalsHandler,
  PreviewTotalsQuery,
} from '../src/application/queries/billing.queries';
import { FakePaymentProvider } from '../src/infrastructure/payment/fake-payment.provider';
import {
  InMemoryBillingRepository,
  ORDER_ID,
  OTHER_ORDER_ID,
  TOPICS,
  testBillingConfig,
} from './support/fakes';

/** 2 × 10.00: the frozen subtotal every default-jurisdiction line below starts from. */
const LINES: readonly ChargeLineInput[] = [{ sku: 'SKU-1', quantity: 2, unitPriceMinor: 1_000 }];
const SUBTOTAL = 2_000;
/** The default jurisdiction's (US) flat delivery charge. */
const SHIP_US = 500;
/** Subtotal + default shipping: 0% tax, so exactly 2500 to pay. */
const TOTAL_US = 2_500;
/** The same lines under German VAT and DE shipping: 2000 + 380 + 499 = 2879. */
const TOTAL_DE = 2_879;

const context = () => {
  const repository = new InMemoryBillingRepository();
  const provider = new FakePaymentProvider();
  const config = testBillingConfig();

  return {
    repository,
    provider,
    config,
    charge: new ChargeOrderHandler(repository, provider, config),
    refund: new RefundOrderHandler(repository, provider),
    invoice: new GetInvoiceHandler(repository),
    preview: new PreviewTotalsHandler(repository, config),
  };
};

const chargeCommand = (
  overrides: {
    orderId?: string;
    idempotencyKey?: string;
    amountMinor?: number;
    currency?: string;
    paymentMethodToken?: string;
    customerId?: string;
    lines?: readonly ChargeLineInput[];
    customerCountry?: string;
    couponCode?: string;
  } = {},
): ChargeOrderCommand =>
  new ChargeOrderCommand(
    overrides.orderId ?? ORDER_ID,
    overrides.idempotencyKey ?? `order:${ORDER_ID}:charge:1`,
    overrides.amountMinor ?? TOTAL_US,
    overrides.currency ?? 'EUR',
    overrides.paymentMethodToken ?? 'pm_card_visa',
    overrides.customerId ?? 'customer-1',
    overrides.lines ?? LINES,
    overrides.customerCountry,
    overrides.couponCode,
  );

/** Charges once through the public path, then isolates the outbox for the test's subject. */
const seededCharge = async (
  harness: ReturnType<typeof context>,
  overrides: Parameters<typeof chargeCommand>[0] = {},
): Promise<{ paymentId: string }> => {
  const result = await harness.charge.execute(chargeCommand(overrides));
  harness.repository.outbox.length = 0;
  return { paymentId: result.paymentId };
};

describe('ChargeOrderCommand', () => {
  it('charges once and bills the order', async () => {
    const harness = context();

    const result = await harness.charge.execute(chargeCommand());

    expect(result).toMatchObject({
      status: 'succeeded',
      replayed: false,
      failureCode: '',
      paymentId: expect.any(String),
    });

    const payment = harness.repository.payments.get(result.paymentId);
    expect(payment).toMatchObject({
      orderId: ORDER_ID,
      idempotencyKey: `order:${ORDER_ID}:charge:1`,
      amountMinor: TOTAL_US,
      currency: 'EUR',
      status: 'succeeded',
      provider: 'fake',
      refundedMinor: 0,
    });
    expect(payment?.providerRef).toMatch(/^psp_ch_/);

    const invoice = harness.repository.invoices.get(ORDER_ID);
    expect(invoice).toMatchObject({
      orderId: ORDER_ID,
      status: 'paid',
      subtotalMinor: SUBTOTAL,
      taxMinor: 0,
      shippingMinor: SHIP_US,
      totalMinor: TOTAL_US,
      country: null,
    });

    expect(harness.repository.commits).toBe(1);
    expect(harness.provider.charges).toHaveLength(1);
    expect(harness.provider.charges[0]).toMatchObject({
      orderId: ORDER_ID,
      amountMinor: TOTAL_US,
      currency: 'EUR',
    });
  });

  it('announces the settled charge and the bill, keyed by the order', async () => {
    const harness = context();

    await harness.charge.execute(chargeCommand());

    expect(harness.repository.outbox.map((event) => event.eventType)).toEqual([
      'payment.succeeded',
      'invoice.issued',
    ]);
    expect(harness.repository.outbox.map((event) => event.dedupKey)).toEqual([
      `payment.succeeded:${ORDER_ID}:1`,
      `invoice.issued:${ORDER_ID}:1`,
    ]);
    expect(harness.repository.outbox[0].topic).toBe(TOPICS['payment.succeeded']);
    expect(harness.repository.outbox[1].topic).toBe(TOPICS['invoice.issued']);
    expect(harness.repository.outbox[0].aggregateId).toBe(ORDER_ID);
    expect(harness.repository.outbox[0].payload).toMatchObject({
      orderId: ORDER_ID,
      amountMinor: TOTAL_US,
      status: 'succeeded',
    });
    expect(harness.repository.outbox[1].payload).toMatchObject({
      orderId: ORDER_ID,
      totalMinor: TOTAL_US,
    });
  });

  it('answers a retry with the charge it already made, without touching the provider', async () => {
    const harness = context();
    const first = await harness.charge.execute(chargeCommand());
    const outboxAfterFirst = harness.repository.outbox.length;

    const again = await harness.charge.execute(chargeCommand());

    expect(again).toMatchObject({
      paymentId: first.paymentId,
      status: 'succeeded',
      replayed: true,
      failureCode: '',
    });
    // The unique `payments.idempotency_key` is what makes this a no-op: a second call to
    // the PSP would be a second chance to take the money.
    expect(harness.provider.charges).toHaveLength(1);
    expect(harness.repository.payments.size).toBe(1);
    expect(harness.repository.commits).toBe(1);
    expect(harness.repository.outbox).toHaveLength(outboxAfterFirst);
  });

  it('answers a retry before reconciling the amount', async () => {
    const harness = context();
    await harness.charge.execute(chargeCommand());

    // The retry's job is to report what already happened; a mismatched amount on a key
    // that already settled is not a new charge to reconcile.
    const again = await harness.charge.execute(chargeCommand({ amountMinor: 1 }));

    expect(again.replayed).toBe(true);
    expect(harness.provider.charges).toHaveLength(1);
  });

  it('refuses an amount that does not match its own lines', async () => {
    const harness = context();

    const error = await harness.charge
      .execute(chargeCommand({ amountMinor: TOTAL_US - 1 }))
      .then(
        () => null,
        (thrown: unknown) => thrown as ValidationException,
      );

    expect(error).toBeInstanceOf(ValidationException);
    expect(error?.context).toMatchObject({
      orderId: ORDER_ID,
      expected: TOTAL_US,
      received: TOTAL_US - 1,
    });
    // Nothing was considered: no provider call, no rows, no transaction.
    expect(harness.provider.charges).toHaveLength(0);
    expect(harness.repository.payments.size).toBe(0);
    expect(harness.repository.invoices.size).toBe(0);
    expect(harness.repository.commits).toBe(0);
  });

  it('taxes the charge at the customer jurisdiction', async () => {
    const harness = context();

    const result = await harness.charge.execute(
      chargeCommand({ amountMinor: TOTAL_DE, customerCountry: 'DE' }),
    );

    expect(result.status).toBe('succeeded');
    expect(harness.repository.invoices.get(ORDER_ID)).toMatchObject({
      status: 'paid',
      taxMinor: 380,
      shippingMinor: 499,
      totalMinor: TOTAL_DE,
      country: 'DE',
    });
  });

  it('charges the coupon the customer named, at the previewed price', async () => {
    const harness = context();
    harness.repository.coupons.set('SAVE10', { code: 'SAVE10', percentOff: 10, active: true });

    // gross = 2000 + 0 tax + 500 shipping = 2500; 10% off = 250; total 2250.
    const result = await harness.charge.execute(
      chargeCommand({ amountMinor: 2_250, couponCode: ' SAVE10 ' }),
    );

    expect(result.status).toBe('succeeded');
    expect(harness.repository.invoices.get(ORDER_ID)).toMatchObject({
      status: 'paid',
      discountMinor: 250,
      totalMinor: 2_250,
      couponCode: 'SAVE10',
    });
    expect(harness.provider.charges[0]).toMatchObject({ amountMinor: 2_250 });
  });

  it('refuses a coupon the store does not honour, before the provider is reached', async () => {
    const harness = context();

    const error = await harness.charge
      .execute(chargeCommand({ couponCode: 'NOPE' }))
      .then(
        () => null,
        (thrown: unknown) => thrown as ValidationException,
      );

    expect(error).toBeInstanceOf(ValidationException);
    expect(error?.message).toMatch(/coupon is unknown or inactive/);
    expect(harness.provider.charges).toHaveLength(0);
    expect(harness.repository.commits).toBe(0);
  });

  it('declines through the provider and still leaves a bill', async () => {
    const harness = context();

    const result = await harness.charge.execute(
      chargeCommand({ paymentMethodToken: 'pm_decline_visa' }),
    );

    expect(result).toMatchObject({ status: 'failed', failureCode: 'card_declined' });
    // A failed charge still leaves a bill: "no invoice" is indistinguishable from
    // "never charged" to the order side.
    expect(harness.repository.invoices.get(ORDER_ID)).toMatchObject({
      status: 'issued',
      totalMinor: TOTAL_US,
    });
    expect(harness.repository.outbox.map((event) => event.eventType)).toEqual([
      'payment.failed',
      'invoice.issued',
    ]);
  });

  it('passes a challenge through without announcing a payment fact', async () => {
    const harness = context();

    const result = await harness.charge.execute(
      chargeCommand({ paymentMethodToken: 'pm_requires_action_visa' }),
    );

    expect(result.status).toBe('requires_action');
    expect(result.nextAction).toMatchObject({
      type: 'redirect',
      redirectUrl: expect.stringContaining(ORDER_ID),
    });
    // `requires_action` is neither success nor failure: the customer has not been
    // challenged yet, and `Topics` carries no event for "still deciding".
    expect(harness.repository.outbox.map((event) => event.eventType)).toEqual([
      'invoice.issued',
    ]);
    expect(harness.repository.invoices.get(ORDER_ID)?.status).toBe('issued');
  });

  it('updates an outstanding bill when a later attempt settles', async () => {
    const harness = context();
    await harness.charge.execute(
      chargeCommand({ idempotencyKey: `order:${ORDER_ID}:charge:1`, paymentMethodToken: 'pm_decline_visa' }),
    );
    harness.repository.outbox.length = 0;

    const cheaper: readonly ChargeLineInput[] = [{ sku: 'SKU-2', quantity: 1, unitPriceMinor: 500 }];
    await harness.charge.execute(
      // 500 lines + 500 default shipping: the amount must still reconcile exactly.
      chargeCommand({ idempotencyKey: `order:${ORDER_ID}:charge:2`, amountMinor: 1_000, lines: cheaper }),
    );

    const invoice = harness.repository.invoices.get(ORDER_ID);
    expect(harness.repository.invoices.size).toBe(1);
    expect(invoice).toMatchObject({ status: 'paid', subtotalMinor: 500, totalMinor: 1_000 });
    // The lines are replaced, not merged, and `invoice.issued` is not re-announced: the
    // row already exists, and a second announcement would say it exists twice.
    expect(invoice?.lines).toHaveLength(1);
    expect(harness.repository.outbox.map((event) => event.eventType)).toEqual([
      'payment.succeeded',
    ]);
  });

  it('never rewrites a bill that has already settled', async () => {
    const harness = context();
    await harness.charge.execute(chargeCommand());
    harness.repository.outbox.length = 0;

    const cheaper: readonly ChargeLineInput[] = [{ sku: 'SKU-2', quantity: 1, unitPriceMinor: 500 }];
    await harness.charge.execute(
      chargeCommand({ idempotencyKey: `order:${ORDER_ID}:charge:2`, amountMinor: 1_000, lines: cheaper }),
    );

    // The settled figures are what an audit must find; a later attempt — even a
    // successful one — may not move them.
    expect(harness.repository.invoices.get(ORDER_ID)).toMatchObject({
      status: 'paid',
      subtotalMinor: SUBTOTAL,
      totalMinor: TOTAL_US,
      version: 1,
    });
    expect(harness.repository.invoices.get(ORDER_ID)?.lines[0].sku).toBe('SKU-1');
    expect(harness.repository.payments.size).toBe(2);
  });

  it('never rewrites a bill that was written off', async () => {
    const harness = context();
    const { paymentId } = await seededCharge(harness);
    await harness.refund.execute(
      new RefundOrderCommand(ORDER_ID, paymentId, `order:${ORDER_ID}:refund:1`, 'cancel'),
    );
    expect(harness.repository.invoices.get(ORDER_ID)?.status).toBe('void');
    harness.repository.outbox.length = 0;

    await harness.charge.execute(
      chargeCommand({ idempotencyKey: `order:${ORDER_ID}:charge:2` }),
    );

    expect(harness.repository.invoices.get(ORDER_ID)).toMatchObject({
      status: 'void',
      totalMinor: TOTAL_US,
    });
  });

  it('refuses a request with no lines, no order and no key before the provider is reached', async () => {
    const harness = context();

    await expect(harness.charge.execute(chargeCommand({ lines: [] }))).rejects.toBeInstanceOf(
      ValidationException,
    );
    await expect(harness.charge.execute(chargeCommand({ orderId: '  ' }))).rejects.toBeInstanceOf(
      ValidationException,
    );
    await expect(
      harness.charge.execute(chargeCommand({ idempotencyKey: ' ' })),
    ).rejects.toBeInstanceOf(ValidationException);
    await expect(
      harness.charge.execute(chargeCommand({ lines: [{ sku: 'SKU-1', quantity: 0, unitPriceMinor: 100 }] })),
    ).rejects.toBeInstanceOf(ValidationException);

    expect(harness.provider.charges).toHaveLength(0);
    expect(harness.repository.commits).toBe(0);
  });
});

describe('RefundOrderCommand', () => {
  it('returns the full balance when the caller names no amount, and writes the bill off', async () => {
    const harness = context();
    const { paymentId } = await seededCharge(harness);

    const result = await harness.refund.execute(
      new RefundOrderCommand(ORDER_ID, paymentId, `order:${ORDER_ID}:refund:1`, 'customer cancelled'),
    );

    expect(result).toMatchObject({
      status: 'succeeded',
      replayed: false,
      refundedTotalMinor: TOTAL_US,
      currency: 'EUR',
      refundId: expect.any(String),
    });

    const payment = harness.repository.payments.get(paymentId);
    expect(payment).toMatchObject({ refundedMinor: TOTAL_US });
    expect(payment?.remainingMinor).toBe(0);
    expect(harness.repository.invoices.get(ORDER_ID)?.status).toBe('void');
    expect(harness.repository.commits).toBe(2);
    expect(harness.provider.refunds).toHaveLength(1);
    expect(harness.provider.refunds[0]).toMatchObject({
      orderId: ORDER_ID,
      amountMinor: TOTAL_US,
      currency: 'EUR',
    });
    expect(harness.repository.outbox.map((event) => event.eventType)).toEqual([
      'payment.refunded',
    ]);
    expect(harness.repository.outbox[0].dedupKey).toBe(`payment.refunded:${ORDER_ID}:2`);
  });

  it('returns part of the balance and keeps the bill alive', async () => {
    const harness = context();
    const { paymentId } = await seededCharge(harness);

    const result = await harness.refund.execute(
      new RefundOrderCommand(ORDER_ID, paymentId, `order:${ORDER_ID}:refund:1`, 'partial', 500),
    );

    expect(result).toMatchObject({ refundedTotalMinor: 500, replayed: false });
    expect(harness.repository.payments.get(paymentId)?.refundedMinor).toBe(500);
    // Not fully refunded, so nothing is written off and no invoice event is due.
    expect(harness.repository.invoices.get(ORDER_ID)?.status).toBe('paid');
    expect(harness.repository.outbox.map((event) => event.eventType)).toEqual([
      'payment.refunded',
    ]);
  });

  it('two partial refunds produce two distinct dedup keys', async () => {
    const harness = context();
    const { paymentId } = await seededCharge(harness);

    await harness.refund.execute(
      new RefundOrderCommand(ORDER_ID, paymentId, `order:${ORDER_ID}:refund:1`, 'partial', 500),
    );
    await harness.refund.execute(
      new RefundOrderCommand(ORDER_ID, paymentId, `order:${ORDER_ID}:refund:2`, 'partial', 500),
    );

    expect(harness.repository.outbox.map((event) => event.dedupKey)).toEqual([
      `payment.refunded:${ORDER_ID}:2`,
      `payment.refunded:${ORDER_ID}:3`,
    ]);
    expect(harness.repository.payments.get(paymentId)?.refundedMinor).toBe(1_000);
    expect(harness.provider.refunds).toHaveLength(2);
  });

  it('answers a retry with the refund it already made, without touching the provider', async () => {
    const harness = context();
    const { paymentId } = await seededCharge(harness);
    const first = await harness.refund.execute(
      new RefundOrderCommand(ORDER_ID, paymentId, `order:${ORDER_ID}:refund:1`, 'cancel', 500),
    );
    const outboxAfterFirst = harness.repository.outbox.length;

    const again = await harness.refund.execute(
      new RefundOrderCommand(ORDER_ID, paymentId, `order:${ORDER_ID}:refund:1`, 'cancel', 500),
    );

    expect(again).toMatchObject({
      refundId: first.refundId,
      status: 'succeeded',
      refundedTotalMinor: 500,
      replayed: true,
    });
    expect(harness.provider.refunds).toHaveLength(1);
    expect(harness.repository.refunds.size).toBe(1);
    expect(harness.repository.commits).toBe(2);
    expect(harness.repository.outbox).toHaveLength(outboxAfterFirst);
  });

  it('refuses a refund larger than what is left', async () => {
    const harness = context();
    const { paymentId } = await seededCharge(harness);

    const error = await harness.refund
      .execute(new RefundOrderCommand(ORDER_ID, paymentId, `order:${ORDER_ID}:refund:1`, 'x', TOTAL_US + 1))
      .then(
        () => null,
        (thrown: unknown) => thrown as ValidationException,
      );

    expect(error).toBeInstanceOf(ValidationException);
    expect(error?.context).toMatchObject({ requested: TOTAL_US + 1, remaining: TOTAL_US });
    expect(harness.provider.refunds).toHaveLength(0);
    expect(harness.repository.payments.get(paymentId)?.refundedMinor).toBe(0);
    expect(harness.repository.commits).toBe(1);
  });

  it('refuses a refund that is not a positive integer in minor units', async () => {
    const harness = context();
    const { paymentId } = await seededCharge(harness);

    for (const amountMinor of [0, -100, 10.5]) {
      await expect(
        harness.refund.execute(
          new RefundOrderCommand(ORDER_ID, paymentId, `order:${ORDER_ID}:refund:${amountMinor}`, 'x', amountMinor),
        ),
      ).rejects.toBeInstanceOf(ValidationException);
    }

    expect(harness.provider.refunds).toHaveLength(0);
    expect(harness.repository.commits).toBe(1);
  });

  it('refuses a payment that never settled', async () => {
    const harness = context();
    const { paymentId } = await seededCharge(harness, { paymentMethodToken: 'pm_decline_visa' });

    await expect(
      harness.refund.execute(
        new RefundOrderCommand(ORDER_ID, paymentId, `order:${ORDER_ID}:refund:1`, 'x'),
      ),
    ).rejects.toBeInstanceOf(InvalidStateTransitionException);

    expect(harness.provider.refunds).toHaveLength(0);
    expect(harness.repository.commits).toBe(1);
  });

  it('refuses a payment that belongs to another order', async () => {
    const harness = context();
    const { paymentId } = await seededCharge(harness);

    await expect(
      harness.refund.execute(
        new RefundOrderCommand(OTHER_ORDER_ID, paymentId, `order:${OTHER_ORDER_ID}:refund:1`, 'x'),
      ),
    ).rejects.toBeInstanceOf(ValidationException);

    expect(harness.provider.refunds).toHaveLength(0);
    expect(harness.repository.payments.get(paymentId)?.refundedMinor).toBe(0);
  });

  it('refuses a payment that does not exist', async () => {
    const harness = context();

    await expect(
      harness.refund.execute(
        new RefundOrderCommand(ORDER_ID, '0e9d8c7b-6a5f-4e3d-2c1b-0a9f8e7d6c5b', `order:${ORDER_ID}:refund:1`, 'x'),
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);

    expect(harness.provider.refunds).toHaveLength(0);
  });

  it('refuses a second refund once the balance is gone', async () => {
    const harness = context();
    const { paymentId } = await seededCharge(harness);
    await harness.refund.execute(
      new RefundOrderCommand(ORDER_ID, paymentId, `order:${ORDER_ID}:refund:1`, 'cancel'),
    );

    await expect(
      harness.refund.execute(
        new RefundOrderCommand(ORDER_ID, paymentId, `order:${ORDER_ID}:refund:2`, 'again'),
      ),
    ).rejects.toBeInstanceOf(ValidationException);

    expect(harness.provider.refunds).toHaveLength(1);
    expect(harness.repository.refunds.size).toBe(1);
    expect(harness.repository.commits).toBe(2);
  });

  it('refuses a request with no order, no payment and no key', async () => {
    const harness = context();

    await expect(
      harness.refund.execute(new RefundOrderCommand(' ', 'pay', 'key', 'x')),
    ).rejects.toBeInstanceOf(ValidationException);
    await expect(
      harness.refund.execute(new RefundOrderCommand(ORDER_ID, ' ', 'key', 'x')),
    ).rejects.toBeInstanceOf(ValidationException);
    await expect(
      harness.refund.execute(new RefundOrderCommand(ORDER_ID, 'pay', ' ', 'x')),
    ).rejects.toBeInstanceOf(ValidationException);

    expect(harness.repository.commits).toBe(0);
  });
});

describe('GetInvoiceQuery', () => {
  it("returns the order's bill", async () => {
    const harness = context();
    await seededCharge(harness);

    const invoice = await harness.invoice.execute(new GetInvoiceQuery(ORDER_ID));

    expect(invoice).toMatchObject({ orderId: ORDER_ID, status: 'paid', totalMinor: TOTAL_US });
    expect(invoice.lines).toHaveLength(1);
  });

  it('refuses an order that was never billed, rather than answering an empty bill', async () => {
    const harness = context();

    await expect(harness.invoice.execute(new GetInvoiceQuery(ORDER_ID))).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
  });

  it('refuses a blank order id', async () => {
    const harness = context();

    await expect(harness.invoice.execute(new GetInvoiceQuery('  '))).rejects.toBeInstanceOf(
      ValidationException,
    );
  });
});

describe('PreviewTotalsQuery', () => {
  it('computes what a charge would cost without writing anything', async () => {
    const harness = context();

    const totals = await harness.preview.execute(
      new PreviewTotalsQuery(LINES, 'EUR'),
    );

    expect(totals).toMatchObject({
      subtotalMinor: SUBTOTAL,
      taxMinor: 0,
      shippingMinor: SHIP_US,
      discountMinor: 0,
      totalMinor: TOTAL_US,
      currency: 'EUR',
    });
    // A preview is a read: no transaction, no rows, no announcements.
    expect(harness.repository.commits).toBe(0);
    expect(harness.repository.invoices.size).toBe(0);
    expect(harness.repository.outbox).toHaveLength(0);
    expect(harness.provider.charges).toHaveLength(0);
  });

  it('applies a coupon the repository knows', async () => {
    const harness = context();
    harness.repository.coupons.set('SAVE10', { code: 'SAVE10', percentOff: 10, active: true });

    const totals = await harness.preview.execute(
      new PreviewTotalsQuery(LINES, 'EUR', undefined, ' SAVE10 '),
    );

    expect(totals.discountMinor).toBe(250);
    expect(totals.totalMinor).toBe(2_250);
  });

  it('taxes at the customer jurisdiction', async () => {
    const harness = context();

    const totals = await harness.preview.execute(
      new PreviewTotalsQuery(LINES, 'EUR', 'DE'),
    );

    expect(totals).toMatchObject({ taxMinor: 380, totalMinor: TOTAL_DE });
  });

  it('refuses an unknown coupon rather than showing a discount it will not honour', async () => {
    const harness = context();

    await expect(
      harness.preview.execute(new PreviewTotalsQuery(LINES, 'EUR', undefined, 'NOPE')),
    ).rejects.toBeInstanceOf(ValidationException);
  });

  it('refuses an inactive coupon', async () => {
    const harness = context();
    harness.repository.coupons.set('EXPIRED', { code: 'EXPIRED', percentOff: 25, active: false });

    await expect(
      harness.preview.execute(new PreviewTotalsQuery(LINES, 'EUR', undefined, 'EXPIRED')),
    ).rejects.toBeInstanceOf(ValidationException);
    expect(harness.repository.commits).toBe(0);
  });
});
