/**
 * @fileoverview Assembles the api-gateway.
 *
 * @remarks **The channel is built here, not by the host app**, because this edge's
 * dependency set is its whole identity: five proto packages, each on its own host, each
 * declared in one `addresses` map. Building it in `main.ts` would put the one piece of
 * information that defines what this service *is* into the thinnest file in the repository,
 * where nothing else would test it. A module factory is also the only place it could be
 * built — it runs inside an `@Module` decorator, where no container exists yet.
 *
 * @remarks There is no Prisma client, no outbox, no Kafka producer and no repository here,
 * and there is no seam where one could be added. Those all need somewhere to keep state, and
 * this service keeps none.
 */
import {
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
  Module,
  ValidationPipe,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { GRPC_CHANNEL, createStaticGrpcChannel } from '@auth/infra/grpc';
import type { GrpcChannel } from '@auth/infra/grpc';
import { FeatureFlagsModule } from '@auth/platform/feature-flags';
import { IdempotencyModule } from '@auth/infra/idempotency';
import { RateLimitModule } from '@auth/infra/rate-limit';
import { RedisHealthIndicator } from '@auth/infra/redis';
import { HealthModule, HealthService } from '@auth/platform/health';
import { RequestContextMiddleware, RequestContextModule } from '@auth/platform/context';
import { join, resolve } from 'node:path';
import {
  GATEWAY_CONFIG,
  peerAddressesOf,
  resolveGatewayConfig,
  type GatewayConfig,
} from './gateway.config';
import { GatewayHealthIndicator } from './gateway.health';
import { PeerCaller } from './infrastructure/grpc/peer-caller';
import {
  GrpcAccessControlClient,
  GrpcAuthFlowClient,
  GrpcBillingClient,
  GrpcCartClient,
  GrpcCatalogClient,
  GrpcCredentialVaultClient,
  GrpcIdentityClient,
  GrpcOrderClient,
  GrpcSessionClient,
} from './infrastructure/grpc/grpc-peer-clients';
import {
  ACCESS_CONTROL_CLIENT,
  AUTH_FLOW_CLIENT,
  BILLING_CLIENT,
  CART_CLIENT,
  CATALOG_CLIENT,
  CREDENTIAL_VAULT_CLIENT,
  IDENTITY_CLIENT,
  ORDER_CLIENT,
  SESSION_CLIENT,
} from './application/ports/peer-clients.port';
import { GatewayService } from './application/facade/gateway.service';
import { StorefrontService } from './application/facade/storefront.service';
import { OAUTH_HTTP } from './application/oauth/oauth.port';
import { OAuthService } from './application/oauth/oauth.service';
import { FetchOAuthHttp } from './infrastructure/oauth/fetch-oauth-http';
import { AuthController } from './presentation/auth.controller';
import { UsersController } from './presentation/users.controller';
import { CatalogController } from './presentation/catalog.controller';
import { CartController } from './presentation/cart.controller';
import { CheckoutController } from './presentation/checkout.controller';
import { OrdersController } from './presentation/orders.controller';
import { WebhooksController } from './presentation/webhooks.controller';
import { IdempotencyInterceptor } from './presentation/interceptors/idempotency.interceptor';
import { JwtAuthGuard } from './presentation/guards/jwt-auth.guard';
import { PermissionsGuard } from './presentation/guards/permissions.guard';
import { RateLimitGuard } from './presentation/guards/rate-limit.guard';
import { FeatureFlagGuard } from './presentation/guards/feature-flag.guard';

@Module({})
export class GatewayModule implements NestModule {
  /**
   * Opens the request context around every request, before any guard.
   *
   * @remarks Middleware rather than an interceptor because the ordering is the feature: a 401
   * answered by `JwtAuthGuard` is one of the responses whose logs most need a correlation id,
   * and a context opened at interceptor level would start after the guards have already run.
   * `/` rather than a controller list so the context also covers `/health` and any path added
   * later — a probe nobody can trace is still a request.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('/');
  }
}

/** The peer protos, in one place so a sixth service is a one-line change here. */
const PROTO_FILES = [
  'auth_flow.proto',
  'identity.proto',
  'access_control.proto',
  'session.proto',
  'credential_vault.proto',
  'catalog.proto',
  'cart.proto',
  'inventory.proto',
  'billing.proto',
  'order.proto',
] as const;

export interface GatewayModuleOptions {
  /** Overrides, chiefly so a fixture can point the peers somewhere cheap. */
  readonly config?: GatewayConfig;
  /** Where the peer protos live. Defaults to this workspace's `libs/contracts/proto`. */
  readonly protoDir?: string;
}

/**
 * Closes the shared channel.
 *
 * @remarks The channel is created once here and injected into five adapters, so nothing else
 * owns its teardown. Without this, a rolling deploy leaves gRPC clients to be collected by
 * the event loop rather than by the shutdown that is supposed to be draining.
 */
export class GatewayChannelLifecycle implements OnApplicationShutdown {
  constructor(private readonly caller: PeerCaller) {}

  async onApplicationShutdown(): Promise<void> {
    await this.caller.close();
  }
}

/**
 * Puts the health indicator on the report.
 *
 * @remarks Registered here rather than by the app, so `/health/ready` is meaningful without
 * the composition root having to know that an indicator exists. The provider exists only to
 * run that one call during container construction — `HealthService` is a singleton, so its
 * registry outlives it.
 */
const GATEWAY_HEALTH_REGISTRATION = Symbol('GATEWAY_HEALTH_REGISTRATION');
const REDIS_HEALTH_REGISTRATION = Symbol('REDIS_HEALTH_REGISTRATION');

/**
 * The workspace's proto directory.
 *
 * @remarks Resolved from this file rather than from the process working directory, because the
 * two differ: `main.ts` is launched from the workspace root with `TS_NODE_PROJECT`, and a
 * relative path would resolve differently under `nx serve`, under a test runner and under
 * `ts-node` from a subdirectory.
 */
function defaultProtoDir(): string {
  // `libs/gateway/src` -> `libs` -> `contracts/proto`. Two levels, from this file.
  return resolve(__dirname, '../../contracts/proto');
}

export function createGatewayModule(
  options: GatewayModuleOptions = {},
): DynamicModule {
  const config = options.config ?? resolveGatewayConfig();
  const protoDir = options.protoDir ?? defaultProtoDir();

  // Several proto packages, each on its own host — the reason `createStaticGrpcChannel` takes
  // `protoPaths` and `addresses` rather than a single `protoPath`/`url`.
  const channel: GrpcChannel = createStaticGrpcChannel({
    protoPaths: PROTO_FILES.map((file) => join(protoDir, file)),
    addresses: peerAddressesOf(config),
    // The fallback for a package with no entry above. identity is that package, so a typo in
    // one address map fails visibly at the first call rather than resolving somewhere else.
    url: config.identityUrl,
    defaultDeadlineMs: config.peerDeadlineMs,
    // Present, not verify: every peer's guard rejects a call without it, and the token is a
    // property of the channel rather than of any one adapter so that a sixth peer cannot be
    // added with a channel that forgets it.
    serviceToken: config.grpcServiceToken,
  });

  return {
    module: GatewayModule,
    // `forRoot` rather than the bare module: this call is what provides `HealthService`, and
    // taking it here guarantees exactly one instance. Importing it again from the app would
    // register `/health` twice.
    imports: [
      HealthModule.forRoot('api-gateway'),
      FeatureFlagsModule.register(),
      IdempotencyModule.register(),
      RateLimitModule.register(),
      RequestContextModule.register(),
    ],
    controllers: [
      AuthController,
      UsersController,
      CatalogController,
      CartController,
      CheckoutController,
      OrdersController,
      WebhooksController,
    ],
    providers: [
      { provide: GATEWAY_CONFIG, useValue: config },
      { provide: GRPC_CHANNEL, useValue: channel },

      // One caller, ten adapters. Sharing the caller is what makes the deadline and the
      // error translation uniform rather than five independent decisions.
      PeerCaller,
      GatewayChannelLifecycle,

      { provide: AUTH_FLOW_CLIENT, useClass: GrpcAuthFlowClient },
      { provide: IDENTITY_CLIENT, useClass: GrpcIdentityClient },
      { provide: ACCESS_CONTROL_CLIENT, useClass: GrpcAccessControlClient },
      { provide: SESSION_CLIENT, useClass: GrpcSessionClient },
      { provide: CREDENTIAL_VAULT_CLIENT, useClass: GrpcCredentialVaultClient },
      { provide: CATALOG_CLIENT, useClass: GrpcCatalogClient },
      { provide: CART_CLIENT, useClass: GrpcCartClient },
      { provide: ORDER_CLIENT, useClass: GrpcOrderClient },
      { provide: BILLING_CLIENT, useClass: GrpcBillingClient },

      GatewayService,
      StorefrontService,
      // The provider walk: a service that sequences it, and the one adapter that reaches
      // providers over HTTP. The port exists so neither the service nor a test ever calls
      // `fetch` directly — the same reason the five gRPC peers sit behind ports.
      OAuthService,
      { provide: OAUTH_HTTP, useClass: FetchOAuthHttp },
      FeatureFlagGuard,
      RateLimitGuard,
      JwtAuthGuard,
      PermissionsGuard,
      GatewayHealthIndicator,
      {
        provide: GATEWAY_HEALTH_REGISTRATION,
        inject: [HealthService, GatewayHealthIndicator],
        useFactory: (
          health: HealthService,
          indicator: GatewayHealthIndicator,
        ): boolean => {
          health.register('api-gateway', () => indicator.check());
          return true;
        },
      },

      // Reported, not required. The limiter fails open when Redis is unreachable, so an
      // outage there degrades the limit without taking the edge out of rotation — and
      // readiness that pulled every pod for a cache would trade a soft degradation for a
      // hard outage, which is the trade the limiter's own fail-open exists to avoid.
      {
        provide: REDIS_HEALTH_REGISTRATION,
        inject: [HealthService, RedisHealthIndicator],
        useFactory: (
          health: HealthService,
          indicator: RedisHealthIndicator,
        ): boolean => {
          health.register('redis', () => indicator.check(), { required: false });
          return true;
        },
      },

      // Dropped before a handler sees them. For `/auth/login` this is what keeps a body full
      // of undeclared fields from travelling to a peer that only needs two of them.
      {
        provide: APP_PIPE,
        useValue: new ValidationPipe({ whitelist: true, transform: true }),
      },

      // Global, opted into per route: the interceptor reads `@Idempotent()` first and does
      // nothing at all without it, so mounting it here costs every other route one metadata
      // lookup while guaranteeing a decorated route can never be mounted unprotected.
      { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    ],
    exports: [GatewayService, StorefrontService, GatewayHealthIndicator],
  };
}
