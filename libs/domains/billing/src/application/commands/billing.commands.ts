/**
 * @fileoverview Commands for the money path, and the results they return.
 *
 * @remarks A command is an intent, not a DTO: it carries the caller's *decision*, while
 * the transport shape stays in the presentation layer. Keeping them apart means renaming
 * a proto field never reaches the domain.
 *
 * @remarks Classes, not interfaces. `CommandBus.execute` resolves a handler from
 * `command.constructor`, and `@CommandHandler` reads its metadata off the class it is
 * given — a plain object literal cannot dispatch at all.
 *
 * @remarks Money arrives here as an integer of minor units: `ShopMoney`'s string form is
 * a wire concern, and parsing it once in the presentation layer means the handlers never
 * see a value they could accidentally coerce.
 */
import { Command } from '@nestjs/cqrs';
import type { ProviderNextAction } from '../../domain/ports/payment-provider.port';

/** One line of a charge, already parsed into minor units. */
export interface ChargeLineInput {
  readonly sku: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
}

export interface ChargeResult {
  readonly paymentId: string;
  /** `requires_payment_method` | `requires_action` | `processing` | `succeeded` | `failed`. */
  readonly status: string;
  /** Present exactly when `status` is `requires_action`. */
  readonly nextAction?: ProviderNextAction;
  readonly failureCode: string;
  /**
   * `true` when an existing payment for this idempotency key answered the call.
   *
   * @remarks Lets a caller tell "your retry landed on the charge you already made" apart
   * from "we just charged this" — the two look identical on the wire and mean different
   * things in a log.
   */
  readonly replayed: boolean;
}

export interface RefundResult {
  readonly refundId: string;
  readonly status: string;
  /** The payment's cumulative refunded total *after* this refund, in minor units. */
  readonly refundedTotalMinor: number;
  readonly currency: string;
  readonly replayed: boolean;
}

/**
 * Charges an order once per `idempotencyKey`.
 *
 * @remarks `amountMinor` must equal what the lines recompute to — tax and shipping
 * included, coupon applied when one was named. The mismatch check is what makes "the
 * amount cannot be reconciled against its own lines" impossible to store.
 */
export class ChargeOrderCommand extends Command<ChargeResult> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly orderId: string,
    readonly idempotencyKey: string,
    readonly amountMinor: number,
    readonly currency: string,
    readonly paymentMethodToken: string,
    readonly customerId: string,
    readonly lines: readonly ChargeLineInput[],
    readonly customerCountry?: string,
    readonly couponCode?: string,
  ) {
    super();
  }
}

/**
 * Returns money against a payment, once per `idempotencyKey`.
 *
 * @remarks An empty `amountMinor` means "everything that is left", which is the full
 * refund every cancel path asks for; a partial amount is checked against the remaining
 * balance by the handler, never clamped.
 */
export class RefundOrderCommand extends Command<RefundResult> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly orderId: string,
    readonly paymentId: string,
    readonly idempotencyKey: string,
    readonly reason: string,
    readonly amountMinor?: number,
  ) {
    super();
  }
}

/** What a verified webhook delivery did. */
export interface WebhookResult {
  /** `applied` — status moved; `duplicate` — already there, nothing written. */
  readonly outcome: 'applied' | 'duplicate';
  readonly paymentId: string;
  readonly status: string;
}

/**
 * Applies one provider webhook: verify the signature over the raw body, then move the
 * payment to the status the provider reported.
 *
 * @remarks The raw body and signature arrive together and are verified before any parse:
 * a payload that has not been authenticated must never reach the status rules, or an
 * attacker who can hit the endpoint can settle any payment they can name.
 *
 * @remarks Idempotent by status, not by event id: a redelivery whose status already
 * matches answers `duplicate` without a write, so a provider retrying until it sees a
 * 2xx cannot bump `version` or re-announce a settled payment.
 */
export class HandlePaymentWebhookCommand extends Command<WebhookResult> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly rawBody: string,
    readonly signature: string,
  ) {
    super();
  }
}
