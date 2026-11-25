/**
 * @fileoverview The single write path for canceling an order.
 *
 * @remarks Runs the cancel saga: refund if money settled, release stock if it was held,
 * then mark the order canceled with its reason. Every peer call is idempotent, so a
 * retried cancel converges instead of double-refunding.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import {
  ResourceNotFoundException,
  ValidationException,
} from '@auth/platform/error-handling';
import {
  BILLING_PEER,
  INVENTORY_PEER,
  type BillingPeerPort,
  type InventoryPeerPort,
} from '../../domain/ports/peer-ports';
import {
  ORDER_REPOSITORY,
  type OrderRepositoryPort,
} from '../../domain/ports/order-repository.port';
import { OrderStatus } from '../../domain/order.aggregate';
import { ORDER_CONFIG, type OrderConfig } from '../../order.config';
import { toOrderView } from '../order-read-model';
import { CancelOrderCommand, type CanceledOrder } from './order.command';
import { runCancel } from '../saga/cancel.saga';

@Injectable()
@CommandHandler(CancelOrderCommand)
export class CancelOrderHandler
  implements ICommandHandler<CancelOrderCommand, CanceledOrder>
{
  private readonly logger = new Logger(CancelOrderHandler.name);

  constructor(
    @Inject(ORDER_REPOSITORY) private readonly repository: OrderRepositoryPort,
    @Inject(INVENTORY_PEER) private readonly inventory: InventoryPeerPort,
    @Inject(BILLING_PEER) private readonly billing: BillingPeerPort,
    @Inject(ORDER_CONFIG) private readonly config: OrderConfig,
  ) {}

  async execute(command: CancelOrderCommand): Promise<CanceledOrder> {
    const orderId = command.orderId?.trim() ?? '';
    if (orderId.length === 0) {
      throw new ValidationException('orderId is required', { field: 'orderId' });
    }

    const order = await this.repository.findById(orderId);
    if (!order) {
      throw new ResourceNotFoundException('order not found', { orderId });
    }

    // Ownership is checked here rather than in a guard: the saga must never cancel
    // somebody else's order even if a transport-level check is bypassed.
    if (order.userId !== command.userId) {
      throw new ResourceNotFoundException('order not found', { orderId });
    }

    // Idempotent: a second cancel of an already-canceled order returns it unchanged
    // without re-running refund/release (the aggregate's `cancel` is a no-op, but we
    // skip the saga entirely so a retried cancel cannot re-enter billing).
    if (order.status === OrderStatus.CANCELED) {
      return toOrderView(order);
    }

    try {
      const canceled = await runCancel(
        {
          inventory: this.inventory,
          billing: this.billing,
          repository: this.repository,
        },
        order,
        command.reason,
        this.config.defaultWarehouse,
      );

      return toOrderView(canceled);
    } catch (error) {
      this.logger.error('cancel failed', error instanceof Error ? error.stack : error);
      throw error;
    }
  }
}
