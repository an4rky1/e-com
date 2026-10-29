/**
 * @fileoverview Delivery channels and the vocabulary around a delivery attempt.
 *
 * @remarks A string union rather than a TypeScript `enum`: the enum emits runtime code and
 * forces consumers to import the module, and the value that travels — into a provider SDK,
 * into a column, into a log line — is plain text. Adding a channel must not be a migration.
 *
 * @remarks The set is deliberately closed for *this* service. `email` and `inapp` are the
 * ones with a durable record behind them; `sms` and `push` exist because a security event
 * that only ever reaches an inbox that the user has stopped opening is not a notification.
 */

export const NotificationChannel = {
  EMAIL: 'email',
  SMS: 'sms',
  PUSH: 'push',
  INAPP: 'inapp',
} as const;

export type NotificationChannel = (typeof NotificationChannel)[keyof typeof NotificationChannel];

/**
 * Every channel, in the order dispatch attempts them.
 *
 * @remarks Ordered, not a set: a template that asks for `email` and `push` should attempt the
 * cheaper one first, and a deterministic order is what makes a test able to assert on it.
 */
export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = [
  NotificationChannel.INAPP,
  NotificationChannel.PUSH,
  NotificationChannel.SMS,
  NotificationChannel.EMAIL,
];

export function isNotificationChannel(value: unknown): value is NotificationChannel {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_CHANNELS as readonly string[]).includes(value)
  );
}

/**
 * Whether a channel needs a concrete address on the recipient to deliver.
 *
 * @remarks `inapp` is the exception: it is delivered to whoever opens the app, so
 * {@link addressFor} returning `null` for it is the normal case rather than an unreachable
 * recipient. Every other channel routes to something the recipient must have supplied — an
 * email, a phone number, a device token — and a dispatch that reaches one of them without an
 * address has nowhere to send.
 */
export function channelRequiresAddress(channel: NotificationChannel): boolean {
  return channel !== NotificationChannel.INAPP;
}

/**
 * What happened on one channel.
 *
 * @remarks `failed` and `skipped` are both "not delivered", and keeping them apart is what
 * makes a report useful: `failed` is this service's problem and needs a retry, `skipped`
 * means there was nothing to deliver *to* and retrying will change nothing.
 */
export const DeliveryStatus = {
  SENT: 'sent',
  FAILED: 'failed',
  SKIPPED: 'skipped',
} as const;

export type DeliveryStatus = (typeof DeliveryStatus)[keyof typeof DeliveryStatus];

/**
 * How loudly to deliver.
 *
 * @remarks `critical` is not a marketing intensity — it is the flag a channel adapter reads
 * to decide whether an SMS is worth its cost and whether a push may bypass a quiet-hours
 * setting. A user locked out of their account is told; a welcome note waits for morning.
 */
export const NotificationSeverity = {
  INFO: 'info',
  SECURITY: 'security',
  CRITICAL: 'critical',
} as const;

export type NotificationSeverity = (typeof NotificationSeverity)[keyof typeof NotificationSeverity];

export const NOTIFICATION_SEVERITIES: readonly NotificationSeverity[] = [
  NotificationSeverity.INFO,
  NotificationSeverity.SECURITY,
  NotificationSeverity.CRITICAL,
];