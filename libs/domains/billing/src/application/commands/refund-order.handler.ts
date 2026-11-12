/**
 * @fileoverview The single write path for giving money back.
 *
 * @remarks Idempotent on `refunds.idempotency_key`: a retried refund finds the row it
 * already wrote and answers with it, without contacting the provider. A refund path that
 * could run twice is a refund path that pays a customer twice, and no log line makes that
 * money come back.
 *
 * @remarks The remaining balance is checked against the payment's own figures before the
 * provider is called and again inside {@link Payment.refund} — two checks, one rule: a
 * refund may never exceed what was actually taken.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import {
  InvalidStateTransitionException,
  ResourceNotFoundException,
  ValidationException,
} from '@auth/platform/error-handling';
import {
  BILLING_REPOSITORY,
  type BillingRepositoryPort,
} from '../../domain/ports/billing-repository.port';
import {
  PAYMENT_PROVIDER,
  type PaymentProviderPort,
} from '../../domain/ports/payment-provider.port';
import { Refund } from '../../domain/refund.entity';
import type { Invoice } from '../../domain/invoice.entity';
import { RefundOrderCommand, type RefundResult } from './billing.commands';

@Injectable()
@CommandHandler(RefundOrderCommand)
export class RefundOrderHandler implements ICommandHandler<RefundOrderCommand, RefundResult> {
  constructor(
    @Inject(BILLING_REPOSITORY) private readonly billing: BillingRepositoryPort,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProviderPort,
  ) {}

  async execute(command: RefundOrderCommand): Promise<RefundResult> {
    const orderId = command.orderId?.trim() ?? '';
    if (orderId.length === 0) {
      throw new ValidationException('orderId is required', { orderId });
    }

    const paymentId = command.paymentId?.trim() ?? '';
    if (paymentId.length === 0) {
      throw new ValidationException('paymentId is required', { orderId });
    }

    const idempotencyKey = command.idempotencyKey?.trim() ?? '';
    if (idempotencyKey.length === 0) {
      throw new ValidationException('idempotencyKey is required', { orderId, paymentId });
    }

    // The retry answers here, before the payment is even loaded: the money has already
    // gone back, and a second pass must not be able to decide otherwise.
    const existing = await this.billing.findRefundByIdempotencyKey(idempotencyKey);
    if (existing) {
      const payment = await this.billing.findPaymentById(existing.paymentId);
      return {
        refundId: existing.id,
        status: existing.status,
        refundedTotalMinor: payment?.refundedMinor ?? existing.amountMinor,
        currency: payment?.currency ?? '',
        replayed: true,
      };
    }

    const payment = await this.billing.findPaymentById(paymentId);
    if (!payment) {
      throw new ResourceNotFoundException('payment not found', { paymentId, orderId });
    }
    if (payment.orderId !== orderId) {
      // Refused rather than refunded against whichever order the payment belongs to:
      // the pair is the caller's claim, and only the pair can be verified.
      throw new ValidationException('payment does not belong to the order', {
        orderId,
        paymentOrderId: payment.orderId,
        paymentId,
      });
    }
    if (payment.status !== 'succeeded') {
      throw new InvalidStateTransitionException('only a succeeded payment can be refunded', {
        paymentId,
        status: payment.status,
      });
    }

    const remaining = payment.remainingMinor;
    if (remaining <= 0) {
      throw new ValidationException('nothing left to refund', { paymentId, remaining });
    }

    // An empty amount means "everything that is left": the full refund every cancel path
    // asks for, computed from the payment so a caller cannot ask for more than exists.
    const amountMinor = command.amountMinor ?? remaining;
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      throw new ValidationException('refund amount must be a positive integer in minor units', {
        paymentId,
        amountMinor,
      });
    }
    if (amountMinor > remaining) {
      throw new ValidationException('refund exceeds the refundable balance', {
        paymentId,
        requested: amountMinor,
        remaining,
      });
    }

    const providerResult = await this.provider.refund({
      providerRef: payment.providerRef ?? payment.id,
      orderId,
      amountMinor,
      currency: payment.currency,
    });

    const refund = Refund.create({
      paymentId: payment.id,
      orderId,
      idempotencyKey,
      amountMinor,
      status: providerResult.status,
      providerRef: providerResult.providerRef,
    });

    // Buffers `payment.refunded` at the payment's post-refund version, so two partial
    // refunds of one payment produce two distinct dedup keys.
    payment.refund(amountMinor);

    let voidedInvoice: Invoice | null = null;
    if (payment.isFullyRefunded) {
      const invoice = await this.billing.findInvoiceByOrderId(orderId);
      if (invoice) {
        invoice.markVoid();
        voidedInvoice = invoice;
      }
    }

    await this.billing.saveRefund({ refund, payment, voidedInvoice });

    return {
      refundId: refund.id,
      status: refund.status,
      refundedTotalMinor: payment.refundedMinor,
      currency: payment.currency,
      replayed: false,
    };
  }
}
