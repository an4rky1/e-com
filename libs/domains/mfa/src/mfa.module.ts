/**
 * @fileoverview Assembles the MFA service.
 *
 * @remarks Every provider is bound through a `Symbol` token from a port, so the application
 * layer never names a class from `infrastructure/` — the wiring is the only place that knows
 * an AES-GCM vault and a Node TOTP engine are the implementations of the ports the aggregates
 * were written against.
 *
 * @remarks `MfaService` is bound to both its own class and {@link MFA_CHALLENGE}: it is the
 * public surface of this module *and* the answer to the guard's question. One implementation
 * of "does this code prove possession" is worth more than a second one in the gateway.
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
import {
  BeginEnrollmentHandler,
  ConfirmEnrollmentHandler,
  DisableMfaHandler,
  RegenerateRecoveryCodesHandler,
  VerifyFactorHandler,
} from './application/commands/mfa.handlers';
import { GetMfaStatusHandler } from './application/queries/mfa.queries';
import { MfaService } from './application/facade/mfa.service';
import {
  MFA_FACTOR_REPOSITORY,
} from './domain/ports/mfa-factor-repository.port';
import {
  RECOVERY_CODE_SET_REPOSITORY,
} from './domain/ports/recovery-code-set-repository.port';
import {
  CLOCK,
  MFA_UNIT_OF_WORK,
} from './domain/ports/mfa-unit-of-work.port';
import {
  RECOVERY_CODES,
} from './domain/ports/recovery-code.port';
import { SECRET_VAULT } from './domain/ports/secret-vault.port';
import { TOTP_ENGINE } from './domain/ports/totp.port';
import { MFA_CHALLENGE } from './domain/ports/mfa-challenge.port';
import { PrismaMfaFactorRepository } from './infrastructure/persistence/prisma-mfa-factor.repository';
import { PrismaRecoveryCodeSetRepository } from './infrastructure/persistence/prisma-recovery-code-set.repository';
import { PrismaMfaUnitOfWork } from './infrastructure/persistence/prisma-mfa-unit-of-work';
import { NodeRecoveryCodeService } from './infrastructure/crypto/node-recovery-codes.service';
import { AesGcmSecretVault } from './infrastructure/crypto/aes-gcm-secret-vault';
import { NodeTotpService } from './infrastructure/crypto/node-totp.service';
import { SystemClock } from './infrastructure/time/system-clock';
import { MfaHealthIndicator } from './mfa.health';
import { MfaController } from './presentation/mfa.controller';
import { MfaGuard } from './presentation/guards/mfa.guard';
import {
  MFA_CONFIG,
  MFA_PRISMA,
  MFA_SECRET_ENCRYPTION_KEY,
  MFA_TOTP_DIGITS,
  MFA_TOTP_PERIOD_SEC,
  resolveMfaConfig,
} from './mfa.config';

@Module({})
export class MfaModule {}

export interface MfaModuleOptions {
  /** Transport the outbox publishes through; supplied by the app, which owns process wiring. */
  publisher: EventPublisher;
}

/**
 * @remarks The outbox is wired here rather than left to the host. `OutboxModule` is global, and
 * a global module cannot see a provider declared by the module that imports it — so an outbox
 * repository supplied "from outside" is never injected and the service fails to boot with
 * `UnknownDependenciesException`.
 */
export function createMfaModule(options: MfaModuleOptions): DynamicModule {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // Refusing to boot beats a wrong default: the mfa client must never be able to
    // point at another service's database.
    throw new Error('DATABASE_URL is required by the mfa module');
  }

  // ONE client shared by the repositories and the outbox. A second client opens a second
  // connection and commits independently, which is precisely what the outbox exists to prevent.
  const prisma = new PrismaService(new PrismaClient({ datasourceUrl: databaseUrl }));
  const outboxRepository = new PrismaOutboxRepository(prisma);

  return {
    module: MfaModule,
    imports: [
      CqrsModule.forRoot(),
      createOutboxModule({ repository: outboxRepository, publisher: options.publisher }),
    ],
    controllers: [MfaController],
    providers: [
      { provide: MFA_PRISMA, useValue: prisma },
      { provide: MFA_CONFIG, useFactory: () => resolveMfaConfig() },
      {
        provide: MFA_SECRET_ENCRYPTION_KEY,
        inject: [MFA_CONFIG],
        // Only the vault ever sees the key; the whole config is not exported, so no other
        // provider can read it by accident.
        useFactory: (config: { secretEncryptionKey: string }) => config.secretEncryptionKey,
      },
      {
        provide: MFA_TOTP_PERIOD_SEC,
        inject: [MFA_CONFIG],
        useFactory: (config: { totpPeriodSec: number }) => config.totpPeriodSec,
      },
      {
        provide: MFA_TOTP_DIGITS,
        inject: [MFA_CONFIG],
        useFactory: (config: { totpDigits: number }) => config.totpDigits,
      },

      { provide: MFA_FACTOR_REPOSITORY, useClass: PrismaMfaFactorRepository },
      { provide: RECOVERY_CODE_SET_REPOSITORY, useClass: PrismaRecoveryCodeSetRepository },
      { provide: MFA_UNIT_OF_WORK, useClass: PrismaMfaUnitOfWork },
      { provide: CLOCK, useClass: SystemClock },
      { provide: RECOVERY_CODES, useClass: NodeRecoveryCodeService },
      { provide: SECRET_VAULT, useClass: AesGcmSecretVault },
      { provide: TOTP_ENGINE, useClass: NodeTotpService },

      BeginEnrollmentHandler,
      ConfirmEnrollmentHandler,
      VerifyFactorHandler,
      DisableMfaHandler,
      RegenerateRecoveryCodesHandler,
      GetMfaStatusHandler,

      { provide: MfaService, useClass: MfaService },
      // The same instance: a second MfaService would mean a second command bus binding.
      { provide: MFA_CHALLENGE, useExisting: MfaService },

      MfaGuard,
      MfaHealthIndicator,
    ],
    exports: [
      MfaService,
      MFA_CHALLENGE,
      MfaGuard,
      MfaHealthIndicator,
      MFA_FACTOR_REPOSITORY,
      RECOVERY_CODE_SET_REPOSITORY,
    ],
  };
}