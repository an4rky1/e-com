/**
 * @fileoverview Nest wiring for account-security.
 *
 * @remarks A factory rather than a static `@Module`, for one reason: the lockout thresholds
 * come from `ACCOUNT_SECURITY_*`, and a module whose metadata is evaluated at import time
 * reads the environment before `ConfigModule` has had a chance to load it. The factory also
 * makes the "no Redis" decision explicit at boot rather than implicit.
 */
import { Logger, Module, type DynamicModule, type Provider } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { PrismaService } from '@auth/infra/prisma';
import {
  createOutboxModule,
  PrismaOutboxRepository,
  type EventPublisher,
} from '@auth/infra/outbox';
import { REDIS } from '@auth/infra/redis';
import type { Redis } from 'ioredis';
import { PrismaClient } from './generated/prisma/client';
import {
  ACCOUNT_SECURITY_CONFIG,
  ACCOUNT_SECURITY_PRISMA,
  resolveAccountSecurityConfig,
  type AccountSecurityConfig,
} from './account-security.config';
import {
  LockAccountHandler,
  RecordLoginAttemptHandler,
  RevokeDeviceHandler,
  UnlockAccountHandler,
} from './application/commands/login-attempt.handlers';
import {
  AssessRiskHandler,
  GetLoginHistoryHandler,
  ListDevicesHandler,
} from './application/queries/account-security.queries';
import { AccountSecurityService } from './application/facade/account-security.service';
import {
  DEVICE_REGISTRY,
  SECURITY_REPOSITORY,
} from './domain/ports/security-repository.port';
import { FAILURE_TRACKER } from './domain/ports/failure-tracker.port';
import { RISK_SCORING } from './domain/ports/risk-scoring.port';
import { RiskScoringService } from './domain/services/risk-scoring.service';
import { PrismaSecurityRepository } from './infrastructure/persistence/prisma-security.repository';
import {
  NoopFailureTracker,
  RedisFailureTracker,
  type RedisCounterOptions,
} from './infrastructure/cache/redis-failure-tracker';
import { AccountSecurityHealthIndicator } from './account-security.health';
import { AccountSecurityGrpcController } from './presentation/grpc/account-security.grpc.controller';

@Module({})
export class AccountSecurityModule {}

/**
 * The rate store, real or not.
 *
 * @remarks One provider for both ports because the two questions are answered from the same
 * keys. Splitting them would mean two sets of key prefixes for no gain.
 *
 * @remarks The client is the shared one from `@auth/infra/redis` — optional here, so a host
 * that never imported that module degrades to the no-op tracker instead of failing to boot
 * with an unresolvable token.
 *
 * @remarks A missing Redis is a *warning*, not a boot failure. This service signs people in; it
 * must keep doing that while degraded. What is lost — the lockout and the per-ip limit — is
 * announced at boot, because a deployment that believes it has rate limiting and does not is
 * worse than one that knows it does not.
 */
const rateStoreProvider: Provider = {
  provide: FAILURE_TRACKER,
  inject: [ACCOUNT_SECURITY_CONFIG, { token: REDIS, optional: true }],
  useFactory: (
    config: AccountSecurityConfig,
    redis: Redis | null | undefined,
  ): RedisFailureTracker | NoopFailureTracker => {
    const logger = new Logger('AccountSecurityModule');
    const options: RedisCounterOptions = {
      keyPrefix: config.redisKeyPrefix,
      failureWindowSec: config.failureWindowSec,
      deviceTtlSec: config.deviceRetentionDays * 86_400,
    };

    if (!config.cacheEnabled || redis === null || redis === undefined) {
      logger.warn(
        'Redis is not configured: account lockouts and per-ip limits are DISABLED. ' +
          'Set REDIS_URL before handling production traffic.',
      );
      return new NoopFailureTracker();
    }

    return new RedisFailureTracker(redis, options);
  },
};

/** The scorer, built from config so a threshold change is a configuration change. */
const scoringProvider: Provider = {
  provide: RISK_SCORING,
  inject: [ACCOUNT_SECURITY_CONFIG],
  useFactory: (config: AccountSecurityConfig) =>
    new RiskScoringService(config.riskScoring),
};

export interface AccountSecurityModuleOptions {
  /** Transport the outbox publishes through; supplied by the app, which owns process wiring. */
  publisher: EventPublisher;
}

/**
 * Assembles the account-security service.
 *
 * @remarks Only the gRPC controller is registered. There is no REST surface: login attempts,
 * device lists and "this looks like an attack" answers are all questions an authenticated
 * service asks, and adding an HTTP controller here would create a second, weaker front door to
 * the same data — one with no caller identity to check the user id against.
 *
 * @remarks `gRPC` is attached in the app's bootstrap with `mergeMicroservice`, because a
 * microservice joins an existing HTTP server rather than opening its own.
 *
 * @remarks One Prisma client is shared by the repositories and the outbox. A second client would
 * open a second connection and commit independently, which is exactly what the outbox exists
 * to prevent.
 *
 * @remarks The outbox is wired here rather than left to the host. `OutboxModule` is global, and
 * a global module cannot see a provider declared by the module that imports it — so an outbox
 * repository supplied "from outside" is never injected, and `OutboxService` fails to resolve at
 * boot. Passing the repository in is what makes the relay bind to *this* service's tables.
 */
export function createAccountSecurityModule(
  options: AccountSecurityModuleOptions,
): DynamicModule {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // Refusing to boot beats a wrong default: this client must never be able to point at
    // another service's database and read its login history.
    throw new Error('DATABASE_URL is required by the account-security module');
  }

  const prisma = new PrismaService(new PrismaClient({ datasourceUrl: databaseUrl }));
  const outboxRepository = new PrismaOutboxRepository(prisma);

  return {
    module: AccountSecurityModule,
    imports: [
      CqrsModule.forRoot(),
      createOutboxModule({ repository: outboxRepository, publisher: options.publisher }),
    ],
    controllers: [AccountSecurityGrpcController],
    providers: [
      { provide: ACCOUNT_SECURITY_PRISMA, useValue: prisma },
      {
        provide: ACCOUNT_SECURITY_CONFIG,
        useFactory: () => resolveAccountSecurityConfig(),
      },
      rateStoreProvider,
      scoringProvider,
      { provide: SECURITY_REPOSITORY, useClass: PrismaSecurityRepository },
      // The registry and the counters are the same Redis keys, so the same object fills both
      // tokens. Two instances would mean two connections doing one job.
      {
        provide: DEVICE_REGISTRY,
        inject: [FAILURE_TRACKER],
        useFactory: (store: RedisFailureTracker | NoopFailureTracker) => store,
      },

      RecordLoginAttemptHandler,
      LockAccountHandler,
      UnlockAccountHandler,
      RevokeDeviceHandler,
      ListDevicesHandler,
      GetLoginHistoryHandler,
      AssessRiskHandler,
      AccountSecurityService,
      {
        provide: AccountSecurityHealthIndicator,
        inject: [SECURITY_REPOSITORY, FAILURE_TRACKER],
        useFactory: (repository: never, tracker: never) =>
          new AccountSecurityHealthIndicator(repository, tracker),
      },
    ],
    exports: [
      AccountSecurityHealthIndicator,
      SECURITY_REPOSITORY,
      FAILURE_TRACKER,
      DEVICE_REGISTRY,
      RISK_SCORING,
    ],
  };
}