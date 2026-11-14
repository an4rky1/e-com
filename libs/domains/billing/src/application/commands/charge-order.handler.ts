/**
 * @fileoverview The single write path for taking money.
 *
 * @remarks Validation, idempotency and event publication have exactly one hook here
 * rather than one per entry point. The order of operations is the interesting part:
 * shape first (a malformed request is a 400 the database should never discover), then
 * the idempotency lookup (a retry must answer before any money is considered), then the
 * amount reconciliation (a charge that cannot be reconciled against its own lines is the
 * definition of a money bug), and only then the provider.
 *
 * @remarks Nothing in here decides *whether* the provider may be called for a payment
 * that already exists — that decision is the unique `payments.idempotency_key`, read
 * first so a retry never reaches the PSP at all.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { ValidationException } from '@auth/platform/error-handling';
import {
  BILLING_REPOSITORY,
  type BillingRepositoryPort,
} from '../../domain/ports/billing-repository.port';
import {
  PAYMENT_PROVIDER,
  type PaymentProviderPort,
} from '../../domain/ports/payment-provider.port';
import {
  BILLING_CONFIG,
  shippingRateFor,
  taxRateFor,
  type BillingConfig,
} from '../../billing.config';
import { Payment } from '../../domain/payment.entity';
import { Invoice } from '../../domain/invoice.entity';
import { computeTotals, type ComputedTotals } from '../../domain/totals';
import { ChargeOrderCommand, type ChargeResult } from './billing.commands';

@Injectable()
@CommandHandler(ChargeOrderCommand)
export class ChargeOrderHandler implements ICommandHandler<ChargeOrderCommand, ChargeResult> {
  constructor(
    @Inject(BILLING_REPOSITORY) private readonly billing: BillingRepositoryPort,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProviderPort,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  async execute(command: ChargeOrderCommand): Promise<ChargeResult> {
    const orderId = command.orderId?.trim() ?? '';
    if (orderId.length === 0) {
      throw new ValidationException('orderId is required', { orderId });
    }

    const idempotencyKey = command.idempotencyKey?.trim() ?? '';
    if (idempotencyKey.length === 0) {
      // Without it there is no idempotency: every retry would be a fresh charge, and a
      // checkout that retried would take the money twice.
      throw new ValidationException('idempotencyKey is required', { orderId });
    }

    if (command.lines.length === 0) {
      // Refused rather than vacuously accepted: an amount of zero with no lines is not a
      // free order, it is a request nobody computed anything for.
      throw new ValidationException('charge requires at least one line', { orderId });
    }

    // The retry answers here, before the coupon is resolved and long before the PSP is
    // reached: "the same key returns the same result" is the whole contract.
    const existing = await this.billing.findPaymentByIdempotencyKey(idempotencyKey);
    if (existing) {
      return {
        paymentId: existing.id,
        status: existing.status,
        failureCode: existing.failureCode ?? '',
        replayed: true,
      };
    }

    // Resolved exactly as the preview resolves it — same table, same active-only rule —
    // so a charge can never take a different amount than the preview the customer saw.
    // Refused rather than ignored: silently charging full price for a code the customer
    // entered is a price that changed under them.
    let coupon: { code: string; percentOff: number } | undefined;
    const requestedCode = command.couponCode?.trim() ?? '';
    if (requestedCode.length > 0) {
      const found = await this.billing.findCoupon(requestedCode);
      if (!found || !found.active) {
        throw new ValidationException('coupon is unknown or inactive', {
          orderId,
          couponCode: requestedCode,
        });
      }
      coupon = { code: found.code, percentOff: found.percentOff };
    }

    const totals = computeTotals({
      lines: command.lines,
      currency: command.currency,
      taxRateBps: taxRateFor(this.config, command.customerCountry),
      shippingMinor: shippingRateFor(this.config, command.customerCountry),
      coupon,
    });

    if (totals.totalMinor !== command.amountMinor) {
      throw new ValidationException('charge amount does not match lines', {
        orderId,
        expected: totals.totalMinor,
        received: command.amountMinor,
        subtotalMinor: totals.subtotalMinor,
        taxMinor: totals.taxMinor,
      });
    }

    const providerResult = await this.provider.charge({
      orderId,
      amountMinor: totals.totalMinor,
      currency: totals.currency,
      paymentMethodToken: command.paymentMethodToken ?? '',
      customerId: command.customerId ?? '',
    });

    const payment = Payment.fromProvider({
      id: crypto.randomUUID(),
      orderId,
      idempotencyKey,
      amountMinor: totals.totalMinor,
      currency: totals.currency,
      status: providerResult.status,
      provider: this.provider.provider,
      providerRef: providerResult.providerRef,
      failureCode: providerResult.failureCode ?? null,
      customerId: command.customerId ?? '',
    });

    const invoice = await this.invoiceFor(orderId, totals, payment, command, coupon?.code);

    await this.billing.saveCharge({ payment, invoice });

    return {
      paymentId: payment.id,
      status: payment.status,
      nextAction: providerResult.nextAction,
      failureCode: payment.failureCode ?? '',
      replayed: false,
    };
  }

  /**
   * The order's bill after this charge: created, updated, or left alone.
   *
   * @remarks A bill that has already settled (`paid`) or been written off (`void`) is
   * never rewritten by a later attempt — the settled figures are the ones an audit must
   * find, and a failed retry must not be able to change what was actually collected.
   */
  private async invoiceFor(
    orderId: string,
    totals: ComputedTotals,
    payment: Payment,
    command: ChargeOrderCommand,
    couponCode?: string,
  ): Promise<Invoice> {
    const existing = await this.billing.findInvoiceByOrderId(orderId);

    if (!existing) {
      return Invoice.issue({
        orderId,
        totals,
        // A failed charge still leaves a bill: the order side needs something to
        // reconcile against, and "no invoice" is indistinguishable from "never charged".
        status: payment.status === 'succeeded' ? 'paid' : 'issued',
        // Uppercased to the form the rates were actually read under: the bill an
        // auditor opens must name the jurisdiction that was charged, not the casing
        // the storefront happened to type.
        country: command.customerCountry?.trim().toUpperCase() || null,
        couponCode: couponCode ?? null,
      });
    }

    if (existing.status === 'paid' || existing.status === 'void') {
      return existing;
    }

    existing.applyTotals(totals, new Date(), couponCode ?? null);
    if (payment.status === 'succeeded') {
      existing.markPaid();
    }
    return existing;
  }
}
