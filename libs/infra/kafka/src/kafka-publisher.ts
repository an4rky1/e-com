import { KafkaProducerService } from './kafka.service';
import type { KafkaConfig } from './kafka.config';
import type { EventPublisher } from '@auth/infra/outbox';
import { readNamespacedEnv } from '@auth/platform/config';
import { Defaults, ENV_PREFIX, kafkaSchema, type KafkaEnvConfig } from './kafka.config';

/**
 * Builds a standalone publisher from the `KAFKA_*` namespace.
 *
 * @remarks Needed where a domain module is assembled inside an `@Module` decorator: the
 * module factory runs before any injection container exists, so it cannot receive the Kafka
 * producer through DI. Passing a ready-made {@link EventPublisher} keeps the composition in
 * the app — the only place that is allowed to know about process-level wiring — while the
 * domain module still sees nothing but the transport port.
 */
export function createKafkaPublisher(env: NodeJS.ProcessEnv = process.env): EventPublisher {
  const parsed = readNamespacedEnv(ENV_PREFIX, kafkaSchema, env) as KafkaEnvConfig;

  const config: KafkaConfig = {
    enabled: parsed.ENABLED,
    brokers: parsed.BROKERS,
    clientId: parsed.CLIENT_ID,
    groupId: parsed.GROUP_ID,
    acks: parsed.ACKS as -1 | 0 | 1,
    retries: parsed.RETRIES,
    maxBytes: parsed.MAX_BYTES,
    maxWaitMs: parsed.MAX_WAIT_MS,
    sessionTimeoutMs: parsed.SESSION_TIMEOUT_MS,
    maxAttempts: parsed.MAX_ATTEMPTS,
    retryBaseMs: parsed.RETRY_BASE_MS,
    ssl: parsed.SSL,
    saslMechanism: parsed.SASL_MECHANISM,
  };

  if (!config.enabled) {
    // An explicit no-op rather than a silent throw: with `KAFKA_ENABLED=false` the operator
    // has asked for no events, and the outbox simply accumulates rows for later replay.
    return {
      async send() {
        /* events are buffered in the outbox until a broker is configured */
      },
    };
  }

  const producer = new KafkaProducerService(config);
  // Connect eagerly so a bad broker list surfaces at boot, not on the first publish.
  void producer.onModuleInit().catch(() => undefined);

  return {
    send: (topic, payload, options) => producer.send(topic, payload, options),
  };
}

export { Defaults };