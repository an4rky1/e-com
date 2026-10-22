/**
 * @fileoverview The commands this service accepts.
 *
 * @remarks A command is an intent, not a DTO: it carries the caller's *decision*, while the
 * transport shape stays in the presentation layer. Keeping them apart means changing a
 * transport field name never reaches the domain.
 *
 * @remarks A class, not an interface. `CommandBus.execute` resolves a handler from
 * `command.constructor`, and `@CommandHandler` reads its metadata off the class it is given. A
 * plain object or a string key therefore cannot dispatch at all — `@CommandHandler('Name')`
 * throws at import, because `Reflect.hasOwnMetadata` rejects a non-object.
 */
import { Command } from '@nestjs/cqrs';

import type {
  NotificationChannel,
  DeliveryStatus,
} from '../../domain/value-objects/notification-channel.vo';
import type { NotificationTemplate } from '../../domain/value-objects/notification-template.vo';
import type {
  NotificationOutcome,
  NotificationRecipient,
} from '../../domain/notification.aggregate';
import type { NotificationId } from '../../domain/value-objects/notification-id.vo';

/** One channel's outcome as the caller sees it. */
export interface ChannelDeliverySummary {
  readonly channel: NotificationChannel;
  readonly status: DeliveryStatus;
  readonly error?: string;
}

export interface SendNotificationResult {
  /** A plain string: this result crosses a transport boundary and a caller must not reach in. */
  readonly notificationId: string;
  readonly template: NotificationTemplate;
  readonly outcome: NotificationOutcome;
  readonly deliveries: readonly ChannelDeliverySummary[];
  /**
   * Variables dropped before publishing because they looked like a secret.
   *
   * @remarks Reported so a caller can tell "sent, with nothing redacted" from "sent, and a
   * producer is putting an email address in our templates". The second is a bug somewhere
   * else, and this is the only signal that crosses the process boundary saying so.
   */
  readonly redactedVariables: readonly string[];
}

/**
 * Renders a template and delivers it.
 *
 * @remarks Carries the recipient *separately* from the variables. That separation is what lets
 * `welcome` be delivered to an address while the event announcing it carries none: the address
 * is a delivery target, and folding it into `variables` would put it one careless edit away
 * from a published payload.
 */
export class SendNotificationCommand extends Command<SendNotificationResult> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly template: NotificationTemplate,
    readonly userId: string,
    readonly recipient: NotificationRecipient,
    readonly variables: Readonly<Record<string, unknown>> = {},
    /** Overrides the template's own channels when present. */
    readonly channels?: readonly NotificationChannel[],
    readonly correlationId?: string,
  ) {
    super();
  }
}

export interface MarkNotificationReadResult {
  /** A plain string, for the same reason as {@link SendNotificationResult.notificationId}. */
  readonly notificationId: string;
  readonly read: boolean;
  readonly readAt: string | null;
  /** False when it was already read, so a double-click announces one read rather than two. */
  readonly changed: boolean;
}

/** Marks a notification read. Idempotent by design, not by accident. */
export class MarkNotificationReadCommand extends Command<MarkNotificationReadResult> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly notificationId: NotificationId,
    readonly userId: string,
    readonly now?: Date,
    readonly correlationId?: string,
  ) {
    super();
  }
}

/**
 * The mapping from an event route to a command.
 *
 * @remarks Named `to…` like the siblings: a factory is what lets the caller hand over a plain
 * record and get a *class* back, so nothing outside this file ever constructs the object
 * literal that CQRS cannot dispatch.
 */
export const toSendNotificationCommand = (instruction: {
  userId: string;
  template: NotificationTemplate;
  recipient: NotificationRecipient;
  channels?: readonly NotificationChannel[];
  variables: Readonly<Record<string, unknown>>;
  correlationId?: string;
}): SendNotificationCommand =>
  new SendNotificationCommand(
    instruction.template,
    instruction.userId,
    instruction.recipient,
    instruction.variables,
    instruction.channels,
    instruction.correlationId,
  );

export const toMarkNotificationReadCommand = (input: {
  notificationId: NotificationId;
  userId: string;
  now?: Date;
  correlationId?: string;
}): MarkNotificationReadCommand =>
  new MarkNotificationReadCommand(
    input.notificationId,
    input.userId,
    input.now,
    input.correlationId,
  );