/**
 * @fileoverview The Kafka adapter: subscribes, and translates a processor outcome into an
 * offset decision.
 *
 * @remarks This is the only file that knows Kafka exists. Everything it decides follows from
 * one rule — *does this delivery still need to happen?*
 *
 * - `processed`, `duplicate` and `dead_lettered` all mean the effect exists (or never will),
 *   so the handler returns and the offset commits;
 * - `released` means the claim was given back and the effect does **not** exist, so the handler
 *   rethrows and the broker redelivers.
 *
 * @remarks Rethrowing is what makes the retry possible, and it is also why the processor
 * releases the claim first. A redelivery whose claim was still held would arrive as a
 * `duplicate`, commit, and lose the notification permanently — a failure with no error anywhere.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { dlqTopicFor, type Topic } from '@auth/contracts';
// Value imports for the two injected services: `emitDecoratorMetadata` reads the emitted
// value binding, so a type-only import erases the token and DI fails at boot. `ConsumedMessage`
// is only a type and stays erased.
import {
  KafkaConsumerService,
  KafkaProducerService,
  type ConsumedMessage,
} from '@auth/infra/kafka';
import { SUBSCRIBED_TOPICS } from '../../domain/event-routing';
import type { NotificationConfig } from '../../notification.config';
import { NOTIFICATION_CONFIG } from '../../notification.config';
// Value import: the processor is constructor-injected and its token comes from metadata.
import {
  ConsumerOutcomeKind,
  NotificationEventProcessor,
  type ConsumerOutcome,
} from '../../application/consumers/notification-event.processor';

@Injectable()
export class NotificationKafkaConsumer implements OnModuleInit {
  private readonly logger = new Logger(NotificationKafkaConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly producer: KafkaProducerService,
    private readonly processor: NotificationEventProcessor,
    // `NotificationConfig` is an interface, so it has no runtime token for Nest to find.
    // Without this the consumer boots with `config` undefined and every dead letter is
    // dropped by `if (!this.config.deadLetterEnabled)`.
    @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationConfig,
  ) {}

  /**
   * Registers one handler per routed topic.
   *
   * @remarks Only the topics in {@link SUBSCRIBED_TOPICS}, not `ALL_TOPICS`. Joining every
   * auth topic to be told about the four this service routes is a cost with no upside: it
   * keeps this consumer in the rebalance set of topics it will never act on, so an unrelated
   * producer's traffic slows down a consumer that does have work.
   */
  onModuleInit(): void {
    for (const topic of SUBSCRIBED_TOPICS) {
      this.consumer.register(
        topic,
        // `void`-returning on purpose: the shared consumer rethrows whatever comes back and
        // treats it as "the offset must not commit". The outcome is returned by `handle` for
        // a caller that wants to inspect it — a test, or a future retry scheduler — but the
        // registered handler discards it, because a resolved value is not a signal to anybody.
        async (message: ConsumedMessage<unknown>): Promise<void> => {
          await this.handle(topic, message);
        },
      );
    }

    this.logger.log(`subscribed to ${SUBSCRIBED_TOPICS.length} notification topic(s)`);
  }

  /**
   * One message, end to end.
   *
   * @remarks Never throws for a message this service could not understand. A handler that
   * raises on a poison message leaves its offset uncommitted, so the broker redelivers it
   * forever and every event behind it on that partition stops being processed — one bad
   * payload becomes an outage for everybody downstream of the partition.
   */
  async handle(
    topic: Topic,
    message: ConsumedMessage<unknown>,
  ): Promise<ConsumerOutcome> {
    const outcome = await this.processor.process({ ...message, topic });

    switch (outcome.kind) {
      case ConsumerOutcomeKind.PROCESSED:
        return outcome;

      case ConsumerOutcomeKind.DUPLICATE:
        return outcome;

      case ConsumerOutcomeKind.DEAD_LETTERED:
        await this.deadLetter(topic, message, outcome);
        return outcome;

      case ConsumerOutcomeKind.RELEASED:
        // The claim is gone and the notification does not exist. Rethrowing is the whole
        // mechanism: it keeps the offset uncommitted so the broker hands the message back.
        throw new Error(
          `notification for ${topic} failed and was released for retry: ${outcome.detail ?? outcome.reason}`,
        );
    }
  }

  /**
   * Republishes an unusable message to `${topic}.dlq`.
   *
   * @remarks The broker's sibling topic, not a row: retention is the broker's problem, an
   * operator can replay from it, and it does not depend on this service's own database being
   * reachable — which is exactly the situation a poison message often arrives in.
   *
   * @remarks A failure to publish the dead letter is logged and swallowed. The alternative is
   * to rethrow, which retries a message that has already been established as permanently
   * unusable — the same poison message, forever, except now it also has retries in its log.
   */
  private async deadLetter(
    topic: Topic,
    message: ConsumedMessage<unknown>,
    outcome: { reason: string; detail?: string },
  ): Promise<void> {
    if (!this.config.deadLetterEnabled) {
      this.logger.warn(
        `dropping unprocessable message from ${topic} (${outcome.reason}); dead-lettering is disabled`,
      );
      return;
    }

    try {
      await this.producer.send(
        dlqTopicFor(topic),
        JSON.stringify({
          topic,
          partition: message.partition,
          offset: message.offset,
          attempt: message.attempt,
          traceId: message.traceId,
          reason: outcome.reason,
          detail: outcome.detail,
          payload: message.payload,
        }),
        { partitionKey: topic, traceId: message.traceId },
      );

      this.logger.warn(
        `dead-lettered a message from ${topic}: ${outcome.reason}${
          outcome.detail ? ` (${outcome.detail})` : ''
        }`,
      );
    } catch (error) {
      this.logger.error(
        `failed to dead-letter a message from ${topic}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}