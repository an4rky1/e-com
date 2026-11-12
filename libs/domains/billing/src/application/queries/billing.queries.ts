/**
 * @fileoverview What a reader asks billing: one bill, or a preview of one.
 *
 * @remarks Like every query in this workspace it is a class: `QueryBus.execute` resolves a
 * handler from `query.constructor`, and a plain object cannot dispatch.
 *
 * @remarks `PreviewTotalsQuery` is deliberately stateless — it has no order id, because
 * `invoices.order_id` is unique and a preview is not yet an order's bill. It computes
 * what a charge *would* cost, using the same {@link computeTotals} the charge path
 * reconciles against, which is the only way a storefront's displayed price and the money
 * actually taken can be guaranteed to agree.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Query, QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { ResourceNotFoundException, ValidationException } from '@auth/platform/error-handling';
import {
  BILLING_REPOSITORY,
  type BillingRepositoryPort,
} from '../../domain/ports/billing-repository.port';
import { BILLING_CONFIG, taxRateFor, type BillingConfig } from '../../billing.config';
import type { Invoice } from '../../domain/invoice.entity';
import { computeTotals, type ComputedTotals, type TotalsLineInput } from '../../domain/totals';

export class GetInvoiceQuery extends Query<Invoice> {
  readonly queryId: string = crypto.randomUUID();

  constructor(readonly orderId: string) {
    super();
  }
}

export class PreviewTotalsQuery extends Query<ComputedTotals> {
  readonly queryId: string = crypto.randomUUID();

  constructor(
    readonly lines: readonly TotalsLineInput[],
    readonly currency: string,
    readonly customerCountry?: string,
    readonly couponCode?: string,
  ) {
    super();
  }
}

@Injectable()
@QueryHandler(GetInvoiceQuery)
export class GetInvoiceHandler implements IQueryHandler<GetInvoiceQuery, Invoice> {
  constructor(
    @Inject(BILLING_REPOSITORY) private readonly billing: BillingRepositoryPort,
  ) {}

  async execute(query: GetInvoiceQuery): Promise<Invoice> {
    const orderId = query.orderId?.trim() ?? '';
    if (orderId.length === 0) {
      throw new ValidationException('orderId is required', { orderId });
    }

    const invoice = await this.billing.findInvoiceByOrderId(orderId);
    if (!invoice) {
      // An order that was never billed has no bill — a 404, not an empty invoice: an
      // empty one would render as "total 0.00" and read as a free order.
      throw new ResourceNotFoundException('invoice not found', { orderId });
    }

    return invoice;
  }
}

@Injectable()
@QueryHandler(PreviewTotalsQuery)
export class PreviewTotalsHandler
  implements IQueryHandler<PreviewTotalsQuery, ComputedTotals>
{
  constructor(
    @Inject(BILLING_REPOSITORY) private readonly billing: BillingRepositoryPort,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  async execute(query: PreviewTotalsQuery): Promise<ComputedTotals> {
    let coupon: { code: string; percentOff: number } | undefined;

    const requestedCode = query.couponCode?.trim() ?? '';
    if (requestedCode.length > 0) {
      const found = await this.billing.findCoupon(requestedCode);
      // Refused rather than ignored: a storefront that displays a discount the service
      // will not honour is a checkout that fails at the last step, or — worse — a price
      // that changes under the customer.
      if (!found || !found.active) {
        throw new ValidationException('coupon is unknown or inactive', {
          couponCode: requestedCode,
        });
      }
      coupon = { code: found.code, percentOff: found.percentOff };
    }

    return computeTotals({
      lines: query.lines,
      currency: query.currency,
      taxRateBps: taxRateFor(this.config, query.customerCountry),
      coupon,
    });
  }
}
