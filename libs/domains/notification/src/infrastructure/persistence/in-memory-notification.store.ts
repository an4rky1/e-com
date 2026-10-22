/**
 * @fileoverview Process-local notification store.
 *
 * @remarks Bound when `NOTIFICATION_STORE_MODE=memory`, and the store the unit tests use. It is
 * a genuine implementation of the port rather than a mock — it performs the same redaction,
 * builds the same announcements and keeps the same two halves the durable one keeps — so a test
 * that passes against it is testing the behaviour, not the double.
 *
 * @remarks The split matters here as much as it does in Postgres: records go in
 * {@link InMemoryNotificationStore.records}, exactly as they go in the `notifications` table,
 * and `outbox` holds announcements only, exactly as `outbox_events` now does. A double that
 * also filed records as "outbox rows" would keep a test passing that the durable store no
 * longer satisfies.
 *
 * @remarks It is *not* a substitute for the durable store and says so here rather than only in
 * a comment somewhere else: it loses everything on restart and it is invisible to a second
 * replica. Two pods behind one load balancer would each claim half the events and answer
 * "which notifications does this user have?" with half the truth.
 */
import { Logger } from '@nestjs/common';
import {
  NOTIFICATION_STORE,
  type NotificationListOptions,
  type NotificationStorePort,
} from '../../domain/ports/notification-store.port';
import type { Notification } from '../../domain/notification.aggregate';
import type { NotificationId } from '../../domain/value-objects/notification-id.vo';
import type {
  DeliveryStatus,
  NotificationChannel,
} from '../../domain/value-objects/notification-channel.vo';
import { announcementFor } from '../../domain/notification-announcement';

/** What the durable adapter writes to `outbox_events`, and what this one keeps in memory. */
export interface CapturedOutboxEvent {
  readonly id: string;
  readonly type: string;
  readonly aggregateId: string;
  readonly topic: string;
  readonly payload: unknown;
  readonly dedupKey: string;
}

/**
 * One `notification_deliveries` row, as the durable store would write it.
 *
 * @remarks Same shape as {@link CapturedOutboxEvent} for the same reason: a per-channel
 * outcome that only exists inside an aggregate is a fact no test can assert on, and the
 * durable store puts each one in its own row.
 */
export interface CapturedDelivery {
  readonly notificationId: string;
  readonly channel: NotificationChannel;
  readonly status: DeliveryStatus;
  readonly error?: string;
  readonly dispatchedAt: Date;
}

/**
 * The records and announcements a durable `save` would produce.
 *
 * @remarks Exposed rather than private because the redaction rule is only enforceable if
 * something can read what would be published. A test that cannot see the payload cannot prove
 * an address is absent from it.
 */
export class InMemoryNotificationStore implements NotificationStorePort {
  private readonly logger = new Logger(InMemoryNotificationStore.name);

  /** The `notifications` table: a record per id, updated in place by a second save. */
  readonly records = new Map<string, Notification>();

  /** The `outbox_events` table: announcements only. Never a record, never a claim. */
  readonly outbox: CapturedOutboxEvent[] = [];

  /** The `notification_deliveries` table: one row per channel per notification. */
  readonly deliveries: CapturedDelivery[] = [];

  /**
   * How many times a save committed.
   *
   * @remarks The atomicity guarantee is "the record and the event commit together", and the
   * only honest way to test a transactional claim without a database is to count commits and
   * assert that one save produced both halves.
   */
  transactions = 0;

  constructor(
    private readonly topicFor: (type: string) => string,
    seed: readonly Notification[] = [],
  ) {
    for (const notification of seed) {
      // A seeded notification stands for a row already in the database, so its events have
      // already been published. Draining keeps each test's assertions about *this* save.
      notification.clearDomainEvents();
      this.records.set(notification.id.value, notification);
      this.writeDeliveries(notification);
    }
  }

  /**
   * Writes the record and its announcement, then drains the buffer.
   *
   * @remarks Order is the guarantee: the record lands first so the announcement is never ahead
   * of the thing it announces, and the buffer is drained last so a second `save` of the same
   * aggregate cannot re-insert a row the first one already wrote.
   *
   * @remarks A re-save replaces the deliveries for the channels it names rather than appending,
   * mirroring the `(notification_id, channel)` upsert the durable store does. A retry that
   * succeeded after a failure must leave one outcome, not `failed, sent`.
   */
  async save(notification: Notification): Promise<void> {
    this.transactions += 1;

    const events = notification.clearDomainEvents();
    const announcement = announcementFor(notification);

    this.records.set(notification.id.value, notification);
    this.writeDeliveries(notification);

    for (const event of events) {
      const payload =
        event.eventType === 'notification.dispatched'
          ? announcement
          : readPayload(event);

      this.outbox.push({
        id: event.eventId,
        type: event.eventType,
        aggregateId: notification.id.value,
        topic: this.topicFor(event.eventType),
        payload,
        // Mirrors the durable adapter exactly: `<type>:<aggregateId>:<version>`, unique per
        // type. A test that asserts on this key is asserting on what the database indexes.
        dedupKey: `${event.eventType}:${notification.id.value}:${event.version}`,
      });
    }
  }

  async findById(id: NotificationId): Promise<Notification | null> {
    return this.records.get(id.value) ?? null;
  }

  async findByUser(
    userId: string,
    options: NotificationListOptions = {},
  ): Promise<readonly Notification[]> {
    const rows = [...this.records.values()]
      .filter((notification) => notification.userId === userId)
      .filter((notification) => (options.unreadOnly ? !notification.isRead : true))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());

    return options.limit === undefined ? rows : rows.slice(0, options.limit);
  }

  async countUnread(userId: string): Promise<number> {
    const rows = [...this.records.values()].filter(
      (notification) => notification.userId === userId && !notification.isRead,
    );
    return rows.length;
  }

  /** The announcements a redaction test reads. */
  announcementsFor(type: string): readonly CapturedOutboxEvent[] {
    return this.outbox.filter((row) => row.type === type);
  }

  /** One channel's stored outcome, the way a row in `notification_deliveries` would read. */
  deliveryFor(notificationId: string, channel: NotificationChannel): CapturedDelivery | null {
    return (
      this.deliveries.find(
        (row) => row.notificationId === notificationId && row.channel === channel,
      ) ?? null
    );
  }

  /**
   * Mirrors the `(notification_id, channel)` upsert the durable store performs.
   *
   * @remarks Replace-in-place rather than append, because that is the unique index's semantics:
   * a retry over `push` that succeeds must leave one outcome for that channel, not
   * `failed, sent`.
   */
  private writeDeliveries(notification: Notification): void {
    for (const delivery of notification.deliveries) {
      const existing = this.deliveries.findIndex(
        (row) =>
          row.notificationId === notification.id.value && row.channel === delivery.channel,
      );
      const row: CapturedDelivery = {
        notificationId: notification.id.value,
        channel: delivery.channel,
        status: delivery.status,
        ...(delivery.error ? { error: delivery.error } : {}),
        dispatchedAt: delivery.deliveredAt,
      };

      if (existing === -1) this.deliveries.push(row);
      else this.deliveries[existing] = row;
    }
  }
}

/**
 * A domain event's own payload, for the events that are not the dispatch announcement.
 *
 * @remarks A widening cast rather than an interface: `IDomainEvent` carries no `payload`
 * field by design — it is the transport shape and a payload is the concrete event's business.
 */
function readPayload(event: unknown): unknown {
  const candidate = event as { payload?: unknown };
  return candidate?.payload ?? {};
}

export { NOTIFICATION_STORE };