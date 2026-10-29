/**
 * @fileoverview The delivery port.
 *
 * @remarks Application code depends on this and never on a concrete channel. Adding SES or
 * Twilio is then a new class plus one line in the registry — not an edit to a dispatch loop
 * that today happens to know what `console.log` is.
 *
 * @remarks `deliver` is one channel, not "send this notification". A single method that took
 * the whole notification could only be implemented as one call, which is exactly the shape
 * that makes one unreachable provider able to take down the reachable ones.
 */
import type { DeliveryStatus, NotificationChannel, NotificationSeverity } from '../value-objects/notification-channel.vo';
import type {
  NotificationTemplate,
  NotificationVariables,
} from '../value-objects/notification-template.vo';
import type { NotificationRecipient } from '../notification.aggregate';

/** Re-exported so an adapter can name the type without reaching into the aggregate. */
export type { NotificationRecipient };

/** DI token for the registry, which is what the dispatch loop actually asks for. */
export const NOTIFICATION_CHANNELS = Symbol('NOTIFICATION_CHANNELS');

/**
 * What a channel adapter is handed.
 *
 * @remarks Carries the recipient *address* because a provider needs one, and carries the body
 * because a provider renders it. That is the whole of what crosses into infrastructure and the
 * whole of what must never be published — the distinction is why {@link NotificationMessage}
 * is not a subset of the announcement payload.
 */
export interface NotificationMessage {
  readonly notificationId: string;
  readonly userId: string;
  readonly template: NotificationTemplate;
  readonly subject: string;
  readonly body: string;
  readonly variables: NotificationVariables;
  readonly recipient: NotificationRecipient;
  readonly severity: NotificationSeverity;
  /** The address this channel should deliver to, or `null` for `inapp`. */
  readonly address: string | null;
}

export interface NotificationDeliveryReceipt {
  readonly channel: NotificationChannel;
  readonly status: DeliveryStatus;
  /** Provider-side handle, for support. Never published — see `notification-announcement.ts`. */
  readonly providerMessageId?: string;
  readonly error?: string;
  readonly deliveredAt: Date;
}

export interface NotificationChannelPort {
  /** The single channel this adapter owns. */
  readonly channel: NotificationChannel;

  /**
   * Whether this adapter is enabled for delivery at all.
   *
   * @remarks Read by the dispatch loop, not by providers. A channel whose adapter returns false
   * here is recorded as skipped rather than as an attempt that failed — there is nowhere to send
   * the message in this deployment, rather than a provider that refused one.
   *
   * @remarks Configured reachability, not recipient capability: an adapter with no provider
   * returns false for every recipient, and a recipient with no address is handled separately in
   * the dispatch loop before this is called.
   */
  supports(): boolean;

  /**
   * Delivers one message.
   *
   * @remarks Throws on failure. The dispatch loop isolates the throw per channel, so a
   * throwing adapter costs exactly its own channel.
   */
  deliver(message: NotificationMessage): Promise<NotificationDeliveryReceipt>;
}

/**
 * The registry the dispatch loop resolves channels against.
 *
 * @remarks Separate from the adapters themselves so adding a provider is one provider entry
 * and no code change — the loop already asks "who owns this channel?" for channels it has
 * never heard of.
 */
export interface NotificationChannelRegistry {
  /** The adapter for a channel, or `null` when this deployment has none. */
  resolve(channel: NotificationChannel): NotificationChannelPort | null;

  /** Channels this deployment can actually deliver on, in canonical order. */
  available(): readonly NotificationChannel[];

  /** Why a channel could not be resolved, for the log and the dispatch receipt. */
  readonly unavailableReason: string;
}