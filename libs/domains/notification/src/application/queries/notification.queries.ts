/**
 * @fileoverview Read models for a user's notifications.
 *
 * @remarks Like every other query in this workspace it is a class: `QueryBus.execute` resolves
 * a handler from `query.constructor`, and `@QueryHandler('Name')` throws at import because
 * `Reflect.hasOwnMetadata` rejects a non-object.
 *
 * @remarks No rendered `body` and no `recipient` in either model. A list of a user's
 * notifications is exactly the payload a client would cache, log on a debug screen, or hand
 * to a support agent, and neither of those needs the address a message went to.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Query, QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import {
  NOTIFICATION_STORE,
  type NotificationStorePort,
} from '../../domain/ports/notification-store.port';
import type { Notification } from '../../domain/notification.aggregate';
import type { NotificationTemplate } from '../../domain/value-objects/notification-template.vo';
import type {
  DeliveryStatus,
  NotificationChannel,
  NotificationSeverity,
} from '../../domain/value-objects/notification-channel.vo';
import { NOTIFICATION_CONFIG, type NotificationConfig } from '../../notification.config';
import { NotificationId } from '../../domain/value-objects/notification-id.vo';

export interface NotificationReadModel {
  readonly id: string;
  readonly userId: string;
  readonly template: NotificationTemplate;
  readonly subject: string;
  readonly severity: NotificationSeverity;
  readonly channels: readonly NotificationChannel[];
  readonly deliveries: readonly {
    readonly channel: NotificationChannel;
    readonly status: DeliveryStatus;
    readonly error?: string;
    readonly deliveredAt: string;
  }[];
  readonly read: boolean;
  readonly readAt: string | null;
  readonly redactedVariables: readonly string[];
  readonly createdAt: string;
}

/** Projection helper, shared by both queries so the two shapes cannot drift apart. */
export const toNotificationReadModel = (n: Notification): NotificationReadModel => ({
  id: n.id.value,
  userId: n.userId,
  template: n.template,
  subject: n.subject,
  severity: n.severity,
  channels: n.channels,
  deliveries: n.deliveries.map((delivery) => ({
    channel: delivery.channel,
    status: delivery.status,
    ...(delivery.error ? { error: delivery.error } : {}),
    deliveredAt: delivery.deliveredAt.toISOString(),
  })),
  read: n.isRead,
  readAt: n.readAt?.toISOString() ?? null,
  redactedVariables: n.redactedVariables,
  createdAt: n.createdAt.toISOString(),
});

export interface NotificationListReadModel {
  readonly data: readonly NotificationReadModel[];
  readonly unread: number;
  readonly total: number;
  readonly limit: number;
}

export class ListNotificationsQuery extends Query<NotificationListReadModel> {
  readonly queryId: string = crypto.randomUUID();

  constructor(
    readonly userId: string,
    readonly limit?: number,
    readonly unreadOnly = false,
  ) {
    super();
  }
}

@Injectable()
@QueryHandler(ListNotificationsQuery)
export class ListNotificationsHandler
  implements IQueryHandler<ListNotificationsQuery, NotificationListReadModel>
{
  constructor(
    @Inject(NOTIFICATION_STORE) private readonly store: NotificationStorePort,
    @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationConfig,
  ) {}

  /**
   * @remarks `limit` is clamped against `maxPageSize` here rather than trusted. This is the
   * one query a user-facing screen issues on every render, and an unbounded `limit` on a table
   * that only ever grows is a denial of service that stays invisible until the table is large.
   */
  async execute(query: ListNotificationsQuery): Promise<NotificationListReadModel> {
    const limit = Math.min(
      Math.max(query.limit ?? this.config.maxPageSize, 1),
      this.config.maxPageSize,
    );

    const [rows, unread] = await Promise.all([
      this.store.findByUser(query.userId, {
        limit,
        unreadOnly: query.unreadOnly,
      }),
      this.store.countUnread(query.userId),
    ]);

    return {
      data: rows.map(toNotificationReadModel),
      unread,
      total: rows.length,
      limit,
    };
  }
}

/** Per-notification delivery status, for a support conversation about one message. */
export class GetNotificationStatusQuery extends Query<NotificationReadModel | null> {
  readonly queryId: string = crypto.randomUUID();

  constructor(
    readonly notificationId: string,
    readonly userId: string,
  ) {
    super();
  }
}

@Injectable()
@QueryHandler(GetNotificationStatusQuery)
export class GetNotificationStatusHandler
  implements IQueryHandler<GetNotificationStatusQuery, NotificationReadModel | null>
{
  constructor(@Inject(NOTIFICATION_STORE) private readonly store: NotificationStorePort) {}

  /**
   * @remarks `null` rather than a throw for a notification that does not exist or belongs to
   * somebody else. The two are indistinguishable *to the caller* on purpose: a 404 for
   * "exists but is not yours" is an existence oracle over a bearer id.
   */
  async execute(query: GetNotificationStatusQuery): Promise<NotificationReadModel | null> {
    if (!NotificationId.isValid(query.notificationId)) return null;

    const notification = await this.store.findById(
      NotificationId.create(query.notificationId),
    );

    if (!notification || notification.userId !== query.userId) return null;

    return toNotificationReadModel(notification);
  }
}