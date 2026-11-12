/**
 * @fileoverview The write path for a provider webhook.
 *
 * @remarks Order of operations is the security property: the HMAC is verified over the
 * raw bytes *before* the body is parsed, so a payload that has not been authenticated
 * never reaches `JSON.parse` and never reaches the status rules. An empty
 * `webhookSecret` refuses every delivery — a deployment that forgot to configure the
 * secret gets loud failures on this path rather than an open endpoint that settles
 * payments on demand.
 *
 * @remarks The handler finds the payment by the id the verified payload names, applies
 * the status through the aggregate (which owns the transition table), and — only when the
 * payment settled — marks the order's invoice `paid` in the same transaction. A
 * payment that says `succeeded` while its bill still says `issued` would be a fact in
 * two tables that disagree.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { ValidationException } from '@auth/platform/error-handling';
import { verifyHmacSignature, WebhookRejectedError } from '@auth/infra/incoming-webhooks';
import {
  BILLING_REPOSITORY,
  type BillingRepositoryPort,
} from '../../domain/ports/billing-repository.port';
import { BILLING_CONFIG, type BillingConfig } from '../../billing.config';
import { Payment, isPaymentStatus } from '../../domain/payment.entity';
import {
  HandlePaymentWebhookCommand,
  type WebhookResult,
} from './billing.commands';

/**
 * The verified payload's shape.
 *
 * @remarks Minimal on purpose: the edge forwards bytes, this service decides what they
 * mean, and every field it acts on is named here once rather than sprinkled through the
 * status code as `body.data.object.status`.
 */
interface PaymentWebhookPayload {
  readonly paymentId: string;
  readonly status: string;
  readonly failureCode?: string;
}

@Injectable()
@CommandHandler(HandlePaymentWebhookCommand)
export class HandlePaymentWebhookHandler
  implements ICommandHandler<HandlePaymentWebhookCommand, WebhookResult>
{
  constructor(
    @Inject(BILLING_REPOSITORY) private readonly billing: BillingRepositoryPort,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  async execute(command: HandlePaymentWebhookCommand): Promise<WebhookResult> {
    const rawBody = command.rawBody ?? '';
    const signature = command.signature ?? '';

    // Fail-closed before anything else: no secret means no delivery is authentic, and a
    // `createHmac` over the empty string would happily "verify" a signature an attacker
    // also computed over the empty string.
    if (this.config.webhookSecret.length === 0) {
      throw new WebhookRejectedError('BILLING_WEBHOOK_SECRET is not configured');
    }

    try {
      verifyHmacSignature(
        rawBody,
        signature,
        this.config.webhookSecret,
        this.config.webhookToleranceSec,
      );
    } catch (error) {
      if (error instanceof WebhookRejectedError) throw error;
      throw new WebhookRejectedError('signature verification failed');
    }

    const payload = parsePayload(rawBody);

    const payment = await this.billing.findPaymentById(payload.paymentId);
    if (!payment) {
      // Signed but unknown: the payment id is not ours. Refused rather than ignored —
      // a signature that names nothing we hold is either a mis-routed delivery or an
      // attempt to probe for ids, and neither deserves a silent 202.
      throw new ValidationException('webhook names an unknown payment', {
        paymentId: payload.paymentId,
      });
    }

    if (!isPaymentStatus(payload.status)) {
      throw new ValidationException('webhook carries an unknown payment status', {
        paymentId: payload.paymentId,
        status: payload.status,
      });
    }

    const outcome = payment.applyProviderStatus({
      status: payload.status,
      failureCode: payload.failureCode ?? null,
    });

    if (outcome === 'duplicate') {
      return {
        outcome,
        paymentId: payment.id,
        status: payment.status,
      };
    }

    const settledInvoice =
      payment.status === 'succeeded'
        ? await this.invoiceToSettle(payment.orderId)
        : null;

    await this.billing.savePaymentUpdate({ payment, settledInvoice });

    return {
      outcome,
      paymentId: payment.id,
      status: payment.status,
    };
  }

  /**
   * The order's bill when a payment just settled — marked paid, or left alone.
   *
   * @remarks A bill already `paid` is returned as-is (nothing to announce); a `void`
   * bill is never resurrected, because a write-off is a refund decision that a late
   * success webhook must not undo.
   */
  private async invoiceToSettle(orderId: string) {
    const invoice = await this.billing.findInvoiceByOrderId(orderId);
    if (!invoice) return null;
    if (invoice.status === 'paid' || invoice.status === 'void') return null;
    invoice.markPaid();
    return invoice;
  }
}

/** Parses the verified body into the fields the status rules act on. */
function parsePayload(rawBody: string): PaymentWebhookPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new ValidationException('webhook body is not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ValidationException('webhook body must be a JSON object');
  }

  const body = parsed as Record<string, unknown>;
  const paymentId = typeof body.paymentId === 'string' ? body.paymentId.trim() : '';
  const status = typeof body.status === 'string' ? body.status.trim() : '';
  const failureCode =
    typeof body.failureCode === 'string' && body.failureCode.length > 0
      ? body.failureCode
      : undefined;

  if (paymentId.length === 0) {
    throw new ValidationException('webhook payload requires paymentId');
  }
  if (status.length === 0) {
    throw new ValidationException('webhook payload requires status');
  }

  return { paymentId, status, failureCode };
}
