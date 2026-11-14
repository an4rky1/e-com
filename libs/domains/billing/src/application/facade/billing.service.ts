/**
 * @fileoverview The only public surface of the billing module.
 *
 * @remarks Everything that talks to this service — the gRPC controller, a future saga, a
 * test in another lib — depends on this class and nothing else. It therefore cannot reach
 * the repository, the provider or the aggregates, which is what makes the module's
 * internals replaceable without touching a single caller.
 *
 * @remarks It speaks in domain results, never in proto messages: the transport shape
 * belongs to the presentation layer, and a second copy of it here would be a second thing
 * to keep in step with `billing.proto`.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  ChargeOrderCommand,
  HandlePaymentWebhookCommand,
  RefundOrderCommand,
  type ChargeLineInput,
  type ChargeResult,
  type RefundResult,
  type WebhookResult,
} from '../commands/billing.commands';
import type { Invoice } from '../../domain/invoice.entity';
import type { ComputedTotals, TotalsLineInput } from '../../domain/totals';
import { GetInvoiceQuery, PreviewTotalsQuery } from '../queries/billing.queries';

@Injectable()
export class BillingService {
  constructor(
    // Explicit tokens rather than relying on `design:paramtypes`: a type-only import is
    // erased before the decorator metadata is emitted, so the parameter would arrive as
    // `Object` and the container would have nothing to resolve it against.
    @Inject(CommandBus) private readonly commandBus: CommandBus,
    @Inject(QueryBus) private readonly queryBus: QueryBus,
  ) {}

  /**
   * Charges an order once per idempotency key.
   *
   * @remarks A retry for the same key answers with the payment it already made — see
   * {@link ChargeResult.replayed} for how a caller tells the two apart in a log.
   */
  charge(input: {
    orderId: string;
    idempotencyKey: string;
    amountMinor: number;
    currency: string;
    paymentMethodToken: string;
    customerId: string;
    lines: readonly ChargeLineInput[];
    customerCountry?: string;
    couponCode?: string;
  }): Promise<ChargeResult> {
    return this.commandBus.execute(
      new ChargeOrderCommand(
        input.orderId,
        input.idempotencyKey,
        input.amountMinor,
        input.currency,
        input.paymentMethodToken,
        input.customerId,
        input.lines,
        input.customerCountry,
        input.couponCode,
      ),
    );
  }

  /** Returns money against a payment. Repeating the same key changes nothing. */
  refund(input: {
    orderId: string;
    paymentId: string;
    idempotencyKey: string;
    reason: string;
    amountMinor?: number;
  }): Promise<RefundResult> {
    return this.commandBus.execute(
      new RefundOrderCommand(
        input.orderId,
        input.paymentId,
        input.idempotencyKey,
        input.reason,
        input.amountMinor,
      ),
    );
  }

  /**
   * Applies one provider webhook: verifies the signature over the raw body, then moves
   * the payment to the status the provider reported.
   *
   * @remarks Idempotent by status — a redelivery whose status already matches answers
   * `duplicate` without a write, so a provider retrying until it sees a 2xx cannot
   * bump `version` or re-announce a settled payment.
   */
  handlePaymentWebhook(input: { rawBody: string; signature: string }): Promise<WebhookResult> {
    return this.commandBus.execute(
      new HandlePaymentWebhookCommand(input.rawBody, input.signature),
    );
  }

  /** The order's bill. Fails when the order was never billed. */
  getInvoice(orderId: string): Promise<Invoice> {
    return this.queryBus.execute(new GetInvoiceQuery(orderId));
  }

  /**
   * What a charge would cost, without writing anything.
   *
   * @remarks The same computation the charge path reconciles against, so a preview that
   * says `10.00` and a charge that takes `10.19` cannot both come from this service.
   */
  previewTotals(input: {
    lines: readonly TotalsLineInput[];
    currency: string;
    customerCountry?: string;
    couponCode?: string;
  }): Promise<ComputedTotals> {
    return this.queryBus.execute(
      new PreviewTotalsQuery(
        input.lines,
        input.currency,
        input.customerCountry,
        input.couponCode,
      ),
    );
  }
}
