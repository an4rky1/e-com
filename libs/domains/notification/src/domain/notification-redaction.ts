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

export type { AuditAndNotificationRedactionShape } from './audit-and-notification-redaction.shape';
export { toAuditAndNotificationRedactionShape } from './audit-and-notification-redaction.shape';
