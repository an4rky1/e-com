/**
 * @fileoverview Session lifecycle states.
 *
 * @remarks A string union rather than a TypeScript `enum`: the enum emits runtime code and
 * forces consumers to import the module, and the wire format is plain text. The database
 * column is `text` for the same reason — adding a state must not be a migration.
 *
 * There is no `expired` state on the refresh token itself: expiry is evaluated against
 * `expires_at` on every presentation, because a sweeper that has to keep up with every
 * active session is a dependency this service does not need to have.
 */

export const SessionStatus = {
  ACTIVE: 'active',
  EXPIRED: 'expired',
  REVOKED: 'revoked',
} as const;

export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

/** States from which a session may still be used or rotated. */
export const USABLE_STATUSES: ReadonlySet<SessionStatus> = new Set([
  SessionStatus.ACTIVE,
]);

/** States a session can never leave. */
export const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set([
  SessionStatus.EXPIRED,
  SessionStatus.REVOKED,
]);

export function isSessionStatus(value: unknown): value is SessionStatus {
  return (
    typeof value === 'string' &&
    (Object.values(SessionStatus) as string[]).includes(value)
  );
}