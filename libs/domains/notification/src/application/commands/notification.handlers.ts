/** @fileoverview Command handlers: the dispatch loop and read-state transitions.

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
  type NotificationChannelPort,
  type NotificationChannelRegistry,
  type NotificationDeliveryReceipt,
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
  sanitiseDeliveryError,
} from '../../domain/notification-announcement';
import {
  compileTemplate,
  orderedChannels,
} from '../../domain/templates/notification-templates';
import { redactVariables } from '../../domain/templates/notification-redaction';
import {
  channelRequiresAddress,
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

    // The aggregate is built once, with the already-redacted payload on it. The handler does
    // not reach back in and mutate the aggregate's own copy of the variables: it builds the
    // notification from the payload it already checked, then lets the aggregate keep that copy
    // as the one, authoritative, renderable payload.
    // The report surface is the union of what the schema stripped and what the content guard
    // dropped: both are names a producer needs to see, and neither carries a value.
    const reportedRedacted = [
      ...new Set([...compiled.redacted, ...safe.redacted]),
    ].sort();

    const notification = Notification.request({
      userId: command.userId,
      template: command.template,
      subject: compiled.subject,
      body: compiled.body,
      severity: compiled.definition.severity,
      variables: safe.variables,
      redactedVariables: reportedRedacted,
      recipient: command.recipient,
      channels: requested,
      correlationId: command.correlationId,
    });

    const receipts: NotificationDeliveryReceipt[] = [];

    for (const channel of requested) {
      receipts.push(
        await this.attempt(notification, channel, this.channels.resolve(channel)),
      );
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
      deliveries: receipts.map((receipt) => ({
        channel: receipt.channel,
        status: receipt.status,
        ...(receipt.error ? { error: receipt.error } : {}),
      })),
      redactedVariables: notification.redactedVariables,
    };
  }

  /**
   * Attempts one channel on a notification that has already been built and redacted.
   *
   * @remarks Mutates the notification through its own interface rather than by assigning to
   * private fields. The order of the guards is load-bearing: an unbound or unreachable adapter
   * is a deployment fact and is checked first, while a missing address is a recipient fact and
   * only matters for channels that route to one — `inapp` never has an address, and treating
   * its `null` as "unreachable" would silently drop every in-app notification.
   *
   * @remarks A channel that throws is recorded as failed and the loop keeps going; a channel
   * that is skipped is recorded as skipped rather than left unrecorded.
   */
  private async attempt(
    notification: Notification,
    channel: NotificationChannel,
    channelAdapter: NotificationChannelPort | null,
  ): Promise<NotificationDeliveryReceipt> {
    const attemptedAt = new Date();

    // An unbound adapter is a deployment fact: the registry explains why the channel is not
    // available, and that explanation is what a support conversation needs.
    if (channelAdapter === null) {
      const unboundReceipt: NotificationDeliveryReceipt = {
        channel,
        status: DeliveryStatus.SKIPPED,
        deliveredAt: attemptedAt,
        error: this.channels.unavailableReason,
      };

      notification.recordDelivery(unboundReceipt);
      return unboundReceipt;
    }

    // A missing address is a recipient fact, and it is checked before `supports()` so the
    // reason a channel was skipped reads "nowhere to send" rather than "deployment is not
    // configured" — an adapter can be bound and willing while the recipient still has no
    // address to receive on. `inapp` never needs one.
    const address = addressFor(notification.recipient, channel);
    if (channelRequiresAddress(channel) && address === null) {
      const skippedReceipt: NotificationDeliveryReceipt = {
        channel,
        status: DeliveryStatus.SKIPPED,
        deliveredAt: attemptedAt,
        error: `no address for channel ${channel}`,
      };

      notification.recordDelivery(skippedReceipt);
      return skippedReceipt;
    }

    // A bound adapter that is not currently delivering reads as a skip, not a failure —
    // there is nowhere to send the message in this deployment, rather than a provider that
    // refused one. The throw path below is for providers that threw.
    if (!channelAdapter.supports()) {
      const unsupportedReceipt: NotificationDeliveryReceipt = {
        channel,
        status: DeliveryStatus.SKIPPED,
        deliveredAt: attemptedAt,
        error: `channel ${channel} is not enabled in this deployment`,
      };

      notification.recordDelivery(unsupportedReceipt);
      return unsupportedReceipt;
    }

    const message = {
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

    let receipt: NotificationDeliveryReceipt;
    try {
      receipt = await channelAdapter.deliver(message);
    } catch (error) {
      const failedReceipt: NotificationDeliveryReceipt = {
        channel,
        status: DeliveryStatus.FAILED,
        error: sanitiseDeliveryError(error instanceof Error ? error.message : String(error)),
        deliveredAt: attemptedAt,
      };

      notification.recordDelivery(failedReceipt);

      return failedReceipt;
    }

    notification.recordDelivery(receipt);
    return receipt;
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
