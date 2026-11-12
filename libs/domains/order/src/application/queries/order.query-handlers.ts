/**
 * @fileoverview Read-side handlers for the order module.
 *
 * @remarks Queries never mutate: they load the aggregate and map it to a view. A second
 * "read" path that bypassed the aggregate would answer from raw rows and could disagree
 * with the write path about status or totals.
 */
import { Inject, Injectable } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import {
  ResourceNotFoundException,
  ValidationException,
} from '@auth/platform/error-handling';
import {
  ORDER_REPOSITORY,
  type OrderRepositoryPort,
} from '../../domain/ports/order-repository.port';
import { ORDER_CONFIG, type OrderConfig } from '../../order.config';
import { toOrderView } from '../order-read-model';
import {
  GetOrderQuery,
  ListUserOrdersQuery,
  type OrderDetailView,
  type OrderListResult,
} from './order.queries';

@Injectable()
@QueryHandler(GetOrderQuery)
export class GetOrderHandler
  implements IQueryHandler<GetOrderQuery, OrderDetailView>
{
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly repository: OrderRepositoryPort,
  ) {}

  async execute(query: GetOrderQuery): Promise<OrderDetailView> {
    const orderId = query.orderId?.trim() ?? '';
    if (orderId.length === 0) {
      throw new ValidationException('orderId is required', { field: 'orderId' });
    }

    const order = await this.repository.findById(orderId);
    // Ownership is part of "not found": leaking another user's order id as a 403 would
    // confirm the id exists, which is itself information.
    if (!order || order.userId !== query.userId) {
      throw new ResourceNotFoundException('order not found', { orderId });
    }

    return toOrderView(order);
  }
}

@Injectable()
@QueryHandler(ListUserOrdersQuery)
export class ListUserOrdersHandler
  implements IQueryHandler<ListUserOrdersQuery, OrderListResult>
{
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly repository: OrderRepositoryPort,
    @Inject(ORDER_CONFIG) private readonly config: OrderConfig,
  ) {}

  async execute(query: ListUserOrdersQuery): Promise<OrderListResult> {
    const userId = query.userId?.trim() ?? '';
    if (userId.length === 0) {
      throw new ValidationException('userId is required', { field: 'userId' });
    }

    const page = query.page >= 1 ? query.page : 1;
    const rawSize = query.pageSize >= 1 ? query.pageSize : this.config.defaultPageSize;
    const pageSize = Math.min(rawSize, this.config.maxPageSize);

    const result = await this.repository.listForUser(userId, page, pageSize);

    return {
      orders: result.orders.map(toOrderView),
      total: result.total,
    };
  }
}
