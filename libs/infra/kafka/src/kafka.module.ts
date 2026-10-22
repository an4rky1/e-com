import { DynamicModule, Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readNamespacedEnv } from '@auth/platform/config';
import {
  Defaults,
  ENV_PREFIX,
  kafkaSchema,
  type KafkaConfig,
  type KafkaEnvConfig,
} from './kafka.config';
import { KafkaHealthIndicator } from './kafka.health';
import { KafkaConsumerService, KafkaProducerService } from './kafka.service';
import { KAFKA_CONFIG } from './kafka.tokens';

/**
 * Declared once at module scope — Nest identifies a dynamic module by class reference.
 */
@Global()
@Module({})
class KafkaModule {}

function mapEnv(env: KafkaEnvConfig): KafkaConfig {
  return {
    enabled: env.ENABLED,
    brokers: env.BROKERS,
    clientId: env.CLIENT_ID,
    groupId: env.GROUP_ID,
    acks: env.ACKS as -1 | 0 | 1,
    retries: env.RETRIES,
    maxBytes: env.MAX_BYTES,
    maxWaitMs: env.MAX_WAIT_MS,
    sessionTimeoutMs: env.SESSION_TIMEOUT_MS,
    maxAttempts: env.MAX_ATTEMPTS,
    retryBaseMs: env.RETRY_BASE_MS,
  };
}

export function createKafkaModule(): DynamicModule {
  return {
    module: KafkaModule,
    global: true,
    providers: [
      {
        provide: KAFKA_CONFIG,
        inject: [ConfigService],
        useFactory: () =>
          mapEnv(readNamespacedEnv(ENV_PREFIX, kafkaSchema, process.env)),
      },
      KafkaProducerService,
      KafkaConsumerService,
      KafkaHealthIndicator,
    ],
    exports: [
      KAFKA_CONFIG,
      KafkaProducerService,
      KafkaConsumerService,
      KafkaHealthIndicator,
    ],
  };
}