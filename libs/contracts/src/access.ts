/**
 * @fileoverview The platform's actor model: who exists, what each kind may do, and the
 * permission names that answer it.
 *
 * @remarks One file, because these values were previously spelled in three places — the
 * route decorators, the access-control seed and the front's role checks — and a permission
 * string that is spelled differently in two of them fails closed in a way nobody notices
 * until an operator cannot perform the action they were just granted.
 *
 * @remarks The *names* live here; the *decisions* do not. Access-control still stores roles,
 * assignments and policies in its own database, and the gateway still asks it per request.
 * This module is the vocabulary both sides agree on, not a second authorisation engine.
 */

/**
 * The four kinds of caller the product recognises.
 *
 * @remarks `guest` is deliberately not a privilege level but an account state: identity
 * mints a placeholder row with `status: 'guest'`, and that row owns a cart under its session
 * key. The other three are RBAC roles in access-control. {@link actorKindOf} is the one place
 * the two vocabularies are joined, so no caller has to remember which half it is holding.
 */
export const ROLES = {
  GUEST: 'guest',
  USER: 'user',
  MODERATOR: 'moderator',
  ADMIN: 'admin',
} as const;

export type RoleKey = (typeof ROLES)[keyof typeof ROLES];

/**
 * The shape a role name must have, shared by the domain and the edge.
 *
 * @remarks Lower snake case, 2-64 characters, starting with a letter. The name is the primary
 * key of a role, so a gateway DTO that admits `Admin ` or `admin!` only moves the refusal
 * downstream; validating the same shape at both edges means the error names the field the
 * caller sent.
 */
export const ROLE_NAME_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
export const ROLE_NAME_MIN_LENGTH = 2;
export const ROLE_NAME_MAX_LENGTH = 64;

/**
 * Bounds on a policy row, shared by the edge's DTO and access-control's own transport.
 *
 * @remarks Priority is a signed number so a deny can outrank an allow on the same resource;
 * the ±1000 range is wide enough that operators never collide and small enough that a
 * typo'd `100000` is refused rather than silently winning every evaluation.
 */
export const POLICY_PRIORITY_MIN = -1_000;
export const POLICY_PRIORITY_MAX = 1_000;
/** How many conditions one policy may carry. */
export const POLICY_CONDITIONS_MAX = 20;
/** An ABAC attribute name, e.g. `resource.type` — dotted segments, hence the slack over a uuid. */
export const POLICY_ATTRIBUTE_MAX_LENGTH = 64;
/** The resource type a policy targets. */
export const RESOURCE_TYPE_MAX_LENGTH = 64;
/** How long a role-search term may be; the search matches substrings, not expressions. */
export const ROLE_SEARCH_MAX_LENGTH = 64;

/**
 * Every *assignable* system role, strongest last.
 *
 * @remarks `guest` is deliberately absent. It is an actor kind and an identity status, not a
 * row in `roles`: nobody grants it, nobody revokes it, and access-control must not become a
 * second authority on who is a guest. The name still exists in {@link ROLES} because
 * `/auth/me` reports it and route selection needs it.
 */
export const SYSTEM_ROLE_NAMES: readonly RoleKey[] = [
  ROLES.USER,
  ROLES.MODERATOR,
  ROLES.ADMIN,
];

/**
 * Permission slugs, in the `resource:action` form access-control's value object enforces.
 *
 * @remarks Exactly one colon. An earlier spelling of the password permission used
 * `users:password:set`, which the domain's `PermissionSlug` rejects — so a role seeded with it
 * would not construct at all. The catalog caught that when the role definitions below were
 * first validated against the slug pattern.
 */
export const PERMISSIONS = {
  /** Read one's own orders. Ownership is enforced from the principal, not from a path field. */
  ORDERS_READ: 'orders:read',
  /** Cancel one's own order before it is fulfilled. */
  ORDERS_CANCEL: 'orders:cancel',

  CATALOG_PRODUCT_CREATE: 'catalog:product.create',
  CATALOG_PRODUCT_SET_PRICE: 'catalog:product.set-price',

  USERS_READ: 'users:read',
  USERS_SUSPEND: 'users:suspend',
  USERS_PASSWORD_SET: 'users:password.set',

  ROLES_READ: 'roles:read',
  ROLES_WRITE: 'roles:write',
  ROLES_GRANT: 'roles:grant',
  ROLES_REVOKE: 'roles:revoke',
  POLICIES_WRITE: 'policies:write',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export interface SystemRoleDefinition {
  readonly name: RoleKey;
  readonly description: string;
  readonly permissions: readonly PermissionKey[];
}

/**
 * What every signed-in shopper may do.
 *
 * @remarks Modest on purpose: most shopper operations are scoped by *ownership* (this cart,
 * this order), which is not an RBAC question. Orders are the exception where both apply:
 * the route checks `orders:read`/`orders:cancel`, and the order service still scopes the
 * query to the caller's id — a permission says "may use orders", never "may read any order".
 */
const USER_PERMISSIONS: readonly PermissionKey[] = [
  PERMISSIONS.ORDERS_READ,
  PERMISSIONS.ORDERS_CANCEL,
];

/**
 * The seeded role catalogue.
 *
 * @remarks Moderator can manage the catalogue and read accounts; admin can also change
 * credentials, roles and policies. The roles do not inherit from one another at evaluation
 * time — access-control unions the permissions of the roles a user actually holds — so every
 * stronger role repeats the weaker role's slugs explicitly. That is the trade for a decision
 * engine with no hidden hierarchy: reading a definition tells you the whole answer.
 *
 * @remarks Every seeded role is `isSystem`, which access-control refuses to delete or empty.
 * A deployment that wants different permissions should add a policy or a new role, not edit
 * these; a re-run of the seeder converges the system roles back to this file.
 */
export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
  {
    name: ROLES.USER,
    description: 'A signed-in shopper. Shops, checks out and reads their own orders.',
    permissions: USER_PERMISSIONS,
  },
  {
    name: ROLES.MODERATOR,
    description: 'Shops, manages the catalogue, and reads accounts.',
    permissions: [
      ...USER_PERMISSIONS,
      PERMISSIONS.CATALOG_PRODUCT_CREATE,
      PERMISSIONS.CATALOG_PRODUCT_SET_PRICE,
      PERMISSIONS.USERS_READ,
    ],
  },
  {
    name: ROLES.ADMIN,
    description:
      'Full platform administration: catalogue, accounts, credentials, roles and policies.',
    permissions: Object.values(PERMISSIONS),
  },
];

/** The role every newly created account receives. */
export const DEFAULT_SIGNUP_ROLE: RoleKey = ROLES.USER;

/** True for a name this catalog seeds. */
export function isSystemRole(value: unknown): value is RoleKey {
  return typeof value === 'string' && (SYSTEM_ROLE_NAMES as readonly string[]).includes(value);
}

/** The permissions a catalog role declares; empty for a name the catalog does not know. */
export function permissionsForRole(role: string): readonly PermissionKey[] {
  const normalised = role.trim().toLowerCase();
  return SYSTEM_ROLES.find((definition) => definition.name === normalised)?.permissions ?? [];
}

/**
 * The actor kind a caller should be treated as.
 *
 * @remarks Guest wins over any assignment because identity's `status` is the authority on
 * whether an account is a placeholder; a guest row is never a real administrator. Among RBAC
 * roles the strongest held role wins, which is what a UI badge wants to show. A signed-in
 * account with no assignment is still a `user`: the absence of a grant is an authorisation
 * answer, not a different kind of person.
 */
export function actorKindOf(input: {
  status: string | null | undefined;
  roles: readonly string[];
}): RoleKey {
  if ((input.status ?? '').trim().toLowerCase() === ROLES.GUEST) return ROLES.GUEST;

  const held = new Set(input.roles.map((role) => role.trim().toLowerCase()));
  if (held.has(ROLES.ADMIN)) return ROLES.ADMIN;
  if (held.has(ROLES.MODERATOR)) return ROLES.MODERATOR;
  if (held.has(ROLES.USER)) return ROLES.USER;

  return ROLES.USER;
}

/**
 * The roles a caller effectively holds, for display and for `/auth/me`.
 *
 * @remarks A guest's `guest` role is derived from identity's status rather than assigned in
 * access-control: guest-ness is a fact about the account row, not a grant somebody can hand
 * out, and access-control cannot see identity's table to learn it. The edge is the only
 * place holding both answers, so it adds the one role that is a status.
 */
export function effectiveRoles(input: {
  status: string | null | undefined;
  roles: readonly string[];
}): string[] {
  const roles = [...input.roles];
  if (
    (input.status ?? '').trim().toLowerCase() === ROLES.GUEST &&
    !roles.includes(ROLES.GUEST)
  ) {
    roles.unshift(ROLES.GUEST);
  }
  return roles;
}
