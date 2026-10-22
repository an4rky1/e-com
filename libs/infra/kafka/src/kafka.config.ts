import { z } from 'zod';
import { envBoolean, envInt, envString } from '@auth/platform/config';

export const ENV_PREFIX = 'KAFKA';

export const Defaults = {
  BROKERS: 'localhost:9092',
  CLIENT_ID: 'auth-service',
  GROUP_ID: 'auth-consumer',
  ACKS: -1 as const,
  RETRIES: 5,
  MAX_BYTES: 1_048_576,
  MAX_WAIT_MS: 5_000,
  SESSION_TIMEOUT_MS: 30_000,
  MAX_ATTEMPTS: 5,
  RETRY_BASE_MS: 1_000,
  ENABLED: true,
} as const;

/**
 * `KAFKA_BROKERS` lives here rather than in the platform namespace because a broker list is
 * a transport concern the Kafka module owns end to end. Deployment-wide values that no
 * module owns (like `SERVICE_NAME`) stay in platform config.
 */
export const kafkaSchema = z.object({
  ENABLED: envBoolean(Defaults.ENABLED),
  BROKERS: envString(Defaults.BROKERS)
    .transform((value) => value.split(',').map((broker) => broker.trim()))
    .describe('Comma-separated broker list'),
  CLIENT_ID: envString(Defaults.CLIENT_ID),
  GROUP_ID: envString(Defaults.GROUP_ID),
  ACKS: envInt(Defaults.ACKS, { min: -1, max: 1 }),
  RETRIES: envInt(Defaults.RETRIES, { min: 0 }),
  MAX_BYTES: envInt(Defaults.MAX_BYTES, { min: 1024 }),
  MAX_WAIT_MS: envInt(Defaults.MAX_WAIT_MS, { min: 1 }),
  SESSION_TIMEOUT_MS: envInt(Defaults.SESSION_TIMEOUT_MS, { min: 6_000 }),
  MAX_ATTEMPTS: envInt(Defaults.MAX_ATTEMPTS, { min: 1, max: 20 }),
  RETRY_BASE_MS: envInt(Defaults.RETRY_BASE_MS, { min: 100 }),
});

export type KafkaEnvConfig = z.infer<typeof kafkaSchema>;

export interface KafkaConfig {
  enabled: boolean;
  brokers: string[];
  clientId: string;
  groupId: string;
  acks: -1 | 0 | 1;
  retries: number;
  maxBytes: number;
  maxWaitMs: number;
  sessionTimeoutMs: number;
  maxAttempts: number;
  retryBaseMs: number;
}