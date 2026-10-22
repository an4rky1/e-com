/**
 * @fileoverview Durable notification records, and the outbox announcements beside them.
 *
 * @remarks This service's schema owns three things: `notifications`,
 * `notification_deliveries`, and `outbox_events`. A *record* is a row in `notifications` with
 * one `notification_deliveries` row per channel; an *announcement* is a row in
 * `outbox_events`, because that table means "rows the relay publishes to Kafka" and an
 * announcement is exactly that.
 *
 * @remarks The two are kept apart on purpose. `outbox_events` used to double as the record
 * table, distinguished only by a namespaced `type` and a `status` that was never `pending` — a
 * convention, not a constraint. A record written `pending` would have been published to a
 * topic every other service subscribes to, and the table's meaning was gone for every future
 * reader. Now a record cannot be published even by mistake, because there is nowhere in the
 * record's own write to put it.
 *
 * @remarks One deliberate exception remains, and it is in {@link PrismaConsumerClaimStore}
 * rather than here: `notification.consumer.claim` rows still live in `outbox_events`, written
 * `status = 'published'` precisely so the relay — which claims only `pending` — never picks
 * them up. They stay because the unique index on `(dedup_key, type)` is the idempotency
 * primitive this database offers, and a claim is terminal the moment it exists.
 *
 * @remarks Note what is deliberately absent from a stored record: no `recipient`, no rendered
 * body, no address-shaped variable. `announcementFor` chooses the published field list and
 * `assertPublishable` refuses the write outright if anything address-shaped survived, and the
 * durable copy follows the same rule — a notification row is not a copy of a user's contact
 * details.
 *
 * @remarks Everything this service owns is typed, never `any` — and the generated client is
 * imported for its *types* only. It is an ESM module that cannot be loaded by the CommonJS jest
 * transform, so a value import would make this file untestable.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PrismaService } from '@auth/infra/prisma';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import {
  NOTIFICATION_STORE,
  type NotificationListOptions,
  type NotificationStorePort,
} from '../../domain/ports/notification-store.port';
import { NOTIFICATION_PRISMA } from '../../notification.config';
import {
  Notification,
  NO_RECIPIENT,
  type ChannelDelivery,
} from '../../domain/notification.aggregate';
import { announcementFor } from '../../domain/notification-announcement';
import {
  DeliveryStatus,
  NotificationChannel,
  type NotificationSeverity,
} from '../../domain/value-objects/notification-channel.vo';
import type {
  NotificationTemplate,
  NotificationVariables,
} from '../../domain/value-objects/notification-template.vo';
import { NotificationId } from '../../domain/value-objects/notification-id.vo';

/**
 * Record lifecycle, expressed in `notifications.status`.
 *
 * @remarks Reusing the row's own `status` column rather than a JSON flag is what makes "how
 * many unread does this user have?" a `count()` over an indexed column. Filtering it in memory
 * instead would turn a badge render into a full scan of the user's notifications.
 */
export const RECORD_STATUS = {
  UNREAD: 'unread',
  READ: 'read',
} as const;

/** Domain event -> the topic its announcement rides on. */
export const TOPIC_BY_EVENT: Readonly<Record<string, string>> = {
  'notification.dispatched': 'platform.notification.dispatched.v1',
  'notification.read': 'platform.notification.read.v1',
};

/**
 * Topics this service publishes on.
 *
 * @remarks Declared here rather than added to `@auth/contracts` because that lib is shared by
 * every service, and a topic added to it is a promise that every producer and consumer agrees
 * on. Promoting these two is a contracts change and should be made as one, deliberately, when a
 * second service actually needs to subscribe.
 */
export const NOTIFICATION_TOPICS = {
  DISPATCHED: TOPIC_BY_EVENT['notification.dispatched'],
  READ: TOPIC_BY_EVENT['notification.read'],
} as const;

/** Default page size when the caller names none. */
const DEFAULT_LIMIT = 50;

/**
 * The order deliveries come back in.
 *
 * @remarks Attempt order where the timestamps differ, which is what the aggregate records.
 * `channel` breaks the tie, because two channels attempted inside the same millisecond have no
 * other durable order between them and an unstable one would make the same read model differ
 * between two reads of the same row.
 */
const DELIVERY_ORDER: Prisma.notification_deliveriesOrderByWithRelationInput[] = [
  { created_at: 'asc' },
  { channel: 'asc' },
];

@Injectable()
export class PrismaNotificationStore implements NotificationStorePort {
  private readonly logger = new Logger(PrismaNotificationStore.name);

  constructor(
    @Inject(NOTIFICATION_PRISMA) private readonly prisma: PrismaService<PrismaClient>,
  ) {}

  /**
   * Writes the record, its per-channel deliveries, and every announcement it produced — in one
   * transaction.
   *
   * @remarks One `runInTransaction` for all three halves, which is the whole point: a record
   * with no `notification.dispatched` row means a downstream consumer never learns an email
   * went out, and an announcement with no record means a consumer can tell a message was sent
   * but not whether the user ever saw it.
   *
   * @remarks The record row's primary key *is* the notification id, so the write is an upsert
   * rather than an append. That is what makes `markRead` an ordinary `save` instead of a
   * special-case update, and it is why there can never be two records for one notification.
   *
   * @remarks `skipDuplicates: true` on the announcements, against the unique index on
   * `(dedup_key, type)`. A redelivered event that slipped past the claim cannot become a
   * second `notification.dispatched` — a second layer of protection behind the claim, not a
   * replacement for it.
   */
  async save(notification: Notification): Promise<void> {
    const events = notification.clearDomainEvents();
    // Built before the transaction opens: the redaction guard is a refusal, and a refusal
    // should cost a query rather than an open transaction.
    const announcement = announcementFor(notification);

    await this.prisma.runInTransaction(async (client) => {
      const row = this.recordRow(notification);

      await client.notifications.upsert({
        where: { id: row.id },
        create: { ...row, deduplicated: false },
        // Rewritten wholesale rather than patched: the row *is* the projection, and a partial
        // update would have to enumerate every field that can change — which is the list
        // that silently goes stale when a new field is added.
        update: {
          user_id: row.user_id,
          template: row.template,
          severity: row.severity,
          status: row.status,
          channels: row.channels,
          variables: row.variables,
          payload: row.payload,
          updated_at: row.updated_at,
          read_at: row.read_at,
          created_at: row.created_at,
          // Reaching this branch at all *is* the proof that the record already existed, so the
          // flag costs nothing to keep accurate. It is what makes "this id was written twice"
          // a query rather than an inference from a log.
          deduplicated: true,
        },
      });

      await this.writeDeliveries(client, notification);

      if (events.length === 0) return;

      await client.outbox_events.createMany({
        data: events.map((event) => ({
          id: event.eventId,
          type: event.eventType,
          aggregate_type: event.aggregateType,
          aggregate_id: notification.id.value,
          topic: TOPIC_BY_EVENT[event.eventType] ?? NOTIFICATION_TOPICS.DISPATCHED,
          payload: (event.eventType === 'notification.dispatched'
            ? announcement
            : readEventPayload(event)) as unknown as Prisma.InputJsonValue,
          // `<type>:<aggregateId>:<version>` — the aggregate version, not a clock or a uuid,
          // so a redelivered event lands on the same key and is a no-op.
          dedup_key: `${event.eventType}:${notification.id.value}:${event.version}`,
          status: 'pending',
          attempts: 0,
          next_attempt_at: new Date(),
          trace_id: event.correlationId ?? notification.id.value,
        })),
        skipDuplicates: true,
      });
    });
  }

  async findById(id: NotificationId): Promise<Notification | null> {
    const row = await this.prisma.tx.notifications.findUnique({
      where: { id: id.value },
      include: { deliveries: { orderBy: DELIVERY_ORDER } },
    });

    // The primary key is a plain uuid, so there is no announcement row to mistake for a record.
    if (!row) return null;

    return fromStoredNotification(row);
  }

  /**
   * One user's notifications, newest first.
   *
   * @remarks `user_id` is a column rather than a path into a JSON payload, and it is the
   * leading column of the `(user_id, created_at desc)` index, so this list and its ordering are
   * both index reads.
   */
  async findByUser(
    userId: string,
    options: NotificationListOptions = {},
  ): Promise<readonly Notification[]> {
    const rows = await this.prisma.tx.notifications.findMany({
      where: {
        user_id: userId,
        ...(options.unreadOnly ? { status: RECORD_STATUS.UNREAD } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: options.limit ?? DEFAULT_LIMIT,
      include: { deliveries: { orderBy: DELIVERY_ORDER } },
    });

    return rows
      .map((row) => fromStoredNotification(row))
      .filter((notification): notification is Notification => notification !== null);
  }

  /**
   * Unread count for the badge.
   *
   * @remarks A `count()`, not a fetch-and-filter. A user with thousands of notifications would
   * otherwise make a badge render read every one of them.
   */
  async countUnread(userId: string): Promise<number> {
    return this.prisma.tx.notifications.count({
      where: { user_id: userId, status: RECORD_STATUS.UNREAD },
    });
  }

  /** The record row, in the shape `create` and `update` both take. */
  private recordRow(notification: Notification) {
    return {
      // The primary key *is* the notification id, which is what makes `save` an upsert rather
      // than an append and guarantees there can never be two records for one notification.
      id: notification.id.value,
      user_id: notification.userId,
      template: notification.template,
      severity: notification.severity,
      status: notification.isRead ? RECORD_STATUS.READ : RECORD_STATUS.UNREAD,
      channels: [...notification.channels] as unknown as Prisma.InputJsonValue,
      // Already redacted by the dispatch loop before it reached the aggregate; stored as it
      // stands rather than re-filtered here, so there is one redaction rule and not two.
      variables: { ...notification.variables } as unknown as Prisma.InputJsonValue,
      // The stored copy deliberately omits `recipient` and the rendered body: a notification
      // row is not a contact record. What does not fit a column lives here — and only what
      // genuinely has no column of its own, because a second copy of a delivery is a copy that
      // can disagree with the first.
      payload: toStoredPayload(notification) as unknown as Prisma.InputJsonValue,
      created_at: notification.createdAt,
      updated_at: notification.updatedAt,
      read_at: notification.readAt,
    };
  }

  /**
   * One `notification_deliveries` row per channel, upserted on `(notification_id, channel)`.
   *
   * @remarks A loop rather than one `createMany`, because each row carries its own status and
   * error and `createMany` cannot write different values per row. The loop is bounded by the
   * channel set — four rows, and typically two — and it runs inside the caller's transaction,
   * so a retry that finds half of them already written still commits one whole notification.
   *
   * @remarks `created_at` is written from the delivery's own timestamp rather than left to
   * `now()`: Postgres' `now()` is the *transaction* start, so four rows written in one
   * transaction would all carry the same value and the read order would be arbitrary.
   */
  private async writeDeliveries(
    client: PrismaClient,
    notification: Notification,
  ): Promise<void> {
    for (const delivery of notification.deliveries) {
      const dispatchedAt = delivery.deliveredAt;

      await client.notification_deliveries.upsert({
        where: {
          notification_id_channel: {
            notification_id: notification.id.value,
            channel: delivery.channel,
          },
        },
        create: {
          notification_id: notification.id.value,
          channel: delivery.channel,
          status: delivery.status,
          error: delivery.error ?? null,
          dispatched_at: dispatchedAt,
          created_at: dispatchedAt,
          updated_at: dispatchedAt,
        },
        update: {
          status: delivery.status,
          error: delivery.error ?? null,
          dispatched_at: dispatchedAt,
          updated_at: dispatchedAt,
        },
      });
    }
  }
}

/**
 * The half of the record with no column of its own.
 *
 * @remarks Three fields, and the absences are the point: no `recipient`, no rendered `body`.
 * The body is derived from the template and the variables, so storing it would be storing a
 * second copy of data that can disagree with its own inputs — and no read model needs it.
 *
 * @remarks `providerMessageIds` is keyed by channel rather than nested, so a delivery row and
 * its bookkeeping stay side by side instead of being joined back together at read time.
 */
interface StoredPayload {
  readonly subject: string;
  readonly redactedVariables: readonly string[];
  readonly providerMessageIds: Readonly<Record<string, string>>;
}

function toStoredPayload(notification: Notification): StoredPayload {
  const providerMessageIds: Record<string, string> = {};
  for (const delivery of notification.deliveries) {
    if (delivery.providerMessageId) {
      providerMessageIds[delivery.channel] = delivery.providerMessageId;
    }
  }

  return {
    subject: notification.subject,
    redactedVariables: [...notification.redactedVariables],
    providerMessageIds,
  };
}

/** A stored record with its deliveries already joined in. */
interface StoredNotificationRow {
  readonly id: string;
  readonly user_id: string;
  readonly template: string;
  readonly severity: string;
  readonly status: string;
  readonly channels: unknown;
  readonly variables: unknown;
  readonly payload: unknown;
  readonly created_at: Date;
  readonly read_at: Date | null;
  readonly deliveries?: readonly {
    readonly channel: string;
    readonly status: string;
    readonly error: string | null;
    readonly dispatched_at: Date | null;
    readonly created_at: Date;
  }[];
}

/**
 * Rebuilds an aggregate from a stored row.
 *
 * @remarks `null` for a row that cannot be rebuilt. A row written by an older version of this
 * service is a normal thing to find after a deploy, and throwing would make the whole
 * notification list unavailable because of one record; skipping it makes that record the only
 * casualty.
 *
 * @remarks The deliveries come from their own table rather than from `payload`, so a channel's
 * outcome is a row a query can filter on — "which email sends failed last week" is a `count()`
 * over an indexed column instead of a scan of a JSON array.
 */
function fromStoredNotification(row: StoredNotificationRow): Notification | null {
  const payload = readStoredPayload(row.payload);
  if (!payload) return null;

  const createdAt = row.created_at;
  const deliveries: readonly ChannelDelivery[] = (row.deliveries ?? []).flatMap((delivery) => {
    if (!isChannel(delivery.channel) || !isDeliveryStatus(delivery.status)) return [];

    const providerMessageId = payload.providerMessageIds[delivery.channel];

    return [
      {
        channel: delivery.channel,
        status: delivery.status,
        ...(providerMessageId ? { providerMessageId } : {}),
        ...(delivery.error ? { error: delivery.error } : {}),
        // `dispatched_at` is when the channel was *attempted*, which is what the aggregate
        // records; a skipped or failed attempt has a timestamp too, and losing it would make
        // "why did nothing arrive" unanswerable.
        deliveredAt: delivery.dispatched_at ?? delivery.created_at ?? createdAt,
      },
    ];
  });

  return Notification.fromRecord({
    id: NotificationId.fromStored(row.id),
    userId: row.user_id,
    template: row.template as NotificationTemplate,
    subject: payload.subject,
    // Not persisted, and deliberately so — see {@link StoredPayload}.
    body: '',
    severity: row.severity as NotificationSeverity,
    variables: readVariables(row.variables),
    recipient: NO_RECIPIENT,
    channels: readChannels(row.channels).filter(isChannel),
    deliveries,
    redactedVariables: payload.redactedVariables.filter(
      (name): name is string => typeof name === 'string',
    ),
    // Read state lives in its own nullable column rather than in `status`, so "when was this
    // read" is answerable without parsing a status string.
    readAt: row.read_at,
    createdAt,
  });
}

function isChannel(value: string): value is NotificationChannel {
  return (Object.values(NotificationChannel) as string[]).includes(value);
}

function isDeliveryStatus(value: unknown): value is DeliveryStatus {
  return (
    typeof value === 'string' &&
    (Object.values(DeliveryStatus) as string[]).includes(value)
  );
}

/**
 * The JSON half of a record.
 *
 * @remarks `null` for a row that has none, which is the only thing that makes a row
 * unrebuildable. A claim row and an announcement row cannot reach this function at all — they
 * are not in `notifications` — so there is no discriminator to check here any more.
 */
function readStoredPayload(payload: unknown): StoredPayload | null {
  const candidate = payload as Partial<StoredPayload> | null;
  if (typeof candidate !== 'object' || candidate === null) return null;

  return {
    subject: typeof candidate.subject === 'string' ? candidate.subject : '',
    redactedVariables: Array.isArray(candidate.redactedVariables)
      ? candidate.redactedVariables
      : [],
    providerMessageIds:
      typeof candidate.providerMessageIds === 'object' && candidate.providerMessageIds !== null
        ? (candidate.providerMessageIds as Record<string, string>)
        : {},
  };
}

/** Narrows a JSON column to a string map; anything else is an empty set of variables. */
function readVariables(variables: unknown): NotificationVariables {
  if (typeof variables !== 'object' || variables === null || Array.isArray(variables)) {
    return {};
  }

  return variables as NotificationVariables;
}

/** Narrows a JSON column to a list of channel names; a malformed column is an empty one. */
function readChannels(channels: unknown): string[] {
  return Array.isArray(channels) ? channels.filter((entry) => typeof entry === 'string') : [];
}

/**
 * A domain event's own payload.
 *
 * @remarks A widening cast rather than an interface: `IDomainEvent` carries no `payload`
 * field by design — it is the transport shape, and a payload is the concrete event's business.
 */
function readEventPayload(event: unknown): unknown {
  const candidate = event as { payload?: unknown } | null;
  return candidate?.payload ?? {};
}

export { NOTIFICATION_STORE };