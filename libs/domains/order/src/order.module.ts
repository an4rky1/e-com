/**
 * @fileoverview Nest wiring for the order service.
 *
 * @remarks A factory rather than a static `@Module`, for the same reason as its siblings:
 * the options (publisher, peer channel) are chosen by the composition root, and a module
 * whose metadata is evaluated at import time cannot receive them.
 *
 * @remarks Every provider is bound through a `Symbol` token declared by a port, so the
 * application layer never names a class from `infrastructure/`. The wiring is the only
 * place that knows a Prisma client and a gRPC channel are the implementations of the
 * ports the sagas were written against.
 *
 * @remarks `OrderGrpcController` is registered here but attached in the app's bootstrap
 * with `connectMicroservice`: a microservice has to join an existing HTTP server rather
 * than open its own.
 */
import { Module, type DynamicModule } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { PrismaService } from '@auth/infra/prisma';
import {
  createOutboxModule,
  PrismaOutboxRepository,
  type EventPublisher,
} from '@auth/infra/outbox';
import type { GrpcChannel } from '@auth/infra/grpc';
import { PrismaClient } from './generated/prisma/client';
import { CreateOrderHandler } from './application/commands/create-order.handler';
import { CancelOrderHandler } from './application/commands/cancel-order.handler';
import { GetOrderHandler, ListUserOrdersHandler } from './application/queries/order.query-handlers';
import { OrderService } from './application/facade/order.service';
import {
  BILLING_PEER,
  CART_PEER,
  INVENTORY_PEER,
} from './domain/ports/peer-ports';
import { ORDER_REPOSITORY } from './domain/ports/order-repository.port';
import { PrismaOrderRepository } from './infrastructure/persistence/prisma-order.repository';
import {
  GrpcBillingPeer,
  GrpcCartPeer,
  GrpcInventoryPeer,
} from './infrastructure/peers/grpc-peers';
import { OrderGrpcController } from './presentation/grpc/order.grpc.controller';
import { OrderHealthIndicator } from './order.health';
import { ORDER_CONFIG, ORDER_PRISMA, resolveOrderConfig, type OrderConfig } from './order.config';

/** DI token carrying the factory's options for the providers the peer channel feeds. */
export const ORDER_MODULE_OPTIONS = Symbol('ORDER_MODULE_OPTIONS');

export interface OrderModuleOptions {
  /**
   * Transport the outbox publishes through.
   *
   * @remarks Supplied by the app because a module factory runs inside an `@Module` decorator,
   * where no injection container exists yet to hand over a Kafka producer. The domain layer
   * still only ever sees the {@link EventPublisher} port.
   */
  publisher: EventPublisher;
  /**
   * Channel to the peers the saga calls as a client: cart, inventory, billing.
   *
   * @remarks Supplied by the app because a module factory runs inside an `@Module` decorator,
   * where no injection container exists yet. The domain layer only ever sees the
   * {@link GrpcChannel} port.
   */
  grpcChannel: GrpcChannel;
}

@Module({})
export class OrderModule {}

/**
 * Assembles the order service.
 *
 * @remarks One Prisma client is shared by the repository and the outbox. A second client
 * would open a second connection and commit independently, which is exactly what the
 * outbox exists to prevent.
 *
 * @remarks The outbox is wired here rather than left to the host. `OutboxModule` is global,
 * and a global module cannot see a provider declared by the module that imports it — so an
 * outbox repository supplied "from outside" is never injected, and `OutboxService` fails to
 * resolve at boot. Passing the repository in is what makes the relay bind to *this*
 * service's tables.
 */
export function createOrderModule(options: OrderModuleOptions): DynamicModule {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // Refusing to boot beats a wrong default: this client must never be able to point at
    // another service's database.
    throw new Error('DATABASE_URL is required by the order module');
  }

  const prisma = new PrismaService(new PrismaClient({ datasourceUrl: databaseUrl }));
  const outboxRepository = new PrismaOutboxRepository(prisma);

  return {
    module: OrderModule,
    imports: [
      CqrsModule.forRoot(),
      createOutboxModule({ repository: outboxRepository, publisher: options.publisher }),
    ],
    controllers: [OrderGrpcController],
    providers: [
      { provide: ORDER_MODULE_OPTIONS, useValue: options },
      { provide: ORDER_PRISMA, useValue: prisma },
      { provide: ORDER_CONFIG, useFactory: () => resolveOrderConfig() },

      { provide: ORDER_REPOSITORY, useClass: PrismaOrderRepository },

      {
        provide: CART_PEER,
        inject: [ORDER_MODULE_OPTIONS, ORDER_CONFIG],
        useFactory: (moduleOptions: OrderModuleOptions, config: OrderConfig) =>
          new GrpcCartPeer(moduleOptions.grpcChannel, config),
      },
      {
        provide: INVENTORY_PEER,
        inject: [ORDER_MODULE_OPTIONS, ORDER_CONFIG],
        useFactory: (moduleOptions: OrderModuleOptions, config: OrderConfig) =>
          new GrpcInventoryPeer(moduleOptions.grpcChannel, config),
      },
      {
        provide: BILLING_PEER,
        inject: [ORDER_MODULE_OPTIONS, ORDER_CONFIG],
        useFactory: (moduleOptions: OrderModuleOptions, config: OrderConfig) =>
          new GrpcBillingPeer(moduleOptions.grpcChannel, config),
      },

      CreateOrderHandler,
      CancelOrderHandler,
      GetOrderHandler,
      ListUserOrdersHandler,

      OrderService,
      OrderHealthIndicator,
    ],
    // The gRPC controller is deliberately not exported: it is attached to the microservice
    // by the app's bootstrap, not injected by a consumer.
    exports: [OrderService, OrderHealthIndicator, ORDER_MODULE_OPTIONS],
  };
}
