/**
 * Stable re-export of the notification module's redaction surface.
 *
 * @remarks The catalogue is a *catalogue*, not an implementation detail of every test in the
 * module. Splitting this file off from the rest of `notification-templates.ts` so that the
 * one file can change its rendering pipeline without forcing every test to import a new
 * dependency is the same reason the handler keeps its own copy of the pipeline — the difference
 * is that tests are not a dispatch loop, and they should not pay for one.
 *
 * @remarks This file is the stable surface: a test that imports from it is a test that tests
 * templates and the redaction layer as a unit. Tests that want the actual publishable payload
 * import from `notification-announcement` and `notification.aggregate` instead.
 */
export { redactVariables } from '../notification-announcement';

export { type AuditAndNotificationRedactionShape, toAuditAndNotificationRedactionShape } from '../audit-and-notification-redaction.shape';

/** Sort rules so a redaction report does not lie about which key came first. */
export function redactionOrder(value: string[]): string[] {
  return value.slice().sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'variant' }),
  );
}

