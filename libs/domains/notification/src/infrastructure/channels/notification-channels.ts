/**
 * @fileoverview Channel adapters and the registry that resolves them.
 *
 * @remarks The console adapter is a real implementation of the same port a provider would be,
 * not a stub that pretends. One that logs what a provider would need — channel, template,
 * subject, and whether an address was present — is what makes a run legible without a mail
 * server, and it is the adapter a developer meets first.
 *
 * @remarks None of these are `@Injectable()`. Every one of them takes a plain value in its
 * constructor, so the module factory constructs them explicitly and hands the finished list to
 * the registry. Decorating them would mean Nest had to resolve a token per channel and bind
 * four providers whose names differ only by an argument.
 */
import { Logger } from '@nestjs/common';
import type {
  NotificationChannelPort,
  NotificationChannelRegistry,
  NotificationDeliveryReceipt,
  NotificationMessage,
} from '../../domain/ports/notification-channel.port';
import type { NotificationConfig } from '../../notification.config';
import {
  DeliveryStatus,
  NOTIFICATION_CHANNELS as CANONICAL_ORDER,
  NotificationChannel,
} from '../../domain/value-objects/notification-channel.vo';

/**
 * Logs instead of sending.
 *
 * @remarks The default for a development deployment, and deliberately so: a service that
 * silently does nothing until a provider SDK is wired is a service nobody notices is broken
 * until a real user waits for an email.
 *
 * @remarks The body is withheld unless `NOTIFICATION_LOG_BODIES` is set. A body is composed
 * from variables that arrived on a Kafka topic; logging them by default makes this the place
 * every user's notification text ends up, in a log aggregator nobody scoped.
 */
export class ConsoleNotificationChannel implements NotificationChannelPort {
  private readonly logger = new Logger(ConsoleNotificationChannel.name);

  constructor(
    readonly channel: NotificationChannel,
    private readonly config: NotificationConfig,
  ) {}

  /**
   * @remarks Always true, including for a recipient with no address. Writing the line *is* the
   * delivery, and refusing here would record every address-less event as a skip — hiding the
   * fact that the notification was rendered at all.
   */
  supports(): boolean {
    return true;
  }

  async deliver(message: NotificationMessage): Promise<NotificationDeliveryReceipt> {
    // The address is reported as present or absent, never printed. Whether a user could be
    // reached is the fact worth having in a log; what they were reached at is PII with a
    // retention policy nobody chose.
    this.logger.log(
      `[${this.channel}] ${message.template} → ${message.userId} ` +
        `(address: ${message.address ? 'present' : 'none'}, ${message.severity}) ` +
        `"${message.subject}"`,
    );

    if (this.config.logBodies) {
      this.logger.debug(
        `[${this.channel}] ${message.template} body: ${message.body} ` +
          `variables: ${JSON.stringify(message.variables)}`,
      );
    }

    return {
      channel: this.channel,
      status: DeliveryStatus.SENT,
      providerMessageId: `console-${message.notificationId}`,
      deliveredAt: new Date(),
    };
  }
}

/**
 * Accepts and discards.
 *
 * @remarks Not a mock: it is the correct adapter for a deployment that has deliberately turned
 * `inapp` off, and it reports `SENT` so the record says the channel was exercised rather than
 * skipped. A channel reporting `skipped` reads as a delivery bug in a support conversation
 * about a message that was never meant to be sent.
 */
export class NoopNotificationChannel implements NotificationChannelPort {
  readonly channel = NotificationChannel.INAPP;

  supports(): boolean {
    return true;
  }

  async deliver(message: NotificationMessage): Promise<NotificationDeliveryReceipt> {
    return {
      channel: this.channel,
      status: DeliveryStatus.SENT,
      providerMessageId: `noop-${message.notificationId}`,
      deliveredAt: new Date(),
    };
  }
}

/**
 * Resolves a channel to the adapter this deployment bound for it.
 *
 * @remarks A `Map`, not a conditional chain. Adding SES is one entry in the list the factory
 * passes in, and the dispatch loop already asks its question in a form that works for channels
 * it has never heard of — which is what makes "add a real provider later" a property of the
 * code rather than a promise in a comment.
 *
 * @remarks A channel with no adapter resolves to `null` rather than to an adapter that throws.
 * The dispatch loop records that as `skipped`, which is the truth: this deployment cannot
 * deliver there, as opposed to "the provider is down", which is `failed`.
 */
export class DefaultNotificationChannelRegistry implements NotificationChannelRegistry {
  private readonly adapters = new Map<NotificationChannel, NotificationChannelPort>();

  constructor(
    adapters: readonly NotificationChannelPort[] = [],
    private readonly reason = 'no adapter is bound for this channel in this deployment',
  ) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.channel, adapter);
    }
  }

  resolve(channel: NotificationChannel): NotificationChannelPort | null {
    return this.adapters.get(channel) ?? null;
  }

  /** Canonical order, so "what can we deliver on" reads the same everywhere. */
  available(): readonly NotificationChannel[] {
    return CANONICAL_ORDER.filter((channel) => this.adapters.has(channel));
  }

  get unavailableReason(): string {
    return this.reason;
  }
}

/** One console adapter per channel, for a deployment that has no provider yet. */
export const consoleChannelsFor = (
  channels: readonly NotificationChannel[],
  config: NotificationConfig,
): NotificationChannelPort[] => channels.map((channel) => new ConsoleNotificationChannel(channel, config));