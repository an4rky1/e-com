/**
 * @fileoverview User lifecycle states.
 *
 * @remarks A string union rather than a TypeScript `enum`: the enum emits runtime code and
 * forces consumers to import the module, and the wire format is plain text. The database
 * column is `text` for the same reason — adding a state must not be a migration.
 */

export const UserStatus = {
  PENDING_VERIFICATION: 'pending_verification',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  LOCKED: 'locked',
  DELETED: 'deleted',
} as const;

export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

/**
 * States from which authentication may proceed.
 *
 * @remarks `PENDING_VERIFICATION` is excluded deliberately: an unverified address means the
 * person who registered may not be the person who owns the mailbox, and letting them sign in
 * turns registration into a way to squat another person's account.
 */
export const AUTHENTICATABLE: ReadonlySet<UserStatus> = new Set([
  UserStatus.ACTIVE,
]);

export const TERMINAL_STATUSES: ReadonlySet<UserStatus> = new Set([
  UserStatus.DELETED,
]);

export function isUserStatus(value: unknown): value is UserStatus {
  return (
    typeof value === 'string' &&
    (Object.values(UserStatus) as string[]).includes(value)
  );
}