import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  Kafka,
  logLevel,
  type Consumer,
  type KafkaMessage,
  type Producer,
} from 'kafkajs';
import { dlqTopicFor, EVENT_SCHEMA_VERSION, retryTopicFor, type Topic } from '@auth/contracts';
import type { EventPublisher } from '@auth/infra/outbox';
import { KAFKA_CONFIG } from './kafka.tokens';
import { clientSecurity, type KafkaConfig } from './kafka.config';

/**
 * Kafka producer, used as the outbox's transport.
 *
 * @remarks `acks: -1` (all in-sync replicas) is non-negotiable for auth events. With
 * `acks: 1` a leader election can acknowledge a write that never reached disk, and the
 * session-revocation event that was "published" is simply gone.
 */
@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy, EventPublisher {
  private readonly logger = new Logger(KafkaProducerService.name);
  private producer?: Producer;

  constructor(@Inject(KAFKA_CONFIG) private readonly config: KafkaConfig) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.warn('Kafka is disabled; events will not leave this service');
      return;
    }

    const kafka = new Kafka({
      clientId: this.config.clientId,
      brokers: this.config.brokers,
      ...clientSecurity(this.config),
      logLevel: logLevel.WARN,
    });

    this.producer = kafka.producer({
      allowAutoTopicCreation: false,
      retry: { retries: this.config.retries },
    });

    await this.producer.connect();
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.producer) return;
    // `disconnect` flushes in-flight batches; the relay stops first during shutdown.
    await this.producer.disconnect();
  }

  async send(
    topic: string,
    payload: string,
    options: { partitionKey?: string; traceId?: string; eventId?: string } = {},
  ): Promise<void> {
    if (!this.producer) {
      throw new Error('Kafka producer is not connected');
    }

    await this.producer.send({
      topic,
      acks: this.config.acks,
      messages: [
        {
          // The partition key is the aggregate id. Two events about the same aggregate must
          // land on the same partition, or "granted role" and "revoked role" can be
          // reordered by the broker and leave a user with revoked access.
          key: options.partitionKey,
          value: payload,
          headers: {
            ...(options.traceId ? { 'x-trace-id': options.traceId } : {}),
            ...(options.eventId ? { 'x-event-id': options.eventId } : {}),
            'x-schema-version': EVENT_SCHEMA_VERSION.toString(),
          },
        },
      ],
    });
  }
}

export interface ConsumedMessage<TPayload> {
  payload: TPayload;
  topic: string;
  partition: number;
  offset: string;
  traceId?: string;
  attempt: number;
}

export type MessageHandler<TPayload> = (
  message: ConsumedMessage<TPayload>,
) => Promise<void>;

/**
 * Kafka consumer with per-topic retry and dead-letter routing.
 *
 * @remarks Retries are handled by re-publishing to a `${topic}.retry` sibling, never by
 * sleeping inside the handler. Sleeping stalls the heartbeat, exceeds
 * `max.poll.interval.ms`, triggers a rebalance, and the message is redelivered from the
 * last committed offset — producing duplicates instead of progress.
 */
@Injectable()
export class KafkaConsumerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(KafkaConsumerService.name);
  private readonly handlers = new Map<string, MessageHandler<never>[]>();
  private consumer?: Consumer;
  private started = false;

  constructor(@Inject(KAFKA_CONFIG) private readonly config: KafkaConfig) {}

  register<TPayload>(topic: Topic, handler: MessageHandler<TPayload>): void {
    const existing = this.handlers.get(topic) ?? [];
    existing.push(handler as MessageHandler<never>);
    this.handlers.set(topic, existing);
  }

  /**
   * Subscribes and starts consuming.
   *
   * @remarks Deliberately `onApplicationBootstrap`, not `onModuleInit`. Handlers are
   * registered by other providers in their own `onModuleInit`, and Nest initialises a
   * dependency before its dependant — so a consumer that subscribed in `onModuleInit` would
   * run before any handler existed, see an empty registry, and silently consume nothing while
   * appearing perfectly healthy. The bootstrap phase runs after every `onModuleInit`.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.enabled || this.handlers.size === 0) return;

    const kafka = new Kafka({
      clientId: `${this.config.clientId}-consumer`,
      brokers: this.config.brokers,
      ...clientSecurity(this.config),
      logLevel: logLevel.WARN,
    });

    this.consumer = kafka.consumer({
      groupId: this.config.groupId,
      sessionTimeout: this.config.sessionTimeoutMs,
      allowAutoTopicCreation: false,
    });

    await this.consumer.connect();

    for (const topic of this.handlers.keys()) {
      await this.consumer.subscribe({ topic, fromBeginning: false });
      // Subscribing to the siblings up front means the first failure can be retried without
      // a broker round trip.
      await this.consumer.subscribe({ topic: retryTopicFor(topic as Topic), fromBeginning: false });
      await this.consumer.subscribe({ topic: dlqTopicFor(topic as Topic), fromBeginning: false });
    }

    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        await this.dispatch(topic, partition, message);
      },
    });

    this.started = true;
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.consumer || !this.started) return;
    // Disconnect first: it stops fetching, lets in-flight handlers finish, and commits
    // offsets. Closing before that would redeliver the uncommitted tail on restart.
    await this.consumer.disconnect();
  }

  private async dispatch(
    topic: string,
    partition: number,
    message: KafkaMessage,
  ): Promise<void> {
    const baseTopic = stripSibling(topic);
    const handlers = this.handlers.get(baseTopic) ?? [];
    if (handlers.length === 0) return;

    const attempt = attemptFromTopic(topic);
    const payload = JSON.parse(message.value?.toString() ?? '{}') as never;

    for (const handler of handlers) {
      try {
        await handler({
          payload,
          topic: baseTopic,
          partition,
          offset: message.offset,
          traceId: headerToString(message.headers?.['x-trace-id']),
          attempt,
        });
      } catch (error) {
        // Rethrow after routing: the offset must not commit while the effect is missing,
        // otherwise the message is silently lost. The sibling topic carries the retry.
        this.logger.error(
          `Handler for ${baseTopic} failed on attempt ${attempt}`,
          error instanceof Error ? error.stack : String(error),
        );
        throw error;
      }
    }
  }
}

const stripSibling = (topic: string): string =>
  topic.endsWith('.retry') || topic.endsWith('.dlq')
    ? topic.slice(0, topic.lastIndexOf('.'))
    : topic;

const attemptFromTopic = (topic: string): number => {
  const header = topic.split('.').pop() ?? '';
  const parsed = Number.parseInt(header.replace(/[^0-9]/g, ''), 10);
  return Number.isNaN(parsed) ? 1 : parsed;
};

const headerToString = (
  value: Buffer | string | (Buffer | string)[] | undefined,
): string | undefined => {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return headerToString(value[0]);
  return Buffer.isBuffer(value) ? value.toString() : value;
};