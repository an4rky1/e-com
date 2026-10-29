import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { readNamespacedEnv, resolveModuleConfig } from '@auth/platform/config';
import { PrismaService } from '@auth/infra/prisma';
import {
  createOutboxModule,
  PrismaOutboxRepository,
  type EventPublisher,
} from '@auth/infra/outbox';
import { PrismaClient } from './generated/prisma/client';
import { IssueTokensHandler } from './application/commands/issue-tokens.handler';
import { RotateTokensHandler } from './application/commands/rotate-tokens.handler';
import { RefreshTokenReuseGuard } from './application/commands/refresh-token-reuse.guard';
import {
  RevokeAllSessionsHandler,
  RevokeSessionHandler,
} from './application/commands/revoke-session.command';
import { ValidateAccessTokenHandler } from './application/commands/validate-access-token.handler';
import { GetSessionByIdHandler } from './application/queries/session.queries';
import { SessionService } from './application/facade/session.service';
import { SESSION_REPOSITORY } from './domain/ports/session-repository.port';
import { PrismaSessionRepository } from './infrastructure/persistence/prisma-session.repository';
import { SessionHealthIndicator } from './session.health';
import {
  SESSION_CONFIG,
  SESSION_PRISMA,
  sessionSchema,
  type SessionConfig,
} from './session.config';
import { SessionController } from './presentation/session.controller';
import { SessionGrpcController } from './presentation/grpc/session.grpc.controller';

@Module({})
export class SessionModule {}

export interface SessionModuleOptions {
  /** Transport the outbox publishes through; supplied by the app, which owns process wiring. */
  publisher: EventPublisher;
}

/**
 * Assembles the session service.
 *
 * @remarks `SessionGrpcController` is registered here but attached in the app's
 * bootstrap with `mergeMicroservice`: a microservice has to join an existing HTTP server
 * rather than open its own.
 *
 * @remarks The outbox is wired here rather than left to the host. `OutboxModule` is global,
 * and a global module cannot see a provider declared by the module that imports it — so an
 * outbox repository supplied "from outside" is never injected and the service fails to boot
 * with `UnknownDependenciesException`.
 */
export function createSessionModule(
  options: SessionModuleOptions,
): DynamicModule {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // Refusing to boot beats a wrong default: the session client must never be
    // able to point at another service's database.
    throw new Error('DATABASE_URL is required by the session module');
  }

  // ONE client shared by the repositories and the outbox. A second client opens a second
  // connection and commits independently, which is precisely what the outbox exists to prevent.
  const prisma = new PrismaService(new PrismaClient({ datasourceUrl: databaseUrl }));
  const outboxRepository = new PrismaOutboxRepository(prisma);

  return {
    module: SessionModule,
    imports: [
      CqrsModule.forRoot(),
      createOutboxModule({ repository: outboxRepository, publisher: options.publisher }),
    ],
    controllers: [SessionController, SessionGrpcController],
    providers: [
      { provide: SESSION_PRISMA, useValue: prisma },
      { provide: SESSION_REPOSITORY, useClass: PrismaSessionRepository },
      { provide: SESSION_CONFIG, useFactory: () => resolveSessionConfig() },

      IssueTokensHandler,
      RefreshTokenReuseGuard,
      RotateTokensHandler,
      RevokeSessionHandler,
      RevokeAllSessionsHandler,
      ValidateAccessTokenHandler,
      GetSessionByIdHandler,
      SessionService,
      SessionHealthIndicator,
    ],
    // The gRPC controller is deliberately not exported: it is attached to the microservice by
    // the app's bootstrap, not injected by a consumer.
    exports: [
      SessionService,
      SessionHealthIndicator,
      SESSION_REPOSITORY,
    ],
  };
}

function resolveSessionConfig(): SessionConfig {
  const env = readNamespacedEnv('SESSION', sessionSchema, process.env);
  return resolveModuleConfig(
    {
      accessTokenTtlSec: env.ACCESS_TOKEN_TTL_SEC,
      refreshTokenTtlSec: env.REFRESH_TOKEN_TTL_SEC,
      clockSkewSec: env.CLOCK_SKEW_SEC,
      reuseRevokesFamily: env.REUSE_REVOKES_FAMILY,
      accessTokenSigningKey: env.ACCESS_TOKEN_SIGNING_KEY,
    },
    {},
  );
}

export { SESSION_CONFIG, SESSION_PRISMA };