import { type DynamicModule, Global, Module } from '@nestjs/common';
import { readNamespacedEnv, resolveModuleConfig } from '@auth/platform/config';
import { Defaults, ENV_PREFIX, outboxSchema, type OutboxEnvConfig } from './outbox.config';
import { OutboxHealthIndicator, OutboxRelay } from './prisma-outbox.repository';
import type { OutboxRepositoryPort } from './outbox.repository.port';
import { OutboxService } from './outbox.service';
import {
  OUTBOX_CONFIG,
  OUTBOX_PUBLISHER,
  OUTBOX_REPOSITORY,
  type OutboxConfig,
} from './outbox.tokens';
import type { EventPublisher } from './publisher.port';

/**
 * @remarks The module is assembled from a factory because the outbox is used by every
 * service with a different repository implementation and a different transport. The
 * alternatives — a global module with a hard-wired Prisma repo, or every service hand-wiring
 * the same three providers — both put the assembly in N places instead of one.
 */
@Global()
@Module({})
export class OutboxModule {}

export interface OutboxModuleOptions {
  repository: OutboxRepositoryPort;
  publisher: EventPublisher;
  config?: Partial<OutboxConfig>;
}

export function createOutboxModule(options: OutboxModuleOptions): DynamicModule {
  return {
    module: OutboxModule,
    global: true,
    providers: [
      {
        provide: OUTBOX_CONFIG,
        useFactory: () => {
          const env = readNamespacedEnv<typeof outboxSchema>(
            ENV_PREFIX,
            outboxSchema,
            process.env,
          ) as OutboxEnvConfig;

          const defaults: OutboxConfig = {
            enabled: Defaults.ENABLED,
            pollIntervalMs: Defaults.POLL_INTERVAL_MS,
            batchSize: Defaults.BATCH_SIZE,
            maxRetries: Defaults.MAX_RETRIES,
            baseRetryDelayMs: Defaults.BASE_RETRY_DELAY_MS,
            maxRetryDelayMs: Defaults.MAX_RETRY_DELAY_MS,
            retentionHours: Defaults.RETENTION_HOURS,
          };

          return resolveModuleConfig(defaults, {
            ...mapEnv(env),
            ...(options.config ?? {}),
          });
        },
      },
      { provide: OUTBOX_REPOSITORY, useValue: options.repository },
      { provide: OUTBOX_PUBLISHER, useValue: options.publisher },
      OutboxService,
      OutboxRelay,
      OutboxHealthIndicator,
    ],
    exports: [
      OUTBOX_CONFIG,
      OUTBOX_REPOSITORY,
      OutboxService,
      OutboxRelay,
      OutboxHealthIndicator,
    ],
  };
}

function mapEnv(env: OutboxEnvConfig): Partial<OutboxConfig> {
  return {
    enabled: env.ENABLED,
    pollIntervalMs: env.POLL_INTERVAL_MS,
    batchSize: env.BATCH_SIZE,
    maxRetries: env.MAX_RETRIES,
    baseRetryDelayMs: env.BASE_RETRY_DELAY_MS,
    maxRetryDelayMs: env.MAX_RETRY_DELAY_MS,
    retentionHours: env.RETENTION_HOURS,
  };
}