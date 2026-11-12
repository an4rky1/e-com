/**
 * @fileoverview The cancel saga: refund (if charged) → release stock → cancel order.
 *
 * @remarks The reverse of checkout's forward steps, run only for statuses that actually
 * took those steps. A `draft` cancel touches nothing but the order row; a `paid` cancel
 * refunds first (money is harder to unwind than stock) and then releases the reservation.
 *
 * @remarks Every peer call here is idempotent by contract, so a retried cancel — or a
 * cancel that half-failed and is being finished by an operator — converges instead of
 * double-refunding or double-releasing.
 *
 * @remarks A `pending_payment` order whose charge returned `requires_action` is *not*
 * refunded: no money has settled, so there is nothing to return. The payment reference
 * stays on the row for the PSP to expire or the client to abandon; stock is still
 * released and the order still cancels.
 */
import { SagaOrchestrator, type ISagaStep } from '@auth/core';
import {
  Order,
  mayBeCharged,
  isStockHeld,
} from '../../domain/order.aggregate';
import type {
  BillingPeerPort,
  InventoryPeerPort,
} from '../../domain/ports/peer-ports';
import type { OrderRepositoryPort } from '../../domain/ports/order-repository.port';

export interface CancelContext {
  readonly reason: string;
  readonly warehouseId: string;
  readonly order: Order;
  /** True once a refund was attempted for this cancel (so a retry knows). */
  refunded?: boolean;
  /** True once stock release was attempted. */
  released?: boolean;
}

export interface CancelDeps {
  readonly inventory: InventoryPeerPort;
  readonly billing: BillingPeerPort;
  readonly repository: OrderRepositoryPort;
}

/**
 * Builds the cancel orchestrator.
 *
 * @remarks Steps are always registered; each one no-ops when the order's status says the
 * corresponding forward step never ran. That keeps one code path for every cancelable
 * status instead of four near-identical branches.
 */
export function createCancelSaga(deps: CancelDeps): SagaOrchestrator<CancelContext> {
  return new SagaOrchestrator<CancelContext>('cancel')
    .addStep(refundStep(deps))
    .addStep(releaseStockStep(deps))
    .addStep(markCanceledStep(deps));
}

function refundStep(deps: CancelDeps): ISagaStep<CancelContext> {
  return {
    name: 'refund',
    async execute(context) {
      const { order } = context;
      // Only a settled charge is refunded. `pending_payment` with a payment reference
      // means 3DS/processing — no money has moved, so a refund would be inventing one.
      if (!mayBeCharged(order.status) || !order.paymentId) return context;

      await deps.billing.refund({
        orderId: order.id,
        paymentId: order.paymentId,
        // Empty amount means a full refund — the proto's own convention.
        amount: undefined,
        reason: context.reason || 'order_canceled',
        // Business-derived key: billing's idempotency makes a retried cancel answer with
        // the same refund instead of a second one.
        idempotencyKey: `order:${order.id}:cancel-refund:1`,
      });

      return { ...context, refunded: true };
    },
    async compensate(context) {
      // Refunds are not auto-reversed: a cancel that later fails at markCanceled still
      // leaves the money returned, which is the safer default (never keep money for an
      // order the operator meant to kill). Manual re-charge is an operator action.
      return context;
    },
  };
}

function releaseStockStep(deps: CancelDeps): ISagaStep<CancelContext> {
  return {
    name: 'release_stock',
    async execute(context) {
      if (!isStockHeld(context.order.status)) return context;

      // Idempotent by contract: nothing reserved answers `releasedLines: 0`.
      await deps.inventory.release(context.order.id, context.warehouseId);
      return { ...context, released: true };
    },
    async compensate(context) {
      // Re-reserving on a failed cancel would need the original line set and could fail
      // on availability; a cancel that got this far is finishing, not rolling back.
      return context;
    },
  };
}

function markCanceledStep(deps: CancelDeps): ISagaStep<CancelContext> {
  return {
    name: 'mark_canceled',
    async execute(context) {
      context.order.cancel(context.reason);
      await deps.repository.save(context.order);
      return context;
    },
    async compensate(context) {
      // The status change is the last step; if it failed the order is still cancelable
      // and a retry starts the saga from the top (every peer call is idempotent).
      return context;
    },
  };
}

/** Runs the cancel saga for an already-loaded order. */
export async function runCancel(
  deps: CancelDeps,
  order: Order,
  reason: string,
  warehouseId: string,
): Promise<Order> {
  const context = await createCancelSaga(deps).execute({
    reason,
    warehouseId,
    order,
  });
  return context.order;
}
