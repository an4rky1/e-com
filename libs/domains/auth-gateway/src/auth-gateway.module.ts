/**
 * @fileoverview Assembles the auth gateway.
 *
 * @remarks Every port is bound through a `Symbol` token to a gRPC adapter, so the application
 * layer never names a class from `infrastructure/` — this wiring is the only place that knows
 * identity, credential-vault, mfa and session-token are reachable over a channel.
 *
 * @remarks The channel is a parameter rather than something this module builds. Only the host
 * application knows how the service addresses its dependencies, and constructing one here would
 * either duplicate that decision in every service or make an unreachable dependency a boot-time
 * failure instead of a deployment setting.
 */
import { Module, type DynamicModule } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { GRPC_CHANNEL, type GrpcChannel } from '@auth/infra/grpc';
import { PrismaService } from '@auth/infra/prisma';
import {
  createOutboxModule,
  PrismaOutboxRepository,
  type EventPublisher,
} from '@auth/infra/outbox';
import { PrismaClient } from './generated/prisma/client';
import {
  AdvanceFlowHandler,
  CancelFlowHandler,
  StartFlowHandler,
} from './application/commands/auth-flow.handlers';
import { GetFlowHandler } from './application/queries/auth-flow.queries';
import { AuthGatewayService } from './application/facade/auth-gateway.service';
import { AUTH_FLOW_REPOSITORY } from './domain/ports/auth-flow-repository.port';
import { CLOCK } from './domain/ports/clock.port';
import { CREDENTIAL_PORT } from './domain/ports/credential.port';
import { IDENTITY_PORT } from './domain/ports/identity.port';
import { MFA_PORT } from './domain/ports/mfa.port';
import { SESSION_PORT } from './domain/ports/session.port';
import { PrismaAuthFlowRepository } from './infrastructure/persistence/prisma-auth-flow.repository';
import {
  GrpcAccountSecurityAdapter,
  GrpcCredentialAdapter,
  GrpcIdentityAdapter,
  GrpcMfaAdapter,
  GrpcSessionAdapter,
} from './infrastructure/grpc/grpc-ports';
import { ACCOUNT_SECURITY_PORT } from './domain/ports/account-security.port';
import { SystemClock } from './infrastructure/time/system-clock';
import { AuthGatewayHealthIndicator } from './auth-gateway.health';
import {
  AUTH_GATEWAY_CONFIG,
  AUTH_GATEWAY_PRISMA,
  resolveAuthGatewayConfig,
} from './auth-gateway.config';
import { AuthGatewayGrpcController } from './presentation/grpc/auth-gateway.grpc.controller';

@Module({})
export class AuthGatewayModule {}

export interface AuthGatewayModuleOptions {
  /**
   * The channel every outbound call travels on.
   *
   * @remarks Built by the host with `createRetryingChannel(client, registry)`, so this library
   * never has to decide whether an RPC is safe to repeat.
   */
  grpcChannel: GrpcChannel;

  /** Transport the outbox publishes through; supplied by the app, which owns process wiring. */
  publisher: EventPublisher;
}

/**
 * @remarks `AuthGatewayGrpcController` is registered here but attached in the app's bootstrap
 * with `mergeMicroservice`: a microservice has to join an existing HTTP server rather than open
 * its own.
 *
 * @remarks One Prisma client is shared by the repository and the outbox. A second client would
 * open a second connection and commit independently, which is exactly what the outbox exists
 * to prevent.
 *
 * @remarks The outbox is wired here rather than left to the host. `OutboxModule` is global, and
 * a global module cannot see a provider declared by the module that imports it — so an outbox
 * repository supplied "from outside" is never injected, and `OutboxService` fails to resolve at
 * boot. Passing the repository in is what makes the relay bind to *this* service's tables.
 */
export function createAuthGatewayModule(
  options: AuthGatewayModuleOptions,
): DynamicModule {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // Refusing to boot beats a wrong default: the gateway client must never be able to
    // point at another service's database.
    throw new Error('DATABASE_URL is required by the auth-gateway module');
  }

  const prisma = new PrismaService(new PrismaClient({ datasourceUrl: databaseUrl }));
  const outboxRepository = new PrismaOutboxRepository(prisma);

  return {
    module: AuthGatewayModule,
    imports: [
      CqrsModule.forRoot(),
      createOutboxModule({ repository: outboxRepository, publisher: options.publisher }),
    ],
    controllers: [AuthGatewayGrpcController],
    providers: [
      { provide: AUTH_GATEWAY_PRISMA, useValue: prisma },
      {
        provide: AUTH_GATEWAY_CONFIG,
        useFactory: () => resolveAuthGatewayConfig(),
      },
      { provide: GRPC_CHANNEL, useValue: options.grpcChannel },

      { provide: AUTH_FLOW_REPOSITORY, useClass: PrismaAuthFlowRepository },
      { provide: IDENTITY_PORT, useClass: GrpcIdentityAdapter },
      { provide: CREDENTIAL_PORT, useClass: GrpcCredentialAdapter },
      { provide: MFA_PORT, useClass: GrpcMfaAdapter },
      { provide: SESSION_PORT, useClass: GrpcSessionAdapter },
      { provide: ACCOUNT_SECURITY_PORT, useClass: GrpcAccountSecurityAdapter },
      { provide: CLOCK, useClass: SystemClock },

      StartFlowHandler,
      AdvanceFlowHandler,
      CancelFlowHandler,
      GetFlowHandler,

      AuthGatewayService,
      AuthGatewayHealthIndicator,
    ],
    exports: [
      AUTH_FLOW_REPOSITORY,
    ],
  };
}