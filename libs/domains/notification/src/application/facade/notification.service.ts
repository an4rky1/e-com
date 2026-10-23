/**
 * @fileoverview The only public surface of the notification module.
 *
 * @remarks Controllers, gRPC handlers and other services depend on this class and nothing
 * else. They therefore cannot reach the store, the CQRS bus or the aggregate — which is what
 * makes the module's internals replaceable without touching a single caller.
 *
 * @remarks Every method takes and returns plain data. The command classes are an implementation
 * detail of the bus: a caller that could construct them directly would be able to bypass the
 * policy this facade is meant to front.
 */
import { Injectable } from '@nestjs/common';
// Value import, not `import type`: these are constructor-injected, and
// `emitDecoratorMetadata` reads the emitted value binding to resolve them.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { CommandBus, QueryBus } from '@nestjs/cqrs';

import {
  MarkNotificationReadCommand,
  SendNotificationCommand,
  type MarkNotificationReadResult,
  type SendNotificationResult,
} from '../commands/notification.commands';
import {
  GetNotificationStatusQuery,
  ListNotificationsQuery,
  type NotificationListReadModel,
  type NotificationReadModel,
} from '../queries/notification.queries';
import type { NotificationChannel } from '../../domain/value-objects/notification-channel.vo';
import type { NotificationTemplate } from '../../domain/value-objects/notification-template.vo';
import type { NotificationRecipient } from '../../domain/notification.aggregate';
import { NotificationId } from '../../domain/value-objects/notification-id.vo';

@Injectable()
export class NotificationService {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  /**
   * Renders a template and delivers it on the channels the template names.
   *
   * @remarks `recipient` is a separate argument from `variables` on purpose. An address is a
   * delivery target; putting it in the variable bag is how an address ends up in a published
   * event one edit later.
   *
   * @returns the per-channel outcome, including the channels that failed. This resolves even
   * when every channel failed: the failure is recorded and returned rather than thrown,
   * because a throw here would put a provider outage into an unbounded retry.
   */
  sendNotification(input: {
    template: NotificationTemplate;
    userId: string;
    recipient: NotificationRecipient;
    variables?: Readonly<Record<string, unknown>>;
    channels?: readonly NotificationChannel[];
    correlationId?: string;
  }): Promise<SendNotificationResult> {
    return this.commandBus.execute<SendNotificationResult>(
      new SendNotificationCommand(
        input.template,
        input.userId,
        input.recipient,
        input.variables ?? {},
        input.channels,
        input.correlationId,
      ),
    );
  }

  /**
   * Marks a notification read.
   *
   * @remarks Idempotent: a second call resolves with `changed: false` rather than failing, so a
   * double-click on "mark all read" is not an error.
   */
  markRead(input: {
    notificationId: string;
    userId: string;
    now?: Date;
    correlationId?: string;
  }): Promise<MarkNotificationReadResult> {
    if (!NotificationId.isValid(input.notificationId)) {
      throw new Error(`"${input.notificationId}" is not a notification id`);
    }

    return this.commandBus.execute<MarkNotificationReadResult>(
      new MarkNotificationReadCommand(
        NotificationId.create(input.notificationId),
        input.userId,
        input.now,
        input.correlationId,
      ),
    );
  }

  /**
   * A user's notifications, newest first.
   *
   * @remarks `limit` is clamped against the configured `maxPageSize`. It is the one query a
   * user-facing screen issues on every render, and an unbounded limit on a table that only
   * grows is a denial of service that stays invisible until the table is large.
   */
  listNotifications(input: {
    userId: string;
    limit?: number;
    unreadOnly?: boolean;
  }): Promise<NotificationListReadModel> {
    return this.queryBus.execute(
      new ListNotificationsQuery(input.userId, input.limit, input.unreadOnly ?? false),
    );
  }

  /**
   * One notification's delivery status.
   *
   * @returns `null` when it does not exist or is not this user's. The two are the same answer
   * on purpose: distinguishing them is an existence oracle over a bearer id.
   */
  getNotificationStatus(input: {
    notificationId: string;
    userId: string;
  }): Promise<NotificationReadModel | null> {
    return this.queryBus.execute(
      new GetNotificationStatusQuery(input.notificationId, input.userId),
    );
  }

  /** Re-exported so a caller can build an id without importing the kernel. */
  toNotificationId(value: string): NotificationId {
    return NotificationId.create(value);
  }
}