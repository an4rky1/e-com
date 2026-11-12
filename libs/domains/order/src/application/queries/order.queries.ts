/**
 * @fileoverview Queries and their results for the order module.
 */
import type { OrderView } from '@auth/contracts';

export class GetOrderQuery {
  constructor(
    readonly orderId: string,
    readonly userId: string,
  ) {}
}

export class ListUserOrdersQuery {
  constructor(
    readonly userId: string,
    readonly page: number,
    readonly pageSize: number,
  ) {}
}

export type OrderDetailView = OrderView;

export interface OrderListResult {
  readonly orders: readonly OrderView[];
  readonly total: number;
}
