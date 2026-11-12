/**
 * @fileoverview The transactional-outbox guarantee, asserted against the real repository.
 *
 * @remarks The property under test is about *when* two things happen relative to a
 * transaction boundary, and a boundary is exactly what a database-free double can still
 * model: the fake client records, for every call, whether the transaction was open at that
 * moment. So this suite can prove that the payment row, the invoice, its lines and the
 * event rows are inside the same `runInTransaction`, and that there is only one of them,
 * without a connection anywhere.
 *
 * @remarks The second thing it proves is what the *reads* deliberately do not do: every
 * lookup runs outside any transaction. A read that only observes cannot tear, and the
 * decisions it feeds — idempotency, the refundable balance — are re-asserted by the unique
 * index or by the aggregate inside the write that follows.
 *
 * @remarks This is the only suite that touches `PrismaService`. Everything else goes
 * through a port.
 */
import 'reflect-metadata';
import { Topics } from '@auth/contracts';
import type { PrismaService } from '@auth/infra/prisma';
import type { PrismaClient } from '../src/generated/prisma/client';
import { PrismaBillingRepository } from '../src/infrastructure/persistence/prisma-billing.repository';
import { Payment } from '../src/domain/payment.entity';
import { Invoice } from '../src/domain/invoice.entity';
import { Refund } from '../src/domain/refund.entity';
import { computeTotals } from '../src/domain/totals';
import { ORDER_ID, PAYMENT_ID } from './support/fakes';

const T0 = new Date('2026-01-01T00:00:00.000Z');

interface Recorded {
  readonly call: string;
  readonly inTransaction: boolean;
}

type PaymentRow = ReturnType<Payment['toRow']>;
type InvoiceRow = ReturnType<Invoice['toRow']>;
type RefundRow = ReturnType<Refund['toRow']>;

/**
 * A client double that stores rows in maps and records every call with the transaction
 * state it ran under.
 *
 * @remarks The model properties are named exactly as Prisma spells them (`payments`,
 * `invoice_lines`, …) because that is what the repository calls; the row storage lives
 * behind them under `…Rows` so a test can read what was written.
 */
class RecordingClient {
  readonly calls: Recorded[] = [];

  readonly paymentRows = new Map<string, PaymentRow>();
  readonly invoiceRows = new Map<string, InvoiceRow>();
  readonly lineRows: Record<string, unknown>[] = [];
  readonly refundRows = new Map<string, RefundRow>();
  readonly couponRows = new Map<string, { code: string; percent_off: number; active: boolean }>();

  readonly outboxRows: Record<string, unknown>[] = [];
  readonly skipDuplicates: boolean[] = [];

  inTransaction = false;
  transactions = 0;

  private record(call: string): void {
    this.calls.push({ call, inTransaction: this.inTransaction });
  }

  /** Runs a callback "inside" a transaction, recording the boundary. */
  async runInTransaction<TResult>(fn: (client: this) => Promise<TResult>): Promise<TResult> {
    this.transactions += 1;
    this.inTransaction = true;
    try {
      return await fn(this);
    } finally {
      this.inTransaction = false;
    }
  }

  readonly payments = {
    findUnique: async (args: { where: { id?: string; idempotency_key?: string } }) => {
      this.record('payments.findUnique');
      if (args.where.id !== undefined) return this.paymentRows.get(args.where.id) ?? null;
      for (const row of this.paymentRows.values()) {
        if (row.idempotency_key === args.where.idempotency_key) return row;
      }
      return null;
    },
    create: async (args: { data: PaymentRow }) => {
      this.record('payments.create');
      this.paymentRows.set(args.data.id, args.data);
      return args.data;
    },
    update: async (args: { where: { id: string }; data: Partial<PaymentRow> }) => {
      this.record('payments.update');
      const row = this.paymentRows.get(args.where.id);
      if (!row) throw new Error(`no payment ${args.where.id}`);
      const merged = { ...row, ...args.data };
      this.paymentRows.set(args.where.id, merged);
      return merged;
    },
    count: async () => {
      this.record('payments.count');
      return this.paymentRows.size;
    },
  };

  readonly invoices = {
    findUnique: async (args: { where: { order_id?: string; id?: string } }) => {
      this.record('invoices.findUnique');
      for (const row of this.invoiceRows.values()) {
        const matches =
          (args.where.order_id !== undefined && row.order_id === args.where.order_id) ||
          (args.where.id !== undefined && row.id === args.where.id);
        if (matches) {
          return {
            ...row,
            lines: this.lineRows
              .filter((line) => line['invoice_id'] === row.id)
              .map((line) => line as { id: string; invoice_id: string }),
          };
        }
      }
      return null;
    },
    upsert: async (args: {
      where: { order_id: string };
      create: InvoiceRow;
      update: Partial<InvoiceRow>;
    }) => {
      this.record('invoices.upsert');
      const existing = [...this.invoiceRows.values()].find(
        (row) => row.order_id === args.where.order_id,
      );
      if (existing) {
        const merged = { ...existing, ...args.update };
        this.invoiceRows.set(merged.id, merged);
        return merged;
      }
      this.invoiceRows.set(args.create.id, args.create);
      return args.create;
    },
    update: async (args: { where: { id: string }; data: Partial<InvoiceRow> }) => {
      this.record('invoices.update');
      const row = this.invoiceRows.get(args.where.id);
      if (!row) throw new Error(`no invoice ${args.where.id}`);
      const merged = { ...row, ...args.data };
      this.invoiceRows.set(merged.id, merged);
      return merged;
    },
  };

  readonly invoice_lines = {
    deleteMany: async (args: { where: { invoice_id: string } }) => {
      this.record('invoice_lines.deleteMany');
      const before = this.lineRows.length;
      for (let index = this.lineRows.length - 1; index >= 0; index -= 1) {
        if (this.lineRows[index]['invoice_id'] === args.where.invoice_id) {
          this.lineRows.splice(index, 1);
        }
      }
      return { count: before - this.lineRows.length };
    },
    createMany: async (args: { data: Record<string, unknown>[] }) => {
      this.record('invoice_lines.createMany');
      this.lineRows.push(...args.data);
      return { count: args.data.length };
    },
  };

  readonly refunds = {
    findUnique: async (args: { where: { idempotency_key?: string } }) => {
      this.record('refunds.findUnique');
      for (const row of this.refundRows.values()) {
        if (row.idempotency_key === args.where.idempotency_key) return row;
      }
      return null;
    },
    create: async (args: { data: RefundRow }) => {
      this.record('refunds.create');
      this.refundRows.set(args.data.id, args.data);
      return args.data;
    },
  };

  readonly coupons = {
    findUnique: async (args: { where: { code: string } }) => {
      this.record('coupons.findUnique');
      return this.couponRows.get(args.where.code) ?? null;
    },
  };

  readonly outbox_events = {
    createMany: async (args: { data: Record<string, unknown>[]; skipDuplicates?: boolean }) => {
      this.record('outbox_events.createMany');
      this.outboxRows.push(...args.data);
      this.skipDuplicates.push(args.skipDuplicates === true);
      return { count: args.data.length };
    },
  };
}

const harness = () => {
  const client = new RecordingClient();
  const repository = new PrismaBillingRepository({
    // The boundary lives on the client double, exactly where `PrismaService.runInTransaction`
    // would have it, so the count the assertions read is the real number of transactions.
    runInTransaction: <TResult>(fn: (tx: PrismaClient) => Promise<TResult>): Promise<TResult> =>
      client.runInTransaction(() => fn(client as unknown as PrismaClient)),
    tx: client,
  } as unknown as PrismaService<PrismaClient>);
  return { client, repository };
};

const totals = (coupon?: { code: string; percentOff: number }) =>
  computeTotals({
    lines: [{ sku: 'SKU-1', quantity: 2, unitPriceMinor: 1_000 }],
    currency: 'EUR',
    taxRateBps: 1_900,
    coupon,
  });

const settledPayment = (overrides: Partial<Parameters<typeof Payment.fromProvider>[0]> = {}) =>
  Payment.fromProvider({
    id: PAYMENT_ID,
    orderId: ORDER_ID,
    idempotencyKey: `order:${ORDER_ID}:charge:1`,
    amountMinor: 2_380,
    currency: 'EUR',
    status: 'succeeded',
    provider: 'fake',
    providerRef: 'psp_ch_1',
    customerId: 'customer-1',
    now: T0,
    ...overrides,
  });

describe('PrismaBillingRepository — reads', () => {
  it('answers a payment from its idempotency key without opening a transaction', async () => {
    const { repository, client } = harness();
    await repository.saveCharge({ payment: settledPayment(), invoice: issueInvoice() });
    client.calls.length = 0;

    const found = await repository.findPaymentByIdempotencyKey(
      `order:${ORDER_ID}:charge:1`,
    );

    expect(found?.id).toBe(PAYMENT_ID);
    expect(client.calls).toEqual([{ call: 'payments.findUnique', inTransaction: false }]);
    expect(client.transactions).toBe(1);
  });

  it('answers an invoice with its lines, ordered by sku', async () => {
    const { repository, client } = harness();
    await repository.saveCharge({ payment: settledPayment(), invoice: issueInvoice() });
    client.calls.length = 0;

    const invoice = await repository.findInvoiceByOrderId(ORDER_ID);

    expect(invoice?.orderId).toBe(ORDER_ID);
    expect(invoice?.lines.map((line) => line.sku)).toEqual(['SKU-1']);
    expect(client.calls).toEqual([{ call: 'invoices.findUnique', inTransaction: false }]);
  });

  it('reads a coupon as the table spells it, active flag included', async () => {
    const { repository, client } = harness();
    client.couponRows.set('SAVE10', { code: 'SAVE10', percent_off: 10, active: true });

    const coupon = await repository.findCoupon('SAVE10');

    expect(coupon).toEqual({ code: 'SAVE10', percentOff: 10, active: true });
    expect(client.calls).toEqual([{ call: 'coupons.findUnique', inTransaction: false }]);
  });

  it('counts payments for the readiness probe', async () => {
    const { repository } = harness();
    await repository.saveCharge({ payment: settledPayment(), invoice: issueInvoice() });

    expect(await repository.countPayments()).toBe(1);
  });

  it('answers null rather than inventing rows it did not find', async () => {
    const { repository } = harness();

    expect(await repository.findPaymentByIdempotencyKey('nope')).toBeNull();
    expect(await repository.findPaymentById('nope')).toBeNull();
    expect(await repository.findRefundByIdempotencyKey('nope')).toBeNull();
    expect(await repository.findInvoiceByOrderId(ORDER_ID)).toBeNull();
    expect(await repository.findCoupon('nope')).toBeNull();
  });
});

describe('PrismaBillingRepository — saveCharge', () => {
  it('writes the payment, the bill, its lines and the events in one transaction', async () => {
    const { repository, client } = harness();

    await repository.saveCharge({ payment: settledPayment(), invoice: issueInvoice() });

    // One boundary. Everything a consumer could observe lands together or not at all.
    expect(client.transactions).toBe(1);
    expect(client.calls.every((entry) => entry.inTransaction)).toBe(true);
    expect(client.calls.map((entry) => entry.call)).toEqual([
      'invoices.upsert',
      'invoice_lines.deleteMany',
      'invoice_lines.createMany',
      'payments.create',
      'outbox_events.createMany',
    ]);
    expect(client.paymentRows.get(PAYMENT_ID)).toMatchObject({
      order_id: ORDER_ID,
      amount_minor: 2_380,
      status: 'succeeded',
    });
    expect(client.invoiceRows.values().next().value).toMatchObject({
      order_id: ORDER_ID,
      status: 'paid',
      total_minor: 2_380,
    });
    expect(client.lineRows).toHaveLength(1);
    expect(client.outboxRows.map((row) => row.type)).toEqual([
      'payment.succeeded',
      'invoice.issued',
    ]);
    expect(client.skipDuplicates).toEqual([true]);
  });

  it('upserts the bill by order id, so a second charge updates rather than duplicates', async () => {
    const { repository, client } = harness();
    await repository.saveCharge({ payment: settledPayment(), invoice: issueInvoice() });

    const retryPayment = settledPayment({
      id: crypto.randomUUID(),
      idempotencyKey: `order:${ORDER_ID}:charge:2`,
      providerRef: 'psp_ch_2',
    });
    const retryInvoice = issueInvoice();
    retryInvoice.applyTotals(totals(), T0);
    retryInvoice.markPaid(T0);
    await repository.saveCharge({ payment: retryPayment, invoice: retryInvoice });

    // `invoices.order_id` is unique: the index, not a prior read, decides this is the
    // same bill.
    expect(client.invoiceRows.size).toBe(1);
    expect(client.paymentRows.size).toBe(2);
    expect(client.transactions).toBe(2);
  });

  it('rewrites the lines wholesale, so a corrected bill cannot keep a stale one', async () => {
    const { repository, client } = harness();
    const first = issueInvoice();
    await repository.saveCharge({ payment: settledPayment(), invoice: first });
    expect(client.lineRows).toHaveLength(1);

    const corrected = issueInvoice();
    corrected.applyTotals(
      computeTotals({
        lines: [
          { sku: 'SKU-1', quantity: 1, unitPriceMinor: 1_000 },
          { sku: 'SKU-2', quantity: 1, unitPriceMinor: 380 },
        ],
        currency: 'EUR',
        taxRateBps: 1_900,
      }),
      T0,
    );
    await repository.saveCharge({
      payment: settledPayment({ id: crypto.randomUUID(), idempotencyKey: 'order:x:charge:2' }),
      invoice: corrected,
    });

    // The totals and the lines must agree with each other; a diff that left SKU-1's old
    // quantity behind would make the bill disagree with its own subtotal.
    expect(client.lineRows.map((line) => line['sku'])).toEqual(['SKU-1', 'SKU-2']);
    expect(client.lineRows.map((line) => line['quantity'])).toEqual([1, 1]);
  });

  it('keys each outbox row by the order and the version each family counts', async () => {
    const { repository, client } = harness();

    await repository.saveCharge({ payment: settledPayment(), invoice: issueInvoice() });

    expect(client.outboxRows.map((row) => row['dedup_key'])).toEqual([
      `payment.succeeded:${ORDER_ID}:1`,
      `invoice.issued:${ORDER_ID}:1`,
    ]);
    expect(client.outboxRows.map((row) => row['aggregate_id'])).toEqual([
      ORDER_ID,
      ORDER_ID,
    ]);
    expect(client.outboxRows.map((row) => row['topic'])).toEqual([
      Topics.PAYMENT_SUCCEEDED,
      Topics.INVOICE_ISSUED,
    ]);
  });

  it('drains the event buffers, so a rollback cannot re-announce them later', async () => {
    const { repository } = harness();
    const payment = settledPayment();
    const invoice = issueInvoice();

    await repository.saveCharge({ payment, invoice });

    // An event buffer that survived the write would be written by the *next* save and
    // attributed to a different payment.
    expect(payment.domainEvents).toHaveLength(0);
    expect(invoice.domainEvents).toHaveLength(0);
  });
});

describe('PrismaBillingRepository — saveRefund', () => {
  /**
   * The settled charge a refund acts on, written through the real save path first — a
   * `payments.update` against a row that was never inserted would prove nothing about
   * identity columns holding.
   */
  const seededRefund = async (
    h: ReturnType<typeof harness>,
    options: { voidInvoice?: boolean; amountMinor?: number } = {},
  ) => {
    const payment = settledPayment();
    const invoice = issueInvoice();
    await h.repository.saveCharge({ payment, invoice });
    h.client.calls.length = 0;
    h.client.outboxRows.length = 0;
    const transactionsAfterCharge = h.client.transactions;

    const amountMinor = options.amountMinor ?? 2_380;
    payment.refund(amountMinor, T0);
    let voidedInvoice: Invoice | null = null;
    if (options.voidInvoice && payment.isFullyRefunded) {
      invoice.markVoid(T0);
      voidedInvoice = invoice;
    }
    const refund = Refund.create({
      paymentId: payment.id,
      orderId: ORDER_ID,
      idempotencyKey: `order:${ORDER_ID}:refund:1`,
      amountMinor,
      status: 'succeeded',
      providerRef: 'psp_rf_1',
      now: T0,
    });
    return { payment, invoice, refund, voidedInvoice, transactionsAfterCharge };
  };

  it('writes the refund, the new balance and the events in one transaction', async () => {
    const h = harness();
    const { payment, refund, transactionsAfterCharge } = await seededRefund(h, {
      amountMinor: 500,
    });

    await h.repository.saveRefund({ refund, payment, voidedInvoice: null });

    expect(h.client.transactions - transactionsAfterCharge).toBe(1);
    expect(h.client.calls.map((entry) => entry.call)).toEqual([
      'refunds.create',
      'payments.update',
      'outbox_events.createMany',
    ]);
    expect(h.client.calls.every((entry) => entry.inTransaction)).toBe(true);
    expect(h.client.refundRows.get(refund.id)).toMatchObject({
      payment_id: PAYMENT_ID,
      order_id: ORDER_ID,
      amount_minor: 500,
    });
    expect(h.client.paymentRows.get(PAYMENT_ID)).toMatchObject({
      refunded_minor: 500,
      version: 2,
    });
    // Identity columns never move on update.
    expect(h.client.paymentRows.get(PAYMENT_ID)).toMatchObject({
      id: PAYMENT_ID,
      idempotency_key: `order:${ORDER_ID}:charge:1`,
      amount_minor: 2_380,
    });
    expect(h.client.outboxRows.map((row) => row['dedup_key'])).toEqual([
      `payment.refunded:${ORDER_ID}:2`,
    ]);
  });

  it('writes the bill off in the same transaction when the balance reaches zero', async () => {
    const h = harness();
    const { payment, refund, voidedInvoice, transactionsAfterCharge } = await seededRefund(h, {
      voidInvoice: true,
    });

    await h.repository.saveRefund({ refund, payment, voidedInvoice });

    expect(h.client.transactions - transactionsAfterCharge).toBe(1);
    expect(h.client.calls.map((entry) => entry.call)).toEqual([
      'refunds.create',
      'payments.update',
      'invoices.update',
      'outbox_events.createMany',
    ]);
    expect(h.client.invoiceRows.values().next().value).toMatchObject({
      status: 'void',
      order_id: ORDER_ID,
    });
    // The write-off has no topic of its own: the payment event already carries the fact.
    expect(h.client.outboxRows.map((row) => row['type'])).toEqual(['payment.refunded']);
  });

  it('skips the invoice write entirely for a partial refund', async () => {
    const h = harness();
    const { payment, refund } = await seededRefund(h, { amountMinor: 500 });

    await h.repository.saveRefund({ refund, payment, voidedInvoice: null });

    expect(h.client.calls.map((entry) => entry.call)).toEqual([
      'refunds.create',
      'payments.update',
      'outbox_events.createMany',
    ]);
    // One more than the charge seeded — and still `skipDuplicates`, so a retried
    // refund's event row is a no-op rather than a second announcement.
    expect(h.client.skipDuplicates.every((value) => value === true)).toBe(true);
    expect(h.client.outboxRows.map((row) => row['type'])).toEqual(['payment.refunded']);
  });

  it('always opens a transaction, even for the smallest refund', async () => {
    // A refund path that could skip its own write would be a refund that reports money
    // returned without any row to prove it; the boundary is unconditional.
    const h = harness();
    const { payment, refund, transactionsAfterCharge } = await seededRefund(h, {
      amountMinor: 1,
    });

    await h.repository.saveRefund({ refund, payment, voidedInvoice: null });

    expect(h.client.transactions - transactionsAfterCharge).toBe(1);
    expect(h.client.outboxRows).toHaveLength(1);
  });
});

/** The bill a settled charge of 2380 leaves behind. */
function issueInvoice(): Invoice {
  return Invoice.issue({
    orderId: ORDER_ID,
    totals: totals(),
    status: 'paid',
    country: 'DE',
    now: T0,
  });
}
