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
  Module,
  ValidationPipe,
  type DynamicModule,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { GRPC_CHANNEL, createStaticGrpcChannel } from '@auth/infra/grpc';
import type { GrpcChannel } from '@auth/infra/grpc';
import { RateLimitModule } from '@auth/infra/rate-limit';
import { HealthModule, HealthService } from '@auth/platform/health';
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
  GrpcCredentialVaultClient,
  GrpcIdentityClient,
  GrpcSessionClient,
} from './infrastructure/grpc/grpc-peer-clients';
import {
  ACCESS_CONTROL_CLIENT,
  AUTH_FLOW_CLIENT,
  CREDENTIAL_VAULT_CLIENT,
  IDENTITY_CLIENT,
  SESSION_CLIENT,
} from './application/ports/peer-clients.port';
import { GatewayService } from './application/facade/gateway.service';
import { AuthController } from './presentation/auth.controller';
import { UsersController } from './presentation/users.controller';
import { JwtAuthGuard } from './presentation/guards/jwt-auth.guard';
import { PermissionsGuard } from './presentation/guards/permissions.guard';
import { RateLimitGuard } from './presentation/guards/rate-limit.guard';

@Module({})
export class GatewayModule {}

/** The peer protos, in one place so a sixth service is a one-line change here. */
const PROTO_FILES = [
  'auth_gateway.proto',
  'identity.proto',
  'access_control.proto',
  'session_token.proto',
  'credential_vault.proto',
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
    imports: [HealthModule.forRoot('api-gateway'), RateLimitModule.register()],
    controllers: [AuthController, UsersController],
    providers: [
      { provide: GATEWAY_CONFIG, useValue: config },
      { provide: GRPC_CHANNEL, useValue: channel },

      // One caller, five adapters. Sharing the caller is what makes the deadline and the
      // error translation uniform rather than five independent decisions.
      PeerCaller,
      GatewayChannelLifecycle,

      { provide: AUTH_FLOW_CLIENT, useClass: GrpcAuthFlowClient },
      { provide: IDENTITY_CLIENT, useClass: GrpcIdentityClient },
      { provide: ACCESS_CONTROL_CLIENT, useClass: GrpcAccessControlClient },
      { provide: SESSION_CLIENT, useClass: GrpcSessionClient },
      { provide: CREDENTIAL_VAULT_CLIENT, useClass: GrpcCredentialVaultClient },

      GatewayService,
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

      // Dropped before a handler sees them. For `/auth/login` this is what keeps a body full
      // of undeclared fields from travelling to a peer that only needs two of them.
      {
        provide: APP_PIPE,
        useValue: new ValidationPipe({ whitelist: true, transform: true }),
      },
    ],
    exports: [GatewayService, GatewayHealthIndicator],
  };
}
