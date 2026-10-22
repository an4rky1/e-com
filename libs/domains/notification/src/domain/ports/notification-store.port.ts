/**
 * @fileoverview Where a notification record is written and read back.
 *
 * @remarks The store is the seam. The durable implementation files a record in
 * `notifications` with one `notification_deliveries` row per channel and announces the
 * dispatch on an `outbox_events` row in the same transaction, and the port is what lets a
 * different backing store replace that without the handlers knowing.
 *
 * @remarks Every write must commit the record *and* its outbox rows together. A notification
 * whose `notification.dispatched` row is missing means a downstream consumer never learns an
 * email went out, and one whose record is missing means the read models cannot say whether the
 * user saw it.
 *
 * @remarks Nothing in this file names a table. A record is not an event and an event is not a
 * record, and a port that said otherwise would put that confusion in the one file every caller
 * reads.
 */
import type { DeliveryStatus, NotificationChannel } from '../value-objects/notification-channel.vo';
import type { Notification } from '../notification.aggregate';
import type { NotificationId } from '../value-objects/notification-id.vo';

export const NOTIFICATION_STORE = Symbol('NOTIFICATION_STORE');

export interface NotificationListOptions {
  readonly limit?: number;
  /** Defaults to 50. Clamped by the caller's `maxPageSize` before it reaches here. */
  readonly unreadOnly?: boolean;
}

export interface NotificationDeliverySummary {
  readonly channel: NotificationChannel;
  readonly status: DeliveryStatus;
  readonly error?: string;
  readonly deliveredAt: string;
}

export interface NotificationStorePort {
  /**
   * Persists the aggregate and drains its events into the outbox, in one transaction.
   *
   * @remarks Also the moment the `notification.dispatched` announcement is written. Both halves
   * must land together or neither should.
   */
  save(notification: Notification): Promise<void>;

  findById(id: NotificationId): Promise<Notification | null>;

  /**
   * One user's notifications, newest first.
   *
   * @remarks `unreadOnly` is a filter rather than a separate method because "the unread badge"
   * and "the notification list" are the same query with a predicate, and two methods over one
   * table is where the two answers drift apart.
   */
  findByUser(userId: string, options?: NotificationListOptions): Promise<readonly Notification[]>;

  /** Unread count for the badge. Zero is also the answer for a user who has none. */
  countUnread(userId: string): Promise<number>;
}