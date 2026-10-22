/**
 * @fileoverview Nest wiring for credential-vault.
 *
 * @remarks A factory rather than a static `@Module`, for one reason: the Argon2 cost
 * parameters and the pepper come from `VAULT_*`, and a module whose metadata is evaluated at
 * import time reads the environment before `ConfigModule` has had a chance to load it. The
 * factory also makes the missing-pepper decision explicit at boot instead of implicit.
 */
import { Logger, Module, type DynamicModule, type Provider } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { PrismaService } from '@auth/infra/prisma';
import {
  createOutboxModule,
  PrismaOutboxRepository,
  type EventPublisher,
} from '@auth/infra/outbox';
import { PrismaClient } from './generated/prisma/client';
import {
  VAULT_CONFIG,
  VAULT_PRISMA,
  resolveCredentialVaultConfig,
} from './credential-vault.config';
import {
  ChangePasswordHandler,
  RegenerateRecoveryCodesHandler,
  RevokeAllCredentialsHandler,
  SetPasswordHandler,
  VerifyPasswordHandler,
} from './application/commands/credential.handlers';
import { GetCredentialStatusHandler } from './application/queries/credential.queries';
import { CredentialVaultService } from './application/facade/credential-vault.service';
import { CREDENTIAL_REPOSITORY } from './domain/ports/credential-repository.port';
import { PASSWORD_HASHER } from './domain/ports/password-hasher.port';
import { PrismaCredentialRepository } from './infrastructure/persistence/prisma-credential.repository';
import { Argon2PasswordHasher } from './infrastructure/security/argon2-password.hasher';
import { CredentialVaultGrpcController } from './presentation/grpc/credential-vault.grpc.controller';

@Module({})
export class CredentialVaultModule {}

export interface CredentialVaultModuleOptions {
  /** Transport the outbox publishes through; supplied by the app, which owns process wiring. */
  publisher: EventPublisher;
}

/**
 * Assembles the credential-vault service.
 *
 * @remarks Only the gRPC controller is registered. There is no REST surface: a password is
 * never accepted from, or returned to, a browser directly — every path to it goes through a
 * service that has already authenticated the caller, and adding an HTTP controller here would
 * create a second, weaker front door to the same secret.
 *
 * @remarks `gRPC` is attached in the app's bootstrap with `mergeMicroservice`, because a
 * microservice joins an existing HTTP server rather than opening its own.
 *
 * @remarks The outbox is wired here rather than left to the host. `OutboxModule` is global, and
 * a global module cannot see a provider declared by the module that imports it — so an outbox
 * repository supplied "from outside" is never injected and the service fails to boot with
 * `UnknownDependenciesException`. Passing the repository in is what makes the relay bind to
 * *this* service's tables.
 */
export function createCredentialVaultModule(
  options: CredentialVaultModuleOptions,
): DynamicModule {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // Refusing to boot beats a wrong default: the vault client must never be able to
    // point at another service's database and read its secrets.
    throw new Error('DATABASE_URL is required by the credential-vault module');
  }

  // ONE client shared by the repositories and the outbox. A second client opens a second
  // connection and commits independently, which is precisely what the outbox exists to prevent.
  const prisma = new PrismaService(new PrismaClient({ datasourceUrl: databaseUrl }));
  const outboxRepository = new PrismaOutboxRepository(prisma);

  const logger = new Logger('CredentialVaultModule');

  const vaultConfigProvider: Provider = {
    provide: VAULT_CONFIG,
    useFactory: () => resolveCredentialVaultConfig(),
  };

  const hasherProvider: Provider = {
    provide: PASSWORD_HASHER,
    inject: [VAULT_CONFIG],
    useFactory: (config: ReturnType<typeof resolveCredentialVaultConfig>) => {
      // A missing pepper is survivable — Argon2id on its own is a defensible configuration —
      // but it must never be silent. A deployment that believes it is peppered and is not has
      // the exact protection it thought it had, and nothing would reveal that until a dump of
      // the table was in someone else's hands.
      if (!config.pepper) {
        logger.warn(
          'VAULT_PEPPER is not set: stored hashes will not be peppered. ' +
            'Set it before handling production traffic.',
        );
      }

      return new Argon2PasswordHasher({
        memoryCost: config.argon2.memoryCost,
        timeCost: config.argon2.timeCost,
        parallelism: config.argon2.parallelism,
        hashLength: config.argon2.hashLength,
        version: config.argon2.version,
        pepper: config.pepper,
      });
    },
  };

  return {
    module: CredentialVaultModule,
    imports: [
      CqrsModule.forRoot(),
      createOutboxModule({ repository: outboxRepository, publisher: options.publisher }),
    ],
    controllers: [CredentialVaultGrpcController],
    providers: [
      { provide: VAULT_PRISMA, useValue: prisma },
      vaultConfigProvider,
      hasherProvider,
      { provide: CREDENTIAL_REPOSITORY, useClass: PrismaCredentialRepository },

      SetPasswordHandler,
      ChangePasswordHandler,
      VerifyPasswordHandler,
      RevokeAllCredentialsHandler,
      RegenerateRecoveryCodesHandler,
      GetCredentialStatusHandler,
      CredentialVaultService,
    ],
    // The gRPC controller is deliberately not exported: it is attached to the microservice by
    // the app's bootstrap, not injected by a consumer.
    exports: [CREDENTIAL_REPOSITORY],
  };
}