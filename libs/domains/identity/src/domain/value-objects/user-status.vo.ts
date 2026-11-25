/**
 * @fileoverview User lifecycle states.
 *
 * @remarks A string union rather than a TypeScript `enum`: the enum emits runtime code and
 * forces consumers to import the module, and the wire format is plain text. The database
 * column *is* a Postgres enum (see `prisma/identity/migrations/0001_enums`), so widening the
 * union here does mean a migration — the union keeps the wire and the domain honest, the
 * migration keeps the column honest.
 */

export const UserStatus = {
  PENDING_VERIFICATION: 'pending_verification',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  LOCKED: 'locked',
  DELETED: 'deleted',
  /** A browser's placeholder account — never signed into, addressed only by its guest id. */
  GUEST: 'guest',
} as const;

export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

/**
 * States from which authentication may proceed.
 *
 * @remarks `PENDING_VERIFICATION` is excluded deliberately: an unverified address means the
 * person who registered may not be the person who owns the mailbox, and letting them sign in
 * turns registration into a way to squat another person's account.
 *
 * @remarks `GUEST` is excluded for a simpler reason: there is nothing to authenticate *with*.
 * A guest row exists so an anonymous basket has a user id, not so anyone can sign in as it.
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