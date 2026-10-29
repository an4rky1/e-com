import { type DynamicModule, Global, Module } from '@nestjs/common';
import { readNamespacedEnv, resolveModuleConfig } from '@auth/platform/config';
import {
  Defaults,
  ENV_PREFIX,
  sagaSchema,
  toRecoveryMode,
  type SagaEnvConfig,
} from './saga.config';
import {
  SAGA_CONFIG,
  SAGA_STORE,
  type SagaConfig,
} from './saga.tokens';
import type { SagaStorePort } from './saga.store.port';
import { SagaRunner, type SagaDefinition } from './saga-runner.service';
import { SagaRecoveryService } from './saga.recovery';
import { SagaHealthIndicator } from './saga.health';

/**
 * @remarks A factory rather than a static `@Module`, for the same reason as its siblings: the
 * store implementation is chosen by the service that assembles the module (Redis where it
 * exists, in-memory where it does not), and a global hard-wired store would put that decision
 * in the library instead of the composition root.
 */
@Global()
@Module({})
export class SagaModule {}

export interface SagaModuleOptions {
  store: SagaStorePort;
  /** Definitions to register at boot, so recovery can resume them. */
  definitions?: readonly SagaDefinition<Record<string, unknown>>[];
  config?: Partial<SagaConfig>;
}

export function createSagaModule(options: SagaModuleOptions): DynamicModule {
  const runnerProvider = {
    provide: SagaRunner,
    inject: [SAGA_STORE, SAGA_CONFIG],
    useFactory: (store: SagaStorePort, config: SagaConfig) =>
      new SagaRunner(store, config),
  };

  return {
    module: SagaModule,
    global: true,
    providers: [
      {
        provide: SAGA_CONFIG,
        useFactory: (): SagaConfig => {
          const env = readNamespacedEnv<typeof sagaSchema>(
            ENV_PREFIX,
            sagaSchema,
            process.env,
          ) as SagaEnvConfig;

          const defaults: SagaConfig = {
            enabled: Defaults.ENABLED,
            stepTimeoutMs: Defaults.STEP_TIMEOUT_MS,
            stepMaxAttempts: Defaults.STEP_MAX_ATTEMPTS,
            baseRetryDelayMs: Defaults.BASE_RETRY_DELAY_MS,
            maxRetryDelayMs: Defaults.MAX_RETRY_DELAY_MS,
            recoveryIntervalMs: Defaults.RECOVERY_INTERVAL_MS,
            staleAfterMs: Defaults.STALE_AFTER_MS,
            retentionHours: Defaults.RETENTION_HOURS,
            recoveryMode: Defaults.RECOVERY_MODE,
          };

          return resolveModuleConfig(defaults, {
            ...mapEnv(env),
            ...(options.config ?? {}),
          });
        },
      },
      { provide: SAGA_STORE, useValue: options.store },
      runnerProvider,
      {
        provide: SagaRecoveryService,
        inject: [SagaRunner, SAGA_CONFIG],
        useFactory: (runner: SagaRunner, config: SagaConfig) => {
          for (const definition of options.definitions ?? []) {
            runner.register(definition);
          }
          return new SagaRecoveryService(runner, config);
        },
      },
      {
        provide: SagaHealthIndicator,
        inject: [SAGA_STORE],
        useFactory: (store: SagaStorePort) => new SagaHealthIndicator(store),
      },
    ],
    exports: [
      SAGA_CONFIG,
      SAGA_STORE,
      SagaRunner,
      SagaRecoveryService,
      SagaHealthIndicator,
    ],
  };
}

function mapEnv(env: SagaEnvConfig): Partial<SagaConfig> {
  return {
    enabled: env.ENABLED,
    stepTimeoutMs: env.STEP_TIMEOUT_MS,
    stepMaxAttempts: env.STEP_MAX_ATTEMPTS,
    baseRetryDelayMs: env.BASE_RETRY_DELAY_MS,
    maxRetryDelayMs: env.MAX_RETRY_DELAY_MS,
    recoveryIntervalMs: env.RECOVERY_INTERVAL_MS,
    staleAfterMs: env.STALE_AFTER_MS,
    retentionHours: env.RETENTION_HOURS,
    recoveryMode: toRecoveryMode(env.RECOVERY_MODE),
  };
}
