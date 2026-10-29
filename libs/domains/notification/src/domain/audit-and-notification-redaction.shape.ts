/** @fileoverview What a notification event looks like once it has been scrubbed for downstream audit storage.

 * @remarks Exists as a point so a test or a downstream module can assert "a notification event,
 * after redaction, looks like this" from one import rather than reconstructing the shape from
 * the notification command, the template catalogue and the redaction layer.
 *
 * @remarks The shape mirrors, but is not identical to, the notification aggregate's record and
 * the announcement shape. It is the shape audit cares about — the shape freed of fields audit does
 * not route on, like the rendered body and the channel-level delivery detail.
 *
 * @remarks Added in addition to `redactVariables`, whose contract is "variables that survive the
 * content guard". This one is "the notification event, after redaction, as audit would store it".
 */

import type { Notification } from './notification.aggregate';
import { redactVariables } from './notification-announcement';

/** The shape audit cares about after it has redacted a notification event. */
export interface AuditAndNotificationRedactionShape {
  readonly notificationId: string;
  readonly userId: string;
  readonly template: string;
  readonly severity: string;
  readonly subject: string;
  readonly channels: readonly string[];
  readonly deliveredChannels: readonly string[];
  readonly failedChannels: readonly string[];
  readonly outcome: string;
  readonly redactedVariables: readonly string[];
  readonly createdAt: string;
  readonly deliveredAt: string;
}

/** Converts the notification aggregate into the audit redaction shape.
 *
 * @remarks Reads only the aggregate's public surface, so the same helper works for a freshly
 * dispatched notification and one rehydrated from storage. The variable bag is passed through
 * the content guard once more: audit gets the *names* of what was dropped, never the values.
 */
export function toAuditAndNotificationRedactionShape(
  notification: Notification,
): AuditAndNotificationRedactionShape {
  const lastDeliveredAt = notification.deliveries.reduce<Date | null>(
    (latest, delivery) =>
      latest === null || delivery.deliveredAt > latest ? delivery.deliveredAt : latest,
    null,
  );
  const { redacted } = redactVariables(notification.variables);

  return {
    notificationId: notification.id.value,
    userId: notification.userId,
    template: notification.template,
    severity: notification.severity,
    subject: notification.subject,
    channels: [...notification.channels],
    deliveredChannels: [...notification.deliveredChannels],
    failedChannels: [...notification.failedChannels],
    outcome: notification.outcome,
    redactedVariables: redacted,
    createdAt: notification.createdAt.toISOString(),
    deliveredAt: (lastDeliveredAt ?? notification.createdAt).toISOString(),
  };
}
