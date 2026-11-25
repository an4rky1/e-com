import { AggregateRoot, DomainEvent, Ensure, type IDomainEvent } from '@auth/core';
import { PermissionSlug } from './value-objects/permission-slug.vo';
import { RoleName } from './value-objects/role-name.vo';

/** Aggregate/event identity constants — the prefix that scopes every role event. */
export const ROLE_AGGREGATE = 'Role';

export class RoleCreated extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: {
      role: string;
      permissions: string[];
      system: boolean;
    },
    version = 1,
  ) {
    super(aggregateId, ROLE_AGGREGATE, 'role.created', version);
  }
}

export class RolePermissionDeclared extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: { role: string; permission: string },
    version = 1,
  ) {
    super(aggregateId, ROLE_AGGREGATE, 'role.permission_declared', version);
  }
}

export class RolePermissionWithdrawn extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: { role: string; permission: string },
    version = 1,
  ) {
    super(aggregateId, ROLE_AGGREGATE, 'role.permission_withdrawn', version);
  }
}

export class RoleDeleted extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: { role: string; permissions: string[] },
    version = 1,
  ) {
    super(aggregateId, ROLE_AGGREGATE, 'role.deleted', version);
  }
}

export interface RoleProps {
  name: RoleName;
  /** Insertion-ordered so the permission list is stable across reads and token claims. */
  permissions: readonly PermissionSlug[];
  description: string | null;
  /** Seeded by migration and relied on by the platform; never deleted, never emptied. */
  isSystem: boolean;
  version: number;
}

/**
 * A named set of permission slugs.
 *
 * @remarks Access control answers one question — "what may this user do?" — and never
 * authenticates. A role is the RBAC half of that answer: the union of the slugs declared
 * here is what every holder of the role may do, and nothing more.
 *
 * @remarks The role *is* its name. There is no surrogate id, so every reference to a role in
 * `role_assignments`, in `policies` and in a token claim is the same readable string.
 */
export class Role extends AggregateRoot<string> {
  private constructor(
    id: string,
    private readonly props: RoleProps,
    createdAt: Date,
    updatedAt: Date,
  ) {
    super(id, createdAt, updatedAt);
  }

  static create(input: {
    name: string | RoleName;
    permissions?: readonly string[];
    description?: string | null;
    isSystem?: boolean;
    now?: Date;
  }): Role {
    const name =
      input.name instanceof RoleName ? input.name : RoleName.fromTrusted(input.name);

    const now = input.now ?? new Date();

    const role = new Role(
      name.value,
      {
        name,
        permissions: dedupe((input.permissions ?? []).map(PermissionSlug.fromTrusted)),
        description: input.description?.trim() || null,
        isSystem: input.isSystem ?? false,
        version: 1,
      },
      now,
      now,
    );

    role.addDomainEvent(
      new RoleCreated(name.value, {
        role: name.value,
        permissions: role.props.permissions.map((permission) => permission.value),
        system: role.props.isSystem,
      }),
    );

    return role;
  }

  /** Rehydration from persistence. Does not emit events — the write already happened. */
  static fromRow(row: {
    name: string;
    permissions: string[];
    description: string | null;
    is_system: boolean;
    created_at: Date;
    updated_at: Date;
  }): Role {
    return new Role(
      row.name,
      {
        name: RoleName.fromTrusted(row.name),
        permissions: dedupe(row.permissions.map(PermissionSlug.fromTrusted)),
        description: row.description,
        isSystem: row.is_system,
        version: 1,
      },
      row.created_at,
      row.updated_at,
    );
  }

  get name(): RoleName {
    return this.props.name;
  }

  get permissions(): readonly PermissionSlug[] {
    return this.props.permissions;
  }

  get description(): string | null {
    return this.props.description;
  }

  get isSystem(): boolean {
    return this.props.isSystem;
  }

  /** Aggregated revision, independent of how many events this instance has buffered. */
  get revision(): number {
    return this.props.version;
  }

  hasPermission(permission: PermissionSlug | string): boolean {
    const slug = toSlug(permission);
    return this.props.permissions.some((declared) => declared.equals(slug));
  }

  /**
   * Adds a permission to the role's own vocabulary.
   *
   * @remarks Idempotent: re-declaring a permission is how a re-run seed script should
   * behave, and a duplicate entry would make `hasPermission` and the token claim disagree
   * about how many permissions the role has.
   */
  declare(permission: PermissionSlug | string, now: Date = new Date()): void {
    const slug = toSlug(permission);

    if (this.hasPermission(slug)) return;

    this.props.permissions = [...this.props.permissions, slug];
    this.bump(now);
    this.addDomainEvent(
      new RolePermissionDeclared(this.id, { role: this.id, permission: slug.value }),
    );
  }

  /**
   * Removes a permission the role no longer confers.
   *
   * @remarks The role stays; only the slug goes. Removing a role outright would silently
   * strip every holder of it, which is a different and much louder decision.
   */
  withdraw(permission: PermissionSlug | string, now: Date = new Date()): void {
    const slug = toSlug(permission);

    if (!this.hasPermission(slug)) return;

    this.props.permissions = this.props.permissions.filter(
      (declared) => !declared.equals(slug),
    );
    this.bump(now);
    this.addDomainEvent(
      new RolePermissionWithdrawn(this.id, { role: this.id, permission: slug.value }),
    );
  }

  /**
   * Confers a permission on behalf of everyone holding this role.
   *
   * @remarks The guard is the point of the method. A role may only grant what it declares:
   * anything else would mean the permission set is assembled from two places that disagree,
   * and the second place is the one nobody reads.
   */
  grant(permission: PermissionSlug | string): void {
    const slug = toSlug(permission);

    Ensure.isTrue(
      this.hasPermission(slug),
      `role "${this.id}" does not declare the permission "${slug.value}"`,
      'INVARIANT_VIOLATION',
    );
  }

  changeDescription(description: string | null, now: Date = new Date()): void {
    this.props.description = description?.trim() || null;
    this.bump(now);
  }

  /**
   * Makes this role match its declared definition exactly.
   *
   * @remarks For seeded roles only: the catalogue in `@auth/contracts` owns them, so a
   * permission the catalogue no longer names is withdrawn as well as a missing one added.
   * Leaving withdrawn slugs behind is not harmless — a renamed permission would sit on the
   * role forever, looking granted to every operator who reads the role but matching nothing
   * the platform checks. Custom roles are extended through their own definition, not through
   * a system role, so this never runs against one.
   *
   * @remarks Each addition and removal emits its normal event, so the outbox and any token
   * cache see the same transition a manual edit would produce.
   */
  applyDefinition(
    definition: { permissions: readonly string[]; description: string | null },
    now: Date = new Date(),
  ): void {
    const desired = definition.permissions.map(PermissionSlug.fromTrusted);
    const desiredValues = new Set(desired.map((permission) => permission.value));

    for (const permission of [...this.props.permissions]) {
      if (!desiredValues.has(permission.value)) this.withdraw(permission, now);
    }

    for (const permission of desired) this.declare(permission, now);

    const description = definition.description?.trim() || null;
    if (this.props.description !== description) this.changeDescription(description, now);
  }

  /**
   * Deletes the role.
   *
   * @remarks A system role cannot be deleted. `roles.name` is referenced by
   * `role_assignments` and `policies`, so deleting it cascades away every assignment and
   * every policy attached to it — for the seeded roles (`admin`, `user`, …) that would
   * silently strip authorisation from the entire platform with no event anyone is watching.
   */
  remove(now: Date = new Date()): void {
    if (this.props.isSystem) {
      throw new Error(`the system role "${this.id}" cannot be deleted`);
    }

    if (this.isDeleted) return;

    this.softDelete(now);
    this.bump(now);
    this.addDomainEvent(
      new RoleDeleted(this.id, {
        role: this.id,
        permissions: this.props.permissions.map((permission) => permission.value),
      }),
    );
  }

  /** Every mutation goes through here, so `revision` can never drift from the event stream. */
  private bump(now: Date): void {
    this.props.version += 1;
    this.updatedAt = now;
  }
}

/** Accepts either representation so callers never have to construct the value object. */
function toSlug(permission: PermissionSlug | string): PermissionSlug {
  return typeof permission === 'string'
    ? PermissionSlug.fromTrusted(permission)
    : permission;
}

/** Keeps the first occurrence, so `['a:1', 'a:1']` declares one permission. */
function dedupe(permissions: readonly PermissionSlug[]): readonly PermissionSlug[] {
  const seen = new Set<string>();
  return permissions.filter((permission) => {
    if (seen.has(permission.value)) return false;
    seen.add(permission.value);
    return true;
  });
}

export type RoleEvent =
  | RoleCreated
  | RolePermissionDeclared
  | RolePermissionWithdrawn
  | RoleDeleted;

export const isRoleEvent = (event: IDomainEvent): event is RoleEvent =>
  event.aggregateType === ROLE_AGGREGATE;