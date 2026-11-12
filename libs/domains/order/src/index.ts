/**
 * @fileoverview The public surface of the order domain.
 *
 * @remarks The barrel is deliberately explicit rather than `export *`: a consumer importing
 * from here should be able to see, in one screen, the whole contract this service offers —
 * and a wildcard would quietly widen it every time a helper is added under `src/`.
 *
 * @remarks Three audiences. {@link OrderService} is what an application calls; the module
 * factory is what the composition root wires; everything else exists so a test in another
 * service can assert against the same rules.
 */

// ---- configuration -------------------------------------------------------------
export {
  ORDER_CONFIG,
  ORDER_PRISMA,
  Defaults as OrderDefaults,
  orderSchema,
  resolveOrderConfig,
  type OrderConfig,
  type OrderEnvConfig,
} from './order.config';

// ---- module --------------------------------------------------------------------
export {
  ORDER_MODULE_OPTIONS,
  OrderModule,
  createOrderModule,
  type OrderModuleOptions,
} from './order.module';
export { OrderHealthIndicator } from './order.health';

// ---- commands ------------------------------------------------------------------
export {
  CancelOrderCommand,
  CreateOrderCommand,
  type CanceledOrder,
  type CreatedOrder,
} from './application/commands/order.command';
export { CreateOrderHandler } from './application/commands/create-order.handler';
export { CancelOrderHandler } from './application/commands/cancel-order.handler';

// ---- queries -------------------------------------------------------------------
export {
  GetOrderHandler,
  ListUserOrdersHandler,
} from './application/queries/order.query-handlers';
export {
  GetOrderQuery,
  ListUserOrdersQuery,
  type OrderDetailView,
  type OrderListResult,
} from './application/queries/order.queries';

// ---- application ---------------------------------------------------------------
export { OrderService } from './application/facade/order.service';
export { toOrderView } from './application/order-read-model';

// ---- domain --------------------------------------------------------------------
export {
  ORDER_AGGREGATE,
  Order,
  OrderCanceled,
  OrderConfirmed,
  OrderCreated,
  OrderPaid,
  OrderStatus,
  canTransition,
  isCancelable,
  isOrderEvent,
  isStockHeld,
  mayBeCharged,
  type OrderCanceledPayload,
  type OrderCreatedPayload,
  type OrderEvent,
  type OrderLine,
  type OrderLineRow,
  type OrderPaidPayload,
  type OrderProps,
  type OrderRow,
} from './domain/order.aggregate';
export {
  ORDER_REPOSITORY,
  type OrderPage,
  type OrderRepositoryPort,
} from './domain/ports/order-repository.port';
export {
  BILLING_PEER,
  CART_PEER,
  INVENTORY_PEER,
  type BillingPeerPort,
  type CartPeerPort,
  type InventoryPeerPort,
  type PeerReserveLine,
} from './domain/ports/peer-ports';

// ---- sagas ----------------------------------------------------------------------
export {
  ChargeFailedError,
  StockRejectedError,
  createCheckoutSaga,
  runCheckout,
  type CheckoutContext,
  type CheckoutDeps,
} from './application/saga/checkout.saga';
export {
  createCancelSaga,
  runCancel,
  type CancelContext,
  type CancelDeps,
} from './application/saga/cancel.saga';

// ---- presentation --------------------------------------------------------------
export { OrderGrpcController } from './presentation/grpc/order.grpc.controller';
export { parseShopMoney, toShopMoney } from './money';

// ---- infrastructure ------------------------------------------------------------
export { PrismaOrderRepository } from './infrastructure/persistence/prisma-order.repository';
export {
  enqueueEvents,
  type EnqueueEventsOptions,
} from './infrastructure/persistence/outbox-enqueue';
export {
  GrpcBillingPeer,
  GrpcCartPeer,
  GrpcInventoryPeer,
} from './infrastructure/peers/grpc-peers';
