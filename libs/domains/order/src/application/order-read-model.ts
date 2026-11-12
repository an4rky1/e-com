/**
 * @fileoverview Read models the order module exposes — never proto messages.
 *
 * @remarks The transport shape belongs to the presentation layer. A second copy of it here
 * would be a second thing to keep in step with `order.proto`, and the gRPC controller is
 * the only place money crosses the wire as a string.
 */
import type { OrderView } from '@auth/contracts';
import type { Order } from '../domain/order.aggregate';
import { toShopMoney } from '../money';

/** Maps the aggregate onto the wire-facing view the controller formats. */
export function toOrderView(order: Order): OrderView {
  return {
    id: order.id,
    userId: order.userId,
    status: order.status,
    lines: order.lines.map((line) => ({
      sku: line.sku,
      productId: line.productId,
      name: line.name,
      quantity: line.quantity,
      unitPrice: toShopMoney(line.unitPriceMinor, order.currency),
      totalPrice: toShopMoney(line.totalPriceMinor, order.currency),
    })),
    subtotal: toShopMoney(order.subtotalMinor, order.currency),
    total: toShopMoney(order.totalMinor, order.currency),
    currency: order.currency,
    paymentId: order.paymentId ?? '',
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    version: order.version,
    cancelReason: order.cancelReason ?? '',
  };
}
