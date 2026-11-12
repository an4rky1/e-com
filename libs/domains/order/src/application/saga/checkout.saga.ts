/**
 * @fileoverview The checkout saga: cart → order draft → stock → charge → clear.
 *
 * @remarks Multi-service writes cannot share a SQL transaction, so checkout is modelled as
 * forward steps plus compensating steps. Declaring the compensation explicitly is what keeps
 * "we reserved stock but never charged" from being an unrecoverable state: the reverse-order
 * undo releases the reservation and cancels the draft.
 *
 * @remarks Order of operations is deliberate: stock is reserved *before* the charge. A charge
 * with no stock would take money for goods that cannot ship, and releasing it is a refund —
 * a much harder conversation than refusing to reserve. The cart is cleared *last*, only after
 * money and stock are both committed, so a failed checkout leaves the basket intact.
 *
 * @remarks `requires_action` (3DS) is a success-shaped answer: stock stays held, the order
 * stays `pending_payment` with its `paymentId` attached, and the client completes
 * authentication out of band. It is not a failure and must not trigger compensation.
 */
import { SagaOrchestrator, type ISagaStep } from '@auth/core';
import { ValidationException } from '@auth/platform/error-handling';
import type {
  ChargeOrderRequest,
  CheckoutLines,
  ValidateForCheckoutResponse,
} from '@auth/contracts';
import { Order, OrderStatus } from '../../domain/order.aggregate';
import type {
  BillingPeerPort,
  CartPeerPort,
  InventoryPeerPort,
} from '../../domain/ports/peer-ports';
import type { OrderRepositoryPort } from '../../domain/ports/order-repository.port';

export interface CheckoutContext {
  readonly userId: string;
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly currency: string;
  readonly paymentMethodToken: string;
  readonly warehouseId: string;
  /** Fingerprint of the request payload, stored so a different payload under the same key is a conflict. */
  readonly requestFingerprint: string;
  /** Set by the snapshot step once the cart has been copied. */
  order?: Order;
  lines?: CheckoutLines;
  /** True once inventory has accepted the reservation (and the order is pending_payment). */
  reserved?: boolean;
  paymentId?: string | null;
  paymentStatus?: string;
}

/** A charge that failed is a normal business outcome, not a dependency outage. */
export class ChargeFailedError extends Error {
  override readonly name = 'ChargeFailedError';
  constructor(
    readonly status: string,
    readonly failureCode: string,
  ) {
    super(`charge failed: status=${status} failureCode=${failureCode || 'unknown'}`);
  }
}

/** Inventory refused at least one line. */
export class StockRejectedError extends Error {
  override readonly name = 'StockRejectedError';
  constructor(
    readonly rejected: readonly { sku: string; qty: number; reason: string }[],
  ) {
    super(`stock rejected for ${rejected.map((r) => `${r.sku}x${r.qty}`).join(', ')}`);
  }
}

export interface CheckoutDeps {
  readonly cart: CartPeerPort;
  readonly inventory: InventoryPeerPort;
  readonly billing: BillingPeerPort;
  readonly repository: OrderRepositoryPort;
}

/**
 * Builds the orchestrator with the four forward steps and their compensations.
 *
 * @remarks A factory rather than a shared instance so each checkout gets a fresh
 * context-bound orchestrator; a singleton would retain steps across executions.
 */
export function createCheckoutSaga(
  deps: CheckoutDeps,
): SagaOrchestrator<CheckoutContext> {
  return new SagaOrchestrator<CheckoutContext>('checkout')
    .addStep(validateCartStep(deps.cart))
    .addStep(snapshotAndPersistStep(deps))
    .addStep(reserveStockStep(deps))
    .addStep(chargeStep(deps));
}

function validateCartStep(cart: CartPeerPort): ISagaStep<CheckoutContext> {
  return {
    name: 'validate_cart',
    async execute(context) {
      const validation: ValidateForCheckoutResponse = await cart.validateForCheckout(
        context.sessionId,
        context.userId,
      );

      if (!validation.valid) {
        throw new ValidationException('cart is not valid for checkout', {
          unavailableSkus: validation.unavailableSkus,
          priceChanges: validation.priceChanges.map((change) => change.sku),
        });
      }

      return context;
    },
    async compensate(context) {
      // Nothing was written yet.
      return context;
    },
  };
}

function snapshotAndPersistStep(deps: CheckoutDeps): ISagaStep<CheckoutContext> {
  return {
    name: 'snapshot_and_persist',
    async execute(context) {
      const lines = await deps.cart.getCheckoutLines(context.sessionId, context.userId);

      if (!lines.lines || lines.lines.length === 0) {
        throw new ValidationException('cart is empty', { sessionId: context.sessionId });
      }

      const currency = context.currency || lines.currency;
      const order = Order.create({
        userId: context.userId,
        sessionId: context.sessionId,
        currency,
        lines: lines.lines.map((line) => ({
          sku: line.sku,
          productId: line.productId,
          name: line.name,
          quantity: line.quantity,
          unitPriceMinor: Number(line.unitPrice.amountMinor),
        })),
        idempotencyKey: context.idempotencyKey,
        requestFingerprint: context.requestFingerprint,
      });

      await deps.repository.save(order);

      return { ...context, order, lines };
    },
    async compensate(context) {
      // Runs after reserve_stock's compensate (reverse order), so stock is already
      // released by the time we get here. Cancels anything that never reached `paid`:
      // a draft rejected by inventory, or a pending_payment whose charge failed.
      // `paid`/`confirmed` are left alone — money moved and must not be silently undone
      // by a compensation path (that is cancel's job, with an explicit refund).
      const status = context.order?.status;
      if (
        context.order &&
        status !== OrderStatus.PAID &&
        status !== OrderStatus.CONFIRMED &&
        status !== OrderStatus.CANCELED
      ) {
        context.order.cancel('checkout_compensated');
        await deps.repository.save(context.order);
      }
      return context;
    },
  };
}

function reserveStockStep(deps: CheckoutDeps): ISagaStep<CheckoutContext> {
  return {
    name: 'reserve_stock',
    async execute(context) {
      if (!context.order) throw new Error('reserve_stock requires an order');

      const response = await deps.inventory.reserve(
        context.order.id,
        context.order.lines.map((line) => ({ sku: line.sku, qty: line.quantity })),
        context.warehouseId,
      );

      if (!response.fullyAccepted) {
        throw new StockRejectedError(response.rejected ?? []);
      }

      context.order.markPendingPayment();
      await deps.repository.save(context.order);

      return { ...context, reserved: true };
    },
    async compensate(context) {
      if (!context.reserved || !context.order) return context;

      // Idempotent by contract: a release for an order with nothing reserved answers
      // `releasedLines: 0` and changes nothing.
      await deps.inventory.release(context.order.id, context.warehouseId);
      return { ...context, reserved: false };
    },
  };
}

function chargeStep(deps: CheckoutDeps): ISagaStep<CheckoutContext> {
  return {
    name: 'charge',
    async execute(context) {
      const order = context.order;
      if (!order) throw new Error('charge requires an order');

      const request: ChargeOrderRequest = {
        orderId: order.id,
        // Business-derived, never a randomUUID: billing keys its own idempotency on it.
        idempotencyKey: `order:${order.id}:charge:1`,
        amount: {
          amountMinor: String(order.totalMinor),
          currency: order.currency,
        },
        paymentMethodToken: context.paymentMethodToken,
        customerId: order.userId,
        lines: order.lines.map((line) => ({
          sku: line.sku,
          quantity: line.quantity,
          unitPrice: {
            amountMinor: String(line.unitPriceMinor),
            currency: order.currency,
          },
        })),
        customerCountry: '',
      };

      const response = await deps.billing.charge(request);

      if (response.status === 'failed') {
        throw new ChargeFailedError(response.status, response.failureCode ?? '');
      }

      if (response.status === 'succeeded') {
        order.markPaid(response.paymentId);
        await deps.repository.save(order);
        return {
          ...context,
          paymentId: response.paymentId,
          paymentStatus: response.status,
        };
      }

      // requires_action | processing | any other non-failed status: stock stays held, the
      // order stays pending_payment with its payment reference attached. Not a failure —
      // no compensation, and no `order.paid` event for money that has not settled.
      order.attachPaymentId(response.paymentId);
      await deps.repository.save(order);

      return {
        ...context,
        paymentId: response.paymentId,
        paymentStatus: response.status,
      };
    },
    async compensate(context) {
      // The charge is idempotent per business key; a failed charge left no money. Stock
      // release is reserve_stock's compensate, which runs after this one in reverse order.
      return context;
    },
  };
}

/**
 * Runs the full checkout and clears the cart on success.
 *
 * @remarks Cart clearing happens outside the orchestrator on purpose: it is the last action,
 * it is idempotent, and a failure to clear must not roll back a successful charge — an empty
 * basket is a convenience, a double charge is not.
 *
 * @remarks A `requires_action` / `processing` outcome still clears the cart: stock is held
 * and a payment reference exists, so the basket has done its job; leaving it full would let
 * the shopper check out the same lines twice against one reservation.
 */
export async function runCheckout(
  deps: CheckoutDeps,
  context: CheckoutContext,
): Promise<CheckoutContext> {
  const result = await createCheckoutSaga(deps).execute(context);

  try {
    await deps.cart.clearCart(context.sessionId, context.userId);
  } catch {
    // Swallowed deliberately: the order already exists and stock/money are committed.
    // The next GetCheckoutLines re-validates whatever the basket still holds.
  }

  return result;
}
