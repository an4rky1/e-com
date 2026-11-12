import { Module, type DynamicModule } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { readNamespacedEnv, resolveModuleConfig } from '@auth/platform/config';
import { PrismaService } from '@auth/infra/prisma';
import {
  createOutboxModule,
  PrismaOutboxRepository,
  OUTBOX_REPOSITORY_CONFIG,
  type EventPublisher,
} from '@auth/infra/outbox';
import { domainEventProviders } from '@auth/infra/events';
import { PrismaClient } from './generated/prisma/client';
import { CreateUserHandler } from './application/commands/create-user.handler';
import { ResolveOauthUserHandler } from './application/commands/resolve-oauth-user.handler';
import {
  DeleteUserHandler,
  UpdateUserStatusHandler,
  VerifyUserEmailHandler,
} from './application/commands/user-status.commands';
import {
  GetUserByEmailHandler,
  GetUserByIdHandler,
  ListUsersHandler,
} from './application/queries/user.queries';
import { IdentityService } from './application/facade/identity.service';
import { USER_REPOSITORY } from './domain/ports/user-repository.port';
import { PrismaUserRepository } from './infrastructure/persistence/prisma-user.repository';
import { IDENTITY_EVENTS } from './infrastructure/events/identity.events';
import { IdentityHealthIndicator } from './identity.health';
import {
  IDENTITY_PRISMA,
  identitySchema,
  type IdentityConfig,
} from './identity.config';
import { UserController } from './presentation/user.controller';
import { IdentityGrpcController } from './presentation/grpc/identity.grpc.controller';

@Module({})
export class IdentityModule {}

export const IDENTITY_CONFIG = Symbol('IDENTITY_CONFIG');

export interface IdentityModuleOptions {
  /**
   * Transport the outbox publishes through.
   *
   * @remarks Supplied by the app because a module factory runs inside an `@Module` decorator,
   * where no injection container exists yet to hand over a Kafka producer. The domain layer
   * still only ever sees the {@link EventPublisher} port.
   */
  publisher: EventPublisher;
}

/**
 * Assembles the identity service.
 *
 * @remarks One Prisma client is constructed here and shared by both the repository and the
 * outbox. That sharing is what makes "save the user and enqueue its event" one transaction
 * rather than two — a second client would open a second connection and commit independently.
 */
export function createIdentityModule(options: IdentityModuleOptions): DynamicModule {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // Refusing to boot beats a wrong default: the identity client must never be able to point
    // at another service's database.
    throw new Error('DATABASE_URL is required by the identity module');
  }

  const client = new PrismaClient({ datasourceUrl: databaseUrl });
  const prisma = new PrismaService(client);
  const outboxRepository = new PrismaOutboxRepository(prisma);

  return {
    module: IdentityModule,
    imports: [
      CqrsModule.forRoot(),
      createOutboxModule({ repository: outboxRepository, publisher: options.publisher }),
    ],
    controllers: [UserController, IdentityGrpcController],
    providers: [
      { provide: IDENTITY_PRISMA, useValue: prisma },
      { provide: OUTBOX_REPOSITORY_CONFIG, useValue: outboxRepository },
      { provide: USER_REPOSITORY, useClass: PrismaUserRepository },
      { provide: IDENTITY_CONFIG, useFactory: () => resolveIdentityConfig() },
      ...domainEventProviders(IDENTITY_EVENTS),

      CreateUserHandler,
      ResolveOauthUserHandler,
      UpdateUserStatusHandler,
      VerifyUserEmailHandler,
      DeleteUserHandler,
      GetUserByIdHandler,
      GetUserByEmailHandler,
      ListUsersHandler,
      IdentityService,
      IdentityHealthIndicator,
    ],
    // The gRPC controller is deliberately not exported: it is attached to the microservice by
    // the app's bootstrap, not injected by a consumer.
    exports: [IdentityService, IdentityHealthIndicator, USER_REPOSITORY],
  };
}

function resolveIdentityConfig(): IdentityConfig {
  const env = readNamespacedEnv('IDENTITY', identitySchema, process.env);
  return resolveModuleConfig(
    {
      cacheEnabled: env.CACHE_ENABLED,
      cacheTtlSec: env.CACHE_TTL_SEC,
      defaultLocale: env.DEFAULT_LOCALE,
      maxPageSize: env.MAX_PAGE_SIZE,
    },
    {},
  );
}