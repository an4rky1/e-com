/**
 * @fileoverview gRPC transport for billing, implementing `BillingGrpcClient` server-side.
 *
 * @remarks It extends {@link GrpcControllerBase} because `mergeMicroservice` requires a
 * controller with no HTTP routes; deriving from it keeps that invariant from being
 * forgotten when a method is added.
 *
 * @remarks **Its own `@Controller()` is mandatory.** `emitDecoratorMetadata` does not
 * inherit across class inheritance: a subclass with no decorator of its own gets no
 * `design:paramtypes`, so Nest constructs it with zero arguments, the service boots
 * cleanly and the first request fails on an `undefined` facade.
 *
 * @remarks The controller translates and nothing else — and money is where "translates"
 * is most literal: `ShopMoney`'s string form is parsed to minor units on the way in and
 * formatted on the way out, so every rule about amounts lives once, in the domain.
 */
import { Controller } from '@nestjs/common';
import { GrpcControllerBase, GrpcMethod } from '@auth/infra/grpc';
import type {
  ChargeOrderRequest,
  ChargeOrderResponse,
  HandlePaymentWebhookRequest,
  HandlePaymentWebhookResponse,
  InvoiceView,
  PreviewTotalsRequest,
  PreviewTotalsResponse,
  RefundOrderRequest,
  RefundOrderResponse,
} from '@auth/contracts';
// Value import on purpose — see the note in `session.grpc.controller.ts`.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { BillingService } from '../../application/facade/billing.service';
import type { Invoice } from '../../domain/invoice.entity';
import type { ComputedTotals } from '../../domain/totals';
import { parseShopMoney, toShopMoney } from '../money';

/** Service name exactly as `libs/contracts/proto/billing.proto` declares it. */
const SERVICE = 'BillingService';

@Controller()
export class BillingGrpcController extends GrpcControllerBase {
  constructor(private readonly billing: BillingService) {
    super();
  }

  @GrpcMethod(SERVICE, 'ChargeOrder')
  async chargeOrder(request: ChargeOrderRequest): Promise<ChargeOrderResponse> {
    const amountMinor = parseShopMoney(request.amount, 'amount');

    const result = await this.billing.charge({
      orderId: request.orderId,
      idempotencyKey: request.idempotencyKey,
      amountMinor,
      currency: request.amount?.currency ?? '',
      paymentMethodToken: request.paymentMethodToken ?? '',
      customerId: request.customerId ?? '',
      lines: (request.lines ?? []).map((line, index) => ({
        sku: line.sku ?? '',
        quantity: line.quantity ?? 0,
        unitPriceMinor: parseShopMoney(line.unitPrice, `lines[${index}].unitPrice`),
      })),
      customerCountry: request.customerCountry,
      couponCode: request.couponCode,
    });

    return {
      paymentId: result.paymentId,
      status: result.status,
      // Absent when the provider did not ask for a challenge: an empty message would
      // render as a next action of `type: ""` and a client would show an empty redirect.
      nextAction: result.nextAction
        ? {
            type: result.nextAction.type,
            redirectUrl: result.nextAction.redirectUrl,
            sdkPayload: result.nextAction.sdkPayload,
          }
        : undefined,
      failureCode: result.failureCode,
    };
  }

  @GrpcMethod(SERVICE, 'RefundOrder')
  async refundOrder(request: RefundOrderRequest): Promise<RefundOrderResponse> {
    // proto3 gives an omitted message its own default instance, so "empty" arrives as an
    // empty string rather than as `undefined`. The contract says empty means full refund.
    const rawAmount = request.amount?.amountMinor?.trim() ?? '';
    const amountMinor = rawAmount.length > 0 ? parseShopMoney(request.amount, 'amount') : undefined;

    const result = await this.billing.refund({
      orderId: request.orderId,
      paymentId: request.paymentId,
      idempotencyKey: request.idempotencyKey,
      reason: request.reason ?? '',
      amountMinor,
    });

    return {
      refundId: result.refundId,
      status: result.status,
      refundedTotal: toShopMoney(result.refundedTotalMinor, result.currency),
    };
  }

  @GrpcMethod(SERVICE, 'GetInvoice')
  async getInvoice(request: { orderId: string }): Promise<InvoiceView> {
    const invoice = await this.billing.getInvoice(request.orderId);
    return invoiceToView(invoice);
  }

  @GrpcMethod(SERVICE, 'PreviewTotals')
  async previewTotals(request: PreviewTotalsRequest): Promise<PreviewTotalsResponse> {
    const totals = await this.billing.previewTotals({
      lines: (request.lines ?? []).map((line, index) => ({
        sku: line.sku ?? '',
        quantity: line.quantity ?? 0,
        unitPriceMinor: parseShopMoney(line.unitPrice, `lines[${index}].unitPrice`),
      })),
      currency: request.currency ?? '',
      customerCountry: request.customerCountry,
      couponCode: request.couponCode,
    });

    return { invoice: previewToView(totals, request.couponCode) };
  }

  /**
   * Applies a provider webhook.
   *
   * @remarks The raw body and signature are forwarded unread: this layer translates, it
   * does not decide authenticity — the handler verifies the HMAC over the exact bytes the
   * provider signed, before any parse.
   */
  @GrpcMethod(SERVICE, 'HandlePaymentWebhook')
  async handlePaymentWebhook(
    request: HandlePaymentWebhookRequest,
  ): Promise<HandlePaymentWebhookResponse> {
    const result = await this.billing.handlePaymentWebhook({
      rawBody: request.rawBody ?? '',
      signature: request.signature ?? '',
    });

    return {
      outcome: result.outcome,
      paymentId: result.paymentId,
      status: result.status,
    };
  }
}

/** A stored bill, formatted the way the wire spells money. */
function invoiceToView(invoice: Invoice): InvoiceView {
  const currency = invoice.currency;

  return {
    invoiceId: invoice.id,
    orderId: invoice.orderId,
    status: invoice.status,
    lines: invoice.lines.map((line) => ({
      sku: line.sku,
      quantity: line.quantity,
      unitPrice: toShopMoney(line.unitPriceMinor, currency),
      lineSubtotal: toShopMoney(line.lineSubtotalMinor, currency),
      tax: toShopMoney(line.taxMinor, currency),
    })),
    subtotal: toShopMoney(invoice.subtotalMinor, currency),
    discount: toShopMoney(invoice.discountMinor, currency),
    taxTotal: toShopMoney(invoice.taxMinor, currency),
    shipping: toShopMoney(invoice.shippingMinor, currency),
    total: toShopMoney(invoice.totalMinor, currency),
    currency,
    couponCode: invoice.couponCode ?? '',
    issuedAt: invoice.issuedAt ? invoice.issuedAt.toISOString() : '',
  };
}

/**
 * A computation, dressed as the bill it would become.
 *
 * @remarks `invoiceId` and `orderId` are empty and the status is `draft` because nothing
 * was written: a preview that carried an id would look like a stored bill to anything
 * that logged it.
 */
function previewToView(totals: ComputedTotals, requestedCoupon?: string): InvoiceView {
  const couponCode = totals.discountMinor > 0 ? (requestedCoupon ?? '').trim() : '';

  return {
    invoiceId: '',
    orderId: '',
    status: 'draft',
    lines: totals.lines.map((line) => ({
      sku: line.sku,
      quantity: line.quantity,
      unitPrice: toShopMoney(line.unitPriceMinor, totals.currency),
      lineSubtotal: toShopMoney(line.lineSubtotalMinor, totals.currency),
      tax: toShopMoney(line.taxMinor, totals.currency),
    })),
    subtotal: toShopMoney(totals.subtotalMinor, totals.currency),
    discount: toShopMoney(totals.discountMinor, totals.currency),
    taxTotal: toShopMoney(totals.taxMinor, totals.currency),
    shipping: toShopMoney(totals.shippingMinor, totals.currency),
    total: toShopMoney(totals.totalMinor, totals.currency),
    currency: totals.currency,
    couponCode,
    issuedAt: '',
  };
}
