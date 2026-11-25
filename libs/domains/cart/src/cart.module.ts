/**
 * @fileoverview Nest wiring for the cart service.
 *
 * @remarks A factory rather than a static `@Module`, for the same reason as its siblings:
 * the options (the peer channel) are chosen by the composition root, and a module whose
 * metadata is evaluated at import time cannot receive them.
 *
 * @remarks Every provider is bound through a `Symbol` token declared by a port, so the
 * application layer never names a class from `infrastructure/`. The wiring is the only
 * place that knows a Redis client is the implementation of the port the handlers were
 * written against.
 *
 * @remarks Redis itself is *not* imported here. The composition root lists
 * `RedisModule.forRoot()` because it is the only layer that should know which processes of
 * this service have a cache; what this module asks for is the lock, which brings the
 * client with it.
 *
 * @remarks `CartGrpcController` is registered here but attached in the app's bootstrap
 * with `connectMicroservice`: a microservice has to join an existing HTTP server rather
 * than open its own.
 */
import { Module, type DynamicModule } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import type { Redis } from 'ioredis';
import { REDIS } from '@auth/infra/redis';
import {
  DistributedLockingModule,
  // Value import, not `type`: the `inject:` array below names this class at runtime.
  DistributedLockingService,
} from '@auth/infra/distributed-locking';
import type { GrpcChannel } from '@auth/infra/grpc';
import { CartWorkspace } from './application/cart-workspace';
import { CartService } from './application/facade/cart.service';
import { AddItemHandler } from './application/commands/add-item.handler';
import { UpdateItemQtyHandler } from './application/commands/update-item-qty.handler';
import { RemoveItemHandler } from './application/commands/remove-item.handler';
import { ClearCartHandler } from './application/commands/clear-cart.handler';
import { MergeGuestCartHandler } from './application/commands/merge-guest-cart.handler';
import {
  GetCartHandler,
  GetCheckoutLinesHandler,
  ValidateForCheckoutHandler,
} from './application/queries/cart.queries';
import { CART_LOCK } from './domain/ports/cart-lock.port';
import { CART_STORE } from './domain/ports/cart-store.port';
import { PRODUCT_PRICING } from './domain/ports/product-pricing.port';
import { RedisCartStore } from './infrastructure/persistence/redis-cart.store';
import { CartLockAdapter } from './infrastructure/locking/cart-lock.adapter';
import { GrpcCatalogPricing } from './infrastructure/pricing/grpc-catalog-pricing';
import { CartGrpcController } from './presentation/grpc/cart.grpc.controller';
import { CartHealthIndicator } from './cart.health';
import { CART_CONFIG, resolveCartConfig, type CartConfig } from './cart.config';

/** DI token carrying the factory's options for the providers the peer channel feeds. */
export const CART_MODULE_OPTIONS = Symbol('CART_MODULE_OPTIONS');

export interface CartModuleOptions {
  /**
   * Channel to the peers this service calls as a client (catalog, for price lookups).
   *
   * @remarks Supplied by the app because a module factory runs inside an `@Module` decorator,
   * where no injection container exists yet. The domain layer only ever sees the
   * {@link GrpcChannel} port.
   */
  grpcChannel: GrpcChannel;
}

@Module({})
export class CartModule {}

/**
 * Assembles the cart service.
 *
 * @remarks Constructed eagerly rather than through `useClass` for the three adapters that
 * take their dependencies as plain arguments: a store needs the Redis client, a lock needs
 * the platform's mutex *and* the key prefix, and a pricing client needs the peer channel.
 * A factory states each of those as one line where `useClass` would need three tokens and
 * a constructor that exists only to receive them.
 */
export function createCartModule(options: CartModuleOptions): DynamicModule {
  return {
    module: CartModule,
    imports: [CqrsModule.forRoot(), DistributedLockingModule.register()],
    controllers: [CartGrpcController],
    providers: [
      { provide: CART_MODULE_OPTIONS, useValue: options },
      { provide: CART_CONFIG, useFactory: (): CartConfig => resolveCartConfig() },
      {
        provide: CART_STORE,
        inject: [REDIS, CART_CONFIG],
        useFactory: (redis: Redis | null, config: CartConfig) =>
          new RedisCartStore(redis, config),
      },
      {
        provide: CART_LOCK,
        inject: [DistributedLockingService, CART_CONFIG],
        useFactory: (locking: DistributedLockingService, config: CartConfig) =>
          new CartLockAdapter(locking, config.keyPrefix),
      },
      {
        provide: PRODUCT_PRICING,
        inject: [CART_MODULE_OPTIONS, CART_CONFIG],
        useFactory: (moduleOptions: CartModuleOptions, config: CartConfig) =>
          new GrpcCatalogPricing(moduleOptions.grpcChannel, config),
      },

      AddItemHandler,
      UpdateItemQtyHandler,
      RemoveItemHandler,
      ClearCartHandler,
      MergeGuestCartHandler,
      GetCartHandler,
      GetCheckoutLinesHandler,
      ValidateForCheckoutHandler,

      CartWorkspace,
      CartService,
      CartHealthIndicator,
    ],
    // The gRPC controller is deliberately not exported: it is attached to the microservice
    // by the app's bootstrap, not injected by a consumer.
    exports: [CartService, CartHealthIndicator, CART_MODULE_OPTIONS],
  };
}
