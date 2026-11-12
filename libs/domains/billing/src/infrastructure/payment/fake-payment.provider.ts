/**
 * @fileoverview The payment-service-provider adapter used when `BILLING_PSP_PROVIDER` is
 * `fake`.
 *
 * @remarks Instrument-driven rather than random: a test that needs a declined charge must
 * be able to *ask* for one, and a test that needs a success must be able to rely on it.
 * Random outcomes would make every suite flaky and would make the interesting paths —
 * decline, 3DS — the ones that almost never run.
 *
 * @remarks The token vocabulary is the client-side SDK's: `pm_decline…` and
 * `pm_requires_action…` are what a storefront's test fixtures send, and card numbers
 * never reach this service at all. An unknown token succeeds, because the default
 * instrument in every checkout fixture is a plain card.
 */
import type {
  PaymentProviderPort,
  ProviderChargeInput,
  ProviderChargeResult,
  ProviderRefundInput,
  ProviderRefundResult,
} from '../../domain/ports/payment-provider.port';

/** Token prefix that makes a charge fail, as the client-side SDK spells it. */
export const DECLINE_TOKEN_PREFIX = 'pm_decline';

/** Token prefix that makes a charge require a customer challenge (3DS). */
export const REQUIRES_ACTION_TOKEN_PREFIX = 'pm_requires_action';

export class FakePaymentProvider implements PaymentProviderPort {
  readonly provider = 'fake';

  /**
   * Every call this adapter received, in order.
   *
   * @remarks Recorded because the fake's other job is proving a *retried* charge or
   * refund never reaches it: a suite that only checked the stored row could not tell
   * "answered from the ledger" from "asked the provider twice and got the same answer".
   */
  readonly charges: ProviderChargeInput[] = [];
  readonly refunds: ProviderRefundInput[] = [];

  async charge(input: ProviderChargeInput): Promise<ProviderChargeResult> {
    this.charges.push(input);
    const token = input.paymentMethodToken ?? '';

    if (token.startsWith(DECLINE_TOKEN_PREFIX)) {
      return {
        providerRef: `psp_ch_${crypto.randomUUID()}`,
        status: 'failed',
        failureCode: 'card_declined',
      };
    }

    if (token.startsWith(REQUIRES_ACTION_TOKEN_PREFIX)) {
      // A challenge is a success-shaped answer, not an error: the charge is still in
      // flight and the caller shows a redirect rather than a failure.
      return {
        providerRef: `psp_ch_${crypto.randomUUID()}`,
        status: 'requires_action',
        nextAction: {
          type: 'redirect',
          redirectUrl: `https://psp.test/3ds/${encodeURIComponent(input.orderId)}`,
          sdkPayload: '',
        },
      };
    }

    return {
      providerRef: `psp_ch_${crypto.randomUUID()}`,
      status: 'succeeded',
    };
  }

  async refund(input: ProviderRefundInput): Promise<ProviderRefundResult> {
    this.refunds.push(input);
    // The fake never refuses a refund: refusal belongs to the balance check in the
    // handler, which runs against the ledger before this adapter is ever reached.
    return {
      providerRef: `psp_rf_${crypto.randomUUID()}`,
      status: 'succeeded',
    };
  }
}

/**
 * Builds the adapter the resolved configuration names.
 *
 * @remarks The switch is exhaustive over {@link BillingConfig.pspProvider}'s union, so
 * adding a provider to the config without an adapter is a compile error rather than a
 * charge that silently goes nowhere.
 */
export function createPaymentProvider(name: 'fake'): PaymentProviderPort {
  switch (name) {
    case 'fake':
      return new FakePaymentProvider();
  }
}
