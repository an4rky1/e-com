/**
 * @fileoverview Nest wiring for api-key.
 *
 * @remarks A factory rather than a static `@Module`, so the configuration is resolved when the
 * module is built rather than when its metadata is evaluated at import time — a module that
 * reads the environment during `import` cannot be tested, and cannot be told which environment
 * it is in.
 *
 * @remarks Every provider is bound through a `Symbol` token declared by a port, so the
 * application layer never names a class from `infrastructure/`. The wiring is the only place
 * that knows a CSPRNG and a Prisma client are the implementations of the ports the aggregate
 * was written against.
 *
 * @remarks There is no controller. api-key has no user-facing surface of its own: the only
 * callers are the gateway (which fronts it) and the guard (which is reused elsewhere), and a
 * second front door to "issue me a credential" is a second place to get authorisation wrong.
 */

import { Module, type DynamicModule } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { PrismaService } from '@auth/infra/prisma';
import {
  createOutboxModule,
  PrismaOutboxRepository,
  type EventPublisher,
} from '@auth/infra/outbox';
import { PrismaClient } from './generated/prisma/client';
import { CreateApiKeyHandler } from './application/commands/create-api-key.handler';
import { RevokeApiKeyHandler } from './application/commands/revoke-api-key.handler';
import { RotateApiKeyHandler } from './application/commands/rotate-api-key.handler';
import {
  ListUserApiKeysHandler,
} from './application/queries/api-key.queries';
import { ApiKeyService } from './application/facade/api-key.service';
import {
  API_KEY_VERIFIER,
  ApiKeyAuthenticationService,
} from './application/authentication/api-key-authentication.service';
import { API_KEY_CRYPTO } from './domain/ports/api-key-crypto.port';
import { API_KEY_REPOSITORY } from './domain/ports/api-key-repository.port';
import { NodeApiKeyCrypto } from './infrastructure/crypto/node-api-key.crypto';
import { PrismaApiKeyRepository } from './infrastructure/persistence/prisma-api-key.repository';
import { ApiKeyAuthGuard } from './presentation/guards/api-key-auth.guard';
import { ApiKeyHealthIndicator } from './api-key.health';
import { API_KEY_CONFIG, API_KEY_PRISMA, resolveApiKeyConfig } from './api-key.config';

@Module({})
export class ApiKeyModule {}

export interface ApiKeyModuleOptions {
  /** Transport the outbox publishes through; supplied by the app, which owns process wiring. */
  publisher: EventPublisher;
}

/**
 * Assembles the api-key service.
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
export function createApiKeyModule(options: ApiKeyModuleOptions): DynamicModule {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // Refusing to boot beats a wrong default: this client must never be able to point at
    // another service's database.
    throw new Error('DATABASE_URL is required by the api-key module');
  }

  const prisma = new PrismaService(new PrismaClient({ datasourceUrl: databaseUrl }));
  const outboxRepository = new PrismaOutboxRepository(prisma);

  return {
    module: ApiKeyModule,
    imports: [
      CqrsModule.forRoot(),
      createOutboxModule({ repository: outboxRepository, publisher: options.publisher }),
    ],
    providers: [
      { provide: API_KEY_PRISMA, useValue: prisma },
      { provide: API_KEY_CONFIG, useFactory: () => resolveApiKeyConfig() },

      { provide: API_KEY_REPOSITORY, useClass: PrismaApiKeyRepository },
      { provide: API_KEY_CRYPTO, useClass: NodeApiKeyCrypto },

      CreateApiKeyHandler,
      RotateApiKeyHandler,
      RevokeApiKeyHandler,
      ListUserApiKeysHandler,

      ApiKeyService,
      // The same instance: a second authentication service would be a second answer to "is this
      // key valid", and the guard would be reading whichever one DI happened to hand it.
      { provide: API_KEY_VERIFIER, useExisting: ApiKeyAuthenticationService },
      ApiKeyAuthenticationService,

      ApiKeyAuthGuard,
      ApiKeyHealthIndicator,
    ],
    exports: [
      ApiKeyService,
      API_KEY_VERIFIER,
      ApiKeyAuthGuard,
      ApiKeyHealthIndicator,
      API_KEY_REPOSITORY,
      API_KEY_CRYPTO,
    ],
  };
}