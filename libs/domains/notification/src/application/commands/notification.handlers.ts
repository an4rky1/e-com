/**
 * @fileoverview Command handlers: the dispatch loop and read-state transitions.
 *
 * @remarks The dispatch loop is the whole service, and it is built around one rule: a channel
 * that fails costs exactly its own channel. Everything else here follows from that — each
 * attempt is inside its own `try`, the outcome is recorded per channel rather than thrown,
 * and the aggregate is still saved when every channel failed so the failure is a durable,
 * queryable fact instead of a line in a log.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { ResourceNotFoundException } from '@auth/platform/error-handling';
import {
  NOTIFICATION_CHANNELS,
  type NotificationChannelRegistry,
  type NotificationMessage,
} from '../../domain/ports/notification-channel.port';
import {
  NOTIFICATION_STORE,
  type NotificationStorePort,
} from '../../domain/ports/notification-store.port';
import {
  Notification,
  addressFor,
  type NotificationOutcome,
} from '../../domain/notification.aggregate';
import {
  redactVariables,
  sanitiseDeliveryError,
} from '../../domain/notification-announcement';
import {
  compileTemplate,
  orderedChannels,
} from '../../domain/templates/notification-templates';
import {
  DeliveryStatus,
  NotificationChannel,
} from '../../domain/value-objects/notification-channel.vo';
import {
  MarkNotificationReadCommand,
  SendNotificationCommand,
  type MarkNotificationReadResult,
  type SendNotificationResult,
} from './notification.commands';

@Injectable()
@CommandHandler(SendNotificationCommand)
export class SendNotificationHandler
  implements ICommandHandler<SendNotificationCommand, SendNotificationResult>
{
  private readonly logger = new Logger(SendNotificationHandler.name);

  constructor(
    @Inject(NOTIFICATION_STORE) private readonly store: NotificationStorePort,
    @Inject(NOTIFICATION_CHANNELS) private readonly channels: NotificationChannelRegistry,
  ) {}

  /**
   * Renders one template and attempts every channel it names.
   *
   * @remarks Resolves even when every channel failed. A throw here would take the consumer's
   * claim with it and put a *transient* provider outage into an infinite retry loop, while a
   * `failed` outcome records what happened and lets the user's next action be a resend. The
   * durable record of the failure is the point.
   *
   * @throws {DomainError} from the template schema, when the variables do not satisfy it.
   * That one *is* thrown: a payload that failed its schema will fail identically on every
   * retry, so the caller dead-letters it rather than retrying forever.
   */
  async execute(command: SendNotificationCommand): Promise<SendNotificationResult> {
    const compiled = compileTemplate(command.template, command.variables);

    // Content redaction happens before rendering, not before publishing. A variable that
    // looks like an address must not reach a body either — the body is what a provider
    // renders into somebody's inbox, and a template that quietly interpolates one is worse
    // than one that renders a placeholder.
    const safe = redactVariables(compiled.variables);

    const requested = orderedChannels(
      command.channels ?? compiled.definition.channels,
    );

    const notification = Notification.request({
      userId: command.userId,
      template: command.template,
      subject: compiled.subject,
      body: compiled.body,
      severity: compiled.definition.severity,
      variables: safe.variables,
      redactedVariables: safe.redacted,
      recipient: command.recipient,
      channels: requested,
      correlationId: command.correlationId,
    });

    for (const channel of requested) {
      await this.attempt(notification, channel, requested.length);
    }

    const outcome: NotificationOutcome = notification.settle(command.correlationId);
    await this.store.save(notification);

    if (safe.redacted.length > 0) {
      this.logger.warn(
        `template ${command.template} for ${command.userId} dropped ${safe.redacted.join(', ')} before dispatch`,
      );
    }
    if (outcome === 'failed') {
      this.logger.error(
        `every channel failed for notification ${notification.id.value} (${command.template}, user ${command.userId})`,
      );
    }

    return {
      notificationId: notification.id.value,
      template: command.template,
      outcome,
      deliveries: notification.deliveries.map((delivery) => ({
        channel: delivery.channel,
        status: delivery.status,
        ...(delivery.error ? { error: delivery.error } : {}),
      })),
      redactedVariables: notification.redactedVariables,
    };
  }

  /**
   * One channel, fully isolated.
   *
   * @remarks Three distinct "not sent" paths, each with its own record, because they need
   * different follow-ups:
   *
   * - no adapter for this channel — the deployment cannot deliver here (`skipped`);
   * - an adapter that exists but has no address for this recipient — nothing to send to;
   * - an adapter that threw — our problem, and a retry may fix it.
   *
   * @remarks `address` is passed rather than the whole recipient so a channel adapter cannot
   * reach an address belonging to a *different* channel by accident.
   */
  private async attempt(
    notification: Notification,
    channel: NotificationChannel,
    total: number,
  ): Promise<void> {
    const adapter = this.channels.resolve(channel);
    const address = addressFor(notification.recipient, channel);
    // `inapp` has no address to have: it is delivered to whoever opens the app. Every other
    // channel without one has nothing to send to, which is a `skip` and not a `failure`.
    const addressRequired = channel !== NotificationChannel.INAPP;

    if (!adapter) {
      this.record(notification, {
        channel,
        status: DeliveryStatus.SKIPPED,
        error: this.channels.unavailableReason,
      });
      return;
    }

    if (addressRequired && (address === null || !adapter.supports(notification.recipient))) {
      this.record(notification, {
        channel,
        status: DeliveryStatus.SKIPPED,
        error: 'no address for this channel on the recipient',
      });
      return;
    }

    const message: NotificationMessage = {
      notificationId: notification.id.value,
      userId: notification.userId,
      template: notification.template,
      subject: notification.subject,
      body: notification.body,
      variables: notification.variables,
      recipient: notification.recipient,
      severity: notification.severity,
      address,
    };

    try {
      const receipt = await adapter.deliver(message);
      this.record(notification, {
        channel,
        status: receipt.status,
        ...(receipt.providerMessageId
          ? { providerMessageId: receipt.providerMessageId }
          : {}),
        ...(receipt.error ? { error: receipt.error } : {}),
      });
    } catch (error) {
      // Swallowed on purpose. Rethrowing would abandon the channels that have not been
      // attempted yet, and the whole reason this loop is written per channel is that one
      // provider being down must not cost a user their push notification.
      const message_ = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `channel ${channel} failed for notification ${notification.id.value} (${notification.deliveries.length + 1}/${total})`,
      );
      this.record(notification, {
        channel,
        status: DeliveryStatus.FAILED,
        error: message_,
      });
    }
  }

  private record(
    notification: Notification,
    delivery: {
      channel: NotificationChannel;
      status: DeliveryStatus;
      providerMessageId?: string;
      error?: string;
    },
  ): void {
    notification.recordDelivery({
      channel: delivery.channel,
      status: delivery.status,
      ...(delivery.providerMessageId
        ? { providerMessageId: delivery.providerMessageId }
        : {}),
      // Scrubbed, not merely truncated: a provider error is the least predictable string this
      // service stores, and the one most likely to quote a key or an address verbatim.
      ...(delivery.error ? { error: sanitiseDeliveryError(delivery.error) } : {}),
      deliveredAt: new Date(),
    });
  }
}

@Injectable()
@CommandHandler(MarkNotificationReadCommand)
export class MarkNotificationReadHandler
  implements ICommandHandler<MarkNotificationReadCommand, MarkNotificationReadResult>
{
  constructor(@Inject(NOTIFICATION_STORE) private readonly store: NotificationStorePort) {}

  /**
   * @remarks Scoped to `userId` as well as the notification id. A read-state write takes its
   * target from the path in a client request, and without the ownership check an id is a
   * bearer capability for "I read this".
   */
  async execute(
    command: MarkNotificationReadCommand,
  ): Promise<MarkNotificationReadResult> {
    const existing = await this.store.findById(command.notificationId);

    if (!existing || existing.userId !== command.userId) {
      throw new ResourceNotFoundException('notification not found', {
        notificationId: command.notificationId,
      });
    }

    const changed = existing.markRead(command.now ?? new Date(), command.correlationId);

    if (!changed) {
      // Already read. Still a success: the caller asked for the state they already have, and
      // a 409 here would make a double-click on a "mark all read" button look like a failure.
      return {
        notificationId: existing.id.value,
        read: true,
        readAt: (existing.readAt ?? new Date()).toISOString(),
        changed: false,
      };
    }

    await this.store.save(existing);

    return {
      notificationId: existing.id.value,
      read: true,
      readAt: (existing.readAt ?? new Date()).toISOString(),
      changed: true,
    };
  }
}