/**
 * @fileoverview The notification aggregate.
 *
 * @remarks A notification is not the message; it is the *record of trying to send a message*.
 * That distinction is the whole reason this service has an aggregate at all. The channels are
 * a set of independent attempts, so "the email failed but the push arrived" has to be a state
 * the model can hold, not an error the model refuses to represent.
 *
 * @remarks The rendered body and the recipient live here and are *not* publishable — see
 * `notification-announcement.ts`. Keeping them on the aggregate is what lets a channel adapter
 * deliver them, and keeping them off the announcement is what stops them reaching a topic.
 */
import { AggregateRoot, DomainEvent } from '@auth/core';
import {
  DeliveryStatus,
  NotificationChannel,
  type NotificationSeverity,
} from './value-objects/notification-channel.vo';
import type {
  NotificationTemplate,
  NotificationVariables,
} from './value-objects/notification-template.vo';
import { NotificationId } from './value-objects/notification-id.vo';

/** Re-exported so a caller of the aggregate needs one import for both halves. */
export { NotificationId };

/**
 * Where a notification is delivered.
 *
 * @remarks Three independent fields rather than one polymorphic address: a phone number is
 * not an email address, and a schema that treated them as interchangeable is how a user gets
 * an email containing their phone number.
 *
 * @remarks Absent fields are `null`, never `''`. An empty string survives a truthiness check
 * in enough places to become `undefined@`.
 */
export interface NotificationRecipient {
  readonly email: string | null;
  readonly phone: string | null;
  readonly deviceToken: string | null;
}

export const NO_RECIPIENT: NotificationRecipient = {
  email: null,
  phone: null,
  deviceToken: null,
};

/**
 * The address a given channel needs, or `null` when there is none.
 *
 * @remarks `inapp` returns `null` on purpose and callers must not read that as "unreachable":
 * an in-app notification needs no address because it is delivered to whoever opens the app.
 * `supports()` on a channel adapter is what decides reachability; this only answers "is there
 * something to send to".
 */
export const addressFor = (
  recipient: NotificationRecipient,
  channel: NotificationChannel,
): string | null => {
  switch (channel) {
    case NotificationChannel.EMAIL:
      return recipient.email;
    case NotificationChannel.SMS:
      return recipient.phone;
    case NotificationChannel.PUSH:
      return recipient.deviceToken;
    case NotificationChannel.INAPP:
      return null;
    default:
      return null;
  }
};

/** One channel's outcome. */
export interface ChannelDelivery {
  readonly channel: NotificationChannel;
  readonly status: DeliveryStatus;
  readonly providerMessageId?: string;
  readonly error?: string;
  readonly deliveredAt: Date;
}

/**
 * Public shape a publisher receives from a notification.
 *
 * @remarks Used by both the query projection and the announcement so the divergence between
 * "what a user can see" and "what leaves this service" stays a difference in fields, not a
 * divergence in when `deliveries` is populated.
 */
export interface NotificationPublicRecord {
  readonly id: NotificationId;
  readonly userId: string;
  readonly template: NotificationTemplate;
  readonly subject: string;
  readonly severity: NotificationSeverity;
  readonly channels: readonly NotificationChannel[];
  readonly deliveries: readonly ChannelDelivery[];
  readonly redactedVariables: readonly string[];
  readonly isRead: boolean;
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

/** What a whole notification's dispatch amounted to. */
export const NotificationOutcome = {
  /** Every requested channel delivered. */
  SENT: 'sent',
  /** Some channels delivered and some did not. */
  PARTIAL: 'partial',
  /** Nothing delivered, and at least one attempt failed. */
  FAILED: 'failed',
  /** Nothing could be attempted — there was nowhere to deliver it. */
  SKIPPED: 'skipped',
} as const;

export type NotificationOutcome = (typeof NotificationOutcome)[keyof typeof NotificationOutcome];

/** Buffered when every requested channel has been attempted. */
export class NotificationDispatched extends DomainEvent {
  readonly payload: Readonly<Record<string, unknown>>;

  constructor(
    aggregateId: NotificationId,
    userId: string,
    template: NotificationTemplate,
    outcome: NotificationOutcome,
    channels: readonly NotificationChannel[],
    correlationId?: string,
  ) {
    super(aggregateId.value, 'notification', 'notification.dispatched', 1, correlationId);
    this.payload = Object.freeze({
      userId,
      template,
      outcome,
      channels: [...channels],
    });
  }
}

/** Buffered when a user reads a notification. */
export class NotificationRead extends DomainEvent {
  readonly payload: Readonly<Record<string, unknown>>;

  constructor(
    aggregateId: NotificationId,
    userId: string,
    readAt: Date,
    correlationId?: string,
  ) {
    super(aggregateId.value, 'notification', 'notification.read', 1, correlationId);
    this.payload = Object.freeze({ userId, readAt: readAt.toISOString() });
  }
}

export interface NotificationRequest {
  readonly id?: NotificationId;
  readonly userId: string;
  readonly template: NotificationTemplate;
  readonly subject: string;
  readonly body: string;
  readonly severity: NotificationSeverity;
  readonly variables: NotificationVariables;
  /** Variables the content guard removed from {@link variables}, by name. */
  readonly redactedVariables?: readonly string[];
  readonly recipient: NotificationRecipient;
  readonly channels: readonly NotificationChannel[];
  readonly now?: Date;
  readonly correlationId?: string;
  /** Whether a rendering adapter may log the rendered body. Defaults to false. */
  readonly logBody?: boolean;
}

/** Everything {@link Notification.fromRecord} needs to rebuild a notification from storage. */
export interface NotificationRecord {
  readonly id: NotificationId;
  readonly userId: string;
  readonly template: NotificationTemplate;
  readonly subject: string;
  readonly body: string;
  readonly severity: NotificationSeverity;
  readonly variables: NotificationVariables;
  readonly recipient: NotificationRecipient;
  readonly channels: readonly NotificationChannel[];
  readonly deliveries: readonly ChannelDelivery[];
  readonly redactedVariables: readonly string[];
  readonly readAt: Date | null;
  readonly createdAt: Date;
  readonly logBody?: boolean;
}

export class Notification extends AggregateRoot<NotificationId> {
  private _readAt: Date | null = null;
  private _variables: NotificationVariables;
  private _redactedVariables: readonly string[] = [];
  private _deliveries: ChannelDelivery[] = [];
  private _logBody: boolean;

  private constructor(
    readonly userId: string,
    readonly template: NotificationTemplate,
    readonly subject: string,
    readonly body: string,
    readonly severity: NotificationSeverity,
    variables: NotificationVariables,
    readonly recipient: NotificationRecipient,
    readonly channels: readonly NotificationChannel[],
    id: NotificationId,
    createdAt: Date,
  ) {
    super(id, createdAt, createdAt);
    this._variables = variables;
    this._redactedVariables = [];
    this._logBody = false;
  }

  /**
   * Mints a notification whose channels have not been attempted yet.
   *
   * @remarks Buffers no domain event. `notification.dispatched` is only meaningful once every
   * channel has an outcome, and buffering a placeholder would either publish an event that
   * says "skipped" for a notification that was in fact delivered, or need replacing later —
   * which is exactly the kind of state a rebuild-from-events reader gets wrong.
   *
   * @remarks `id` is supplied rather than generated so a rebuild from storage reproduces the
   * same id. Generating in the constructor would make a record impossible to rehydrate.
   */
  static request(input: NotificationRequest): Notification {
    const now = input.now ?? new Date();

    const notification = new Notification(
      input.userId,
      input.template,
      input.subject,
      input.body,
      input.severity,
      input.variables,
      input.recipient,
      [...input.channels],
      input.id ?? NotificationId.create(),
      now,
    );

    notification._redactedVariables = [...(input.redactedVariables ?? [])].sort();
    notification._logBody = input.logBody ?? false;
    return notification;
  }

  /** Rehydrates a stored record. Its events were published when it was first written. */
  static fromRecord(record: NotificationRecord): Notification {
    const notification = new Notification(
      record.userId,
      record.template,
      record.subject,
      record.body,
      record.severity,
      record.variables,
      record.recipient,
      record.channels,
      record.id,
      record.createdAt,
    );

    notification._deliveries = [...record.deliveries];
    notification._redactedVariables = [...record.redactedVariables].sort();
    notification._readAt = record.readAt;
    notification._logBody = record.logBody ?? false;
    return notification;
  }

  get deliveries(): readonly ChannelDelivery[] {
    return this._deliveries;
  }

  get redactedVariables(): readonly string[] {
    return this._redactedVariables;
  }

  get variables(): NotificationVariables {
    return this._variables;
  }

  get logBody(): boolean {
    return this._logBody;
  }

  get readAt(): Date | null {
    return this._readAt;
  }

  get isRead(): boolean {
    return this._readAt !== null;
  }

  /** `undefined` for a channel that was never attempted. */
  deliveryFor(channel: NotificationChannel): ChannelDelivery | undefined {
    return this._deliveries.find((delivery) => delivery.channel === channel);
  }

  /**
   * Records one channel's attempt.
   *
   * @remarks Replaces any earlier record for the same channel rather than appending. A retry
   * over `push` that succeeds must leave one outcome, not `failed, sent`, and a model that can
   * hold both is a model whose `outcome` has to guess.
   *
   * @remarks Records `skipped` as a first-class outcome rather than recording nothing:
   * "attempted and there was no address" and "never attempted" are different answers when
   * someone is asking why a security alert did not arrive.
   */
  recordDelivery(
    delivery: ChannelDelivery,
    redactedVariables: readonly string[] = [],
  ): void {
    this._deliveries = [
      ...this._deliveries.filter(
        (existing) => existing.channel !== delivery.channel,
      ),
      delivery,
    ];

    if (redactedVariables.length > 0) {
      this._redactedVariables = [
        ...new Set([...this._redactedVariables, ...redactedVariables]),
      ].sort();
    }

    this.touch(delivery.deliveredAt);
  }

  /** Used by a handler to replace the aggregate's variable bag with the already-redacted payload. */
  setVariables(variables: NotificationVariables, redactedVariables: readonly string[]): void {
    this._variables = variables;
    this._redactedVariables = [...redactedVariables].sort();
  }

  /**
   * Buffers `notification.dispatched` with the outcome the channel records actually produced.
   *
   * @remarks Called once, after every channel has an outcome. It is not idempotent — two calls
   * buffer two events — because the caller is a single dispatch loop and a second call would
   * mean the same dispatch ran twice, which the consumer's claim exists to prevent.
   */
  settle(correlationId?: string): NotificationOutcome {
    const outcome = this.outcome;
    this.addDomainEvent(
      new NotificationDispatched(
        this.id,
        this.userId,
        this.template,
        outcome,
        this.channels,
        correlationId,
      ),
    );
    return outcome;
  }

  /**
   * Marks the notification read.
   *
   * @remarks Idempotent: a second read is a no-op with no second `notification.read` event.
   * A read button in a UI that can be double-clicked must not announce two reads.
   *
   * @returns whether this call is what changed the state.
   */
  markRead(now: Date = new Date(), correlationId?: string): boolean {
    if (this.isRead) return false;

    this._readAt = now;
    this.touch(now);
    this.addDomainEvent(new NotificationRead(this.id, this.userId, now, correlationId));
    return true;
  }

  /** The public record a store projects from this aggregate. */
  toPublicRecord(): NotificationPublicRecord {
    return {
      id: this.id,
      userId: this.userId,
      template: this.template,
      subject: this.subject,
      severity: this.severity,
      channels: this.channels,
      deliveries: this._deliveries,
      redactedVariables: this._redactedVariables,
      isRead: this._readAt !== null,
      readAt: this._readAt,
      createdAt: this.createdAt,
    };
  }

  /**
   * What the whole dispatch amounted to, derived from the per-channel records.
   *
   * @remarks Ordered deliberately: `SKIPPED` is checked before `SENT` on length, because a
   * template that requested only unreachable channels delivered nothing, and reporting that
   * as `FAILED` would page somebody about an outage that never happened.
   */
  get outcome(): NotificationOutcome {
    const total = this.channels.length;
    if (total === 0) return NotificationOutcome.SKIPPED;

    const sent = this._deliveries.filter(
      (delivery) => delivery.status === DeliveryStatus.SENT,
    ).length;
    const skipped = this._deliveries.filter(
      (delivery) => delivery.status === DeliveryStatus.SKIPPED,
    ).length;

    if (sent === total) return NotificationOutcome.SENT;
    if (sent > 0) return NotificationOutcome.PARTIAL;
    if (skipped === total) return NotificationOutcome.SKIPPED;
    return NotificationOutcome.FAILED;
  }

  get deliveredChannels(): readonly NotificationChannel[] {
    return this._deliveries
      .filter((delivery) => delivery.status === DeliveryStatus.SENT)
      .map((delivery) => delivery.channel);
  }

  get failedChannels(): readonly NotificationChannel[] {
    return this._deliveries
      .filter((delivery) => delivery.status === DeliveryStatus.FAILED)
      .map((delivery) => delivery.channel);
  }

  /** Everything a store needs to write this aggregate back out. */
  toRecord(): NotificationRecord {
    return {
      id: this.id,
      userId: this.userId,
      template: this.template,
      subject: this.subject,
      body: this.body,
      severity: this.severity,
      variables: this.variables,
      recipient: this.recipient,
      channels: this.channels,
      deliveries: this.deliveries,
      redactedVariables: this.redactedVariables,
      readAt: this.readAt,
      createdAt: this.createdAt,
    };
  }
}