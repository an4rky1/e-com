/**
 * @fileoverview The payment-service-provider port.
 *
 * @remarks Declared in the domain so the charge path can be tested without a network and
 * without a fake that lives in `spec/`: the decision "which adapter answers a charge" is
 * configuration, while the rules about *when* a charge may happen, what it may cost and
 * what it announces belong to the aggregates.
 *
 * @remarks The port speaks the provider's vocabulary (`provider_ref`, `next_action`)
 * rather than the database's: an adapter's job is to translate between a PSP and this
 * service, and a `payments` column name leaking in here would make a second adapter
 * implement persistence it does not own.
 */
import type { PaymentStatus } from '../payment.entity';

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/** Where the client should be sent to finish an interactive challenge (3DS and friends). */
export interface ProviderNextAction {
  readonly type: string;
  readonly redirectUrl: string;
  readonly sdkPayload: string;
}

export interface ProviderChargeInput {
  readonly orderId: string;
  readonly amountMinor: number;
  readonly currency: string;
  /** Opaque token from the client-side SDK. Card numbers never reach this service. */
  readonly paymentMethodToken: string;
  readonly customerId: string;
}

export interface ProviderChargeResult {
  /** The provider's own id for the attempt (`psp_ch_…`). */
  readonly providerRef: string;
  readonly status: PaymentStatus;
  readonly failureCode?: string;
  /** Present exactly when `status` is `requires_action`. */
  readonly nextAction?: ProviderNextAction;
}

export interface ProviderRefundInput {
  readonly providerRef: string;
  readonly orderId: string;
  readonly amountMinor: number;
  readonly currency: string;
}

export interface ProviderRefundResult {
  readonly providerRef: string;
  /** The provider's refund status; `succeeded` for the fake adapter. */
  readonly status: string;
}

export interface PaymentProviderPort {
  /** Lower-case provider name, stored on `payments.provider`. */
  readonly provider: string;

  charge(input: ProviderChargeInput): Promise<ProviderChargeResult>;

  refund(input: ProviderRefundInput): Promise<ProviderRefundResult>;
}
