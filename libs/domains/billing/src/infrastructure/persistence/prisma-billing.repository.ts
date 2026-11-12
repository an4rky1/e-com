/**
 * @fileoverview The Prisma implementation of the billing port, including the outbox.
 *
 * @remarks This is where atomicity lives. `saveCharge` and `saveRefund` each run inside
 * one interactive transaction, so the money row, the bill and the `outbox_events` rows
 * either all commit or none of them do — which is the only way "we told the order side
 * this payment settled" can be a true statement.
 *
 * @remarks Reads never open a transaction: a lookup that only observes cannot tear, and
 * opening one anyway would put a lock on the hot path for nothing. Every *decision* a
 * read feeds (idempotency, the balance check) is re-asserted by a unique index or by the
 * aggregate inside the write transaction that follows.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type PrismaService } from '@auth/infra/prisma';
import { Topics } from '@auth/contracts';
import type { PrismaClient } from '../../generated/prisma/client';
import { Payment } from '../../domain/payment.entity';
import { Invoice } from '../../domain/invoice.entity';
import { Refund } from '../../domain/refund.entity';
import {
  BILLING_REPOSITORY,
  type BillingRepositoryPort,
  type Coupon,
  type SaveChargeInput,
  type SaveRefundInput,
} from '../../domain/ports/billing-repository.port';
import { BILLING_PRISMA } from '../../billing.config';
import { enqueueEvents } from './outbox-enqueue';

/**
 * The `payment.*` / `invoice.*` -> topic mapping.
 *
 * @remarks Domain events name facts in the domain's language; topics are a transport
 * contract. Keeping the translation in one function means adding an event cannot
 * accidentally invent a topic name that no consumer subscribes to.
 */
const BILLING_TOPICS: Readonly<Record<string, string>> = {
  'payment.succeeded': Topics.PAYMENT_SUCCEEDED,
  'payment.failed': Topics.PAYMENT_FAILED,
  'payment.refunded': Topics.PAYMENT_REFUNDED,
  'invoice.issued': Topics.INVOICE_ISSUED,
};

@Injectable()
export class PrismaBillingRepository implements BillingRepositoryPort {
  private readonly logger = new Logger(PrismaBillingRepository.name);

  constructor(
    @Inject(BILLING_PRISMA) private readonly prisma: PrismaService<PrismaClient>,
  ) {}

  async findPaymentByIdempotencyKey(idempotencyKey: string): Promise<Payment | null> {
    const row = await this.prisma.tx.payments.findUnique({
      where: { idempotency_key: idempotencyKey },
    });
    return row ? Payment.fromRow(row) : null;
  }

  async findPaymentById(paymentId: string): Promise<Payment | null> {
    const row = await this.prisma.tx.payments.findUnique({ where: { id: paymentId } });
    return row ? Payment.fromRow(row) : null;
  }

  async findRefundByIdempotencyKey(idempotencyKey: string): Promise<Refund | null> {
    const row = await this.prisma.tx.refunds.findUnique({
      where: { idempotency_key: idempotencyKey },
    });
    return row ? Refund.fromRow(row) : null;
  }

  async findInvoiceByOrderId(orderId: string): Promise<Invoice | null> {
    const row = await this.prisma.tx.invoices.findUnique({
      where: { order_id: orderId },
      include: { lines: { orderBy: { sku: 'asc' } } },
    });
    return row ? Invoice.fromRow(row) : null;
  }

  async findCoupon(code: string): Promise<Coupon | null> {
    const row = await this.prisma.tx.coupons.findUnique({ where: { code } });
    if (!row) return null;
    return { code: row.code, percentOff: row.percent_off, active: row.active };
  }

  async saveCharge(input: SaveChargeInput): Promise<void> {
    const { payment, invoice } = input;

    return this.prisma.runInTransaction(async (client) => {
      // The invoice is upserted rather than created-or-updated by a prior read: the read
      // happened outside this transaction, and `invoices.order_id` is unique, so the
      // index — not the read — is what decides whether this is a first charge.
      const stored = await client.invoices.upsert({
        where: { order_id: invoice.orderId },
        create: {
          id: invoice.id,
          order_id: invoice.orderId,
          status: invoice.status,
          subtotal_minor: invoice.subtotalMinor,
          discount_minor: invoice.discountMinor,
          tax_minor: invoice.taxMinor,
          total_minor: invoice.totalMinor,
          currency: invoice.currency,
          coupon_code: invoice.couponCode,
          country: invoice.country,
          issued_at: invoice.issuedAt,
          version: invoice.version,
          created_at: invoice.issuedAt ?? new Date(),
          updated_at: new Date(),
        },
        update: invoice.toUpdate(),
      });

      // Lines are rewritten wholesale: the totals of a corrected charge replace the old
      // ones, and a diff that left a stale line behind would make the invoice disagree
      // with itself.
      await client.invoice_lines.deleteMany({ where: { invoice_id: stored.id } });
      await client.invoice_lines.createMany({
        data: invoice.toLineRows().map((line) => ({
          id: crypto.randomUUID(),
          invoice_id: stored.id,
          ...line,
        })),
      });

      await client.payments.create({ data: payment.toRow() });

      await enqueueEvents(
        [...payment.clearDomainEvents(), ...invoice.clearDomainEvents()],
        { client, logger: this.logger, topics: BILLING_TOPICS },
      );
    });
  }

  async saveRefund(input: SaveRefundInput): Promise<void> {
    const { refund, payment, voidedInvoice } = input;

    return this.prisma.runInTransaction(async (client) => {
      await client.refunds.create({ data: refund.toRow() });
      await client.payments.update({
        where: { id: payment.id },
        data: payment.toUpdate(),
      });

      if (voidedInvoice) {
        await client.invoices.update({
          where: { id: voidedInvoice.id },
          data: voidedInvoice.toUpdate(),
        });
      }

      await enqueueEvents(
        [
          ...payment.clearDomainEvents(),
          ...(voidedInvoice ? voidedInvoice.clearDomainEvents() : []),
        ],
        { client, logger: this.logger, topics: BILLING_TOPICS },
      );
    });
  }

  async countPayments(): Promise<number> {
    return this.prisma.tx.payments.count();
  }
}

export { BILLING_REPOSITORY };
