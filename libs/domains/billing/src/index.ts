/**
 * @fileoverview The public surface of the billing domain.
 *
 * @remarks The barrel is deliberately explicit rather than `export *`: a consumer
 * importing from here should be able to see, in one screen, the whole contract this
 * service offers — and a wildcard would quietly widen it every time a helper is added
 * under `src/`.
 *
 * @remarks Three audiences. {@link BillingService} is what an application calls; the
 * controller and the module factory are what `apps/billing` wires; everything else
 * exists so a test in another service can assert against the same rules.
 */

// ---- configuration -------------------------------------------------------------
export {
  BILLING_CONFIG,
  BILLING_PRISMA,
  Defaults as BillingDefaults,
  KNOWN_PSP_PROVIDERS,
  billingSchema,
  resolveBillingConfig,
  taxRateFor,
  type BillingConfig,
  type BillingEnvConfig,
  type PspProviderName,
} from './billing.config';

// ---- module --------------------------------------------------------------------
export {
  BILLING_MODULE_OPTIONS,
  BillingModule,
  createBillingModule,
  type BillingModuleOptions,
} from './billing.module';
export { BillingHealthIndicator } from './billing.health';

// ---- commands ------------------------------------------------------------------
export {
  ChargeOrderCommand,
  HandlePaymentWebhookCommand,
  RefundOrderCommand,
  type ChargeLineInput,
  type ChargeResult,
  type RefundResult,
  type WebhookResult,
} from './application/commands/billing.commands';
export { ChargeOrderHandler } from './application/commands/charge-order.handler';
export { RefundOrderHandler } from './application/commands/refund-order.handler';
export { HandlePaymentWebhookHandler } from './application/commands/handle-payment-webhook.handler';

// ---- queries -------------------------------------------------------------------
export {
  GetInvoiceHandler,
  GetInvoiceQuery,
  PreviewTotalsHandler,
  PreviewTotalsQuery,
} from './application/queries/billing.queries';

// ---- application ---------------------------------------------------------------
export { BillingService } from './application/facade/billing.service';

// ---- domain --------------------------------------------------------------------
export {
  Payment,
  REFUNDABLE_PAYMENT_STATUSES,
  isPaymentStatus,
  type PaymentProps,
  type PaymentRow,
  type PaymentStatus,
  type WebhookApplyOutcome,
} from './domain/payment.entity';
export {
  Invoice,
  TERMINAL_INVOICE_STATUSES,
  isInvoiceStatus,
  type InvoiceLine,
  type InvoiceLineRow,
  type InvoiceProps,
  type InvoiceRow,
  type InvoiceStatus,
} from './domain/invoice.entity';
export { Refund, type RefundProps, type RefundRow } from './domain/refund.entity';
export {
  INVOICE_AGGREGATE,
  PAYMENT_AGGREGATE,
  InvoiceIssued,
  PaymentFailed,
  PaymentRefunded,
  PaymentSucceeded,
} from './domain/billing.events';
export {
  computeTotals,
  type ComputedLine,
  type ComputedTotals,
  type ComputeTotalsInput,
  type CouponInput,
  type TotalsLineInput,
} from './domain/totals';
export {
  BILLING_REPOSITORY,
  type BillingRepositoryPort,
  type Coupon,
  type SaveChargeInput,
  type SavePaymentUpdateInput,
  type SaveRefundInput,
} from './domain/ports/billing-repository.port';
export {
  PAYMENT_PROVIDER,
  type PaymentProviderPort,
  type ProviderChargeInput,
  type ProviderChargeResult,
  type ProviderNextAction,
  type ProviderRefundInput,
  type ProviderRefundResult,
} from './domain/ports/payment-provider.port';

// ---- presentation --------------------------------------------------------------
export { BillingGrpcController } from './presentation/grpc/billing.grpc.controller';
export { parseShopMoney, toShopMoney } from './presentation/money';

// ---- infrastructure ------------------------------------------------------------
export { PrismaBillingRepository } from './infrastructure/persistence/prisma-billing.repository';
export {
  enqueueEvents,
  type EnqueueEventsOptions,
} from './infrastructure/persistence/outbox-enqueue';
export {
  DECLINE_TOKEN_PREFIX,
  FakePaymentProvider,
  REQUIRES_ACTION_TOKEN_PREFIX,
  createPaymentProvider,
} from './infrastructure/payment/fake-payment.provider';
