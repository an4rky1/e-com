/**
 * @fileoverview The single write path for creating an order.
 *
 * @remarks Commands are the only place mutations happen, so idempotency, the checkout saga
 * and event publication have exactly one hook rather than one per entry point.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { SagaExecutionError } from '@auth/core';
import {
  ResourceAlreadyExistsException,
  ValidationException,
} from '@auth/platform/error-handling';
import type { OrderView } from '@auth/contracts';
import {
  BILLING_PEER,
  CART_PEER,
  INVENTORY_PEER,
  type BillingPeerPort,
  type CartPeerPort,
  type InventoryPeerPort,
} from '../../domain/ports/peer-ports';
import {
  ORDER_REPOSITORY,
  type OrderRepositoryPort,
} from '../../domain/ports/order-repository.port';
import { ORDER_CONFIG, type OrderConfig } from '../../order.config';
import { toOrderView } from '../order-read-model';
import { CreateOrderCommand, type CreatedOrder } from './order.command';
import {
  ChargeFailedError,
  StockRejectedError,
  runCheckout,
  type CheckoutContext,
} from '../saga/checkout.saga';

/**
 * The single write path for creating an order.
 *
 * @remarks Idempotency is checked *before* the saga: a redelivered CreateOrder with the
 * same key must never open a second cart read, a second reserve or a second charge. The
 * unique index on `orders.idempotency_key` is the race backstop; this check is the fast
 * path that also distinguishes "same payload" (replay) from "different payload"
 * (IDEMPOTENCY_CONFLICT).
 */
@Injectable()
@CommandHandler(CreateOrderCommand)
export class CreateOrderHandler
  implements ICommandHandler<CreateOrderCommand, CreatedOrder>
{
  private readonly logger = new Logger(CreateOrderHandler.name);

  constructor(
    @Inject(ORDER_REPOSITORY) private readonly repository: OrderRepositoryPort,
    @Inject(CART_PEER) private readonly cart: CartPeerPort,
    @Inject(INVENTORY_PEER) private readonly inventory: InventoryPeerPort,
    @Inject(BILLING_PEER) private readonly billing: BillingPeerPort,
    @Inject(ORDER_CONFIG) private readonly config: OrderConfig,
  ) {}

  async execute(command: CreateOrderCommand): Promise<CreatedOrder> {
    const idempotencyKey = command.idempotencyKey?.trim() ?? '';
    if (idempotencyKey.length === 0) {
      throw new ValidationException('idempotencyKey is required', {
        field: 'idempotencyKey',
      });
    }

    const sessionId = command.sessionId?.trim() ?? '';
    if (sessionId.length === 0) {
      throw new ValidationException('sessionId is required', { field: 'sessionId' });
    }

    const userId = command.userId?.trim() ?? '';
    if (userId.length === 0) {
      throw new ValidationException('userId is required', { field: 'userId' });
    }

    const fingerprint = fingerprintOf(command);

    const existing = await this.repository.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        // Same key + different payload → a conflict, never a silent second order: the
        // caller's retry has diverged and must be told, or two different checkouts would
        // share one key and one of them would vanish.
        throw new ResourceAlreadyExistsException(
          'IDEMPOTENCY_CONFLICT: this idempotency key was used with a different payload',
          { field: 'idempotencyKey' },
        );
      }
      // Same key + same payload → the stored order, exactly as the first delivery answered.
      return toOrderView(existing);
    }

    const context: CheckoutContext = {
      userId,
      sessionId,
      idempotencyKey,
      currency: command.currency?.trim() ?? '',
      paymentMethodToken: command.paymentMethodToken ?? '',
      warehouseId: this.config.defaultWarehouse,
      requestFingerprint: fingerprint,
    };

    try {
      const result = await runCheckout(
        {
          cart: this.cart,
          inventory: this.inventory,
          billing: this.billing,
          repository: this.repository,
        },
        context,
      );

      if (!result.order) {
        // The saga completed without an order — a wiring bug, not a business outcome.
        throw new Error('checkout saga completed without an order');
      }

      return toOrderView(result.order);
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * Maps saga failures onto transport exceptions the gRPC layer already understands.
   *
   * @remarks Domain/saga errors are translated here rather than in the controller so a
   * second transport (an internal caller) cannot see a different answer.
   */
  private translate(error: unknown): unknown {
    // The orchestrator wraps the failing step's error so the caller also sees which
    // compensations failed. For transport mapping the *cause* is what the client can act
    // on ("stock rejected", "card declined"); the wrapper is for operators.
    const cause = error instanceof SagaExecutionError ? error.cause : error;

    if (cause instanceof ChargeFailedError) {
      return new ValidationException('payment was declined', {
        status: cause.status,
        failureCode: cause.failureCode,
      });
    }

    if (cause instanceof StockRejectedError) {
      return new ValidationException('insufficient stock for one or more lines', {
        rejected: cause.rejected,
      });
    }

    if (cause instanceof ResourceAlreadyExistsException) {
      return cause;
    }

    if (cause instanceof ValidationException) {
      return cause;
    }

    // Dependency/timeouts and anything unexpected pass through untouched: masking a
    // peer outage as a 400 would tell the client to fix its request when the fix is
    // on our side.
    this.logger.error('checkout failed', cause instanceof Error ? cause.stack : cause);
    return error;
  }
}

/**
 * Stable fingerprint of the request fields that define *which* order this key means.
 *
 * @remarks Lines are not included: they are read from the cart inside the saga, and two
 * CreateOrder calls with the same key against the same cart+user+currency are the same
 * request even if the cart moved in between (the first delivery wins; the second replays
 * the first's order).
 */
function fingerprintOf(command: CreateOrderCommand): string {
  return [
    command.userId.trim(),
    command.sessionId.trim(),
    (command.currency ?? '').trim().toUpperCase(),
  ].join('|');
}
