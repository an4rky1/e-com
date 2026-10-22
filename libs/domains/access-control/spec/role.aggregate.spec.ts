import { Role, type RoleCreated, type RoleDeleted } from '../src/domain/role.aggregate';
import { PermissionSlug } from '../src/domain/value-objects/permission-slug.vo';

const role = (overrides: Partial<Parameters<typeof Role.create>[0]> = {}) =>
  Role.create({
    name: 'support_agent',
    permissions: ['tickets:read', 'tickets:write'],
    ...overrides,
  });

describe('Role.create', () => {
  it('parses its permissions into validated slugs', () => {
    expect(role().permissions.map((permission) => permission.value)).toEqual([
      'tickets:read',
      'tickets:write',
    ]);
  });

  it('rejects a malformed permission instead of storing it', () => {
    // A role that declares `users` cannot confer anything: the evaluator compares the whole
    // slug, so a half-written one silently never matches.
    expect(() => role({ permissions: ['users'] })).toThrow();
  });

  it('collapses a duplicated permission so the declared set has one entry per permission', () => {
    expect(
      role({ permissions: ['tickets:read', 'tickets:read'] }).permissions,
    ).toHaveLength(1);
  });

  it('normalises a blank description to null', () => {
    expect(role({ description: '   ' }).description).toBeNull();
  });

  it('emits exactly one role.created event carrying the role name', () => {
    const created = role();

    expect(created.domainEvents).toHaveLength(1);

    const [event] = created.domainEvents as RoleCreated[];
    expect(event.eventType).toBe('role.created');
    expect(event.aggregateType).toBe('Role');
    expect(event.aggregateId).toBe('support_agent');
    expect(event.payload.permissions).toEqual(['tickets:read', 'tickets:write']);
  });

  it('is a non-system role unless it is seeded as one', () => {
    expect(role().isSystem).toBe(false);
    expect(role({ isSystem: true }).isSystem).toBe(true);
  });
});

describe('Role.declare / withdraw', () => {
  it('adds a permission and emits role.permission_declared', () => {
    const subject = role();
    subject.clearDomainEvents();

    subject.declare('billing:invoice.read');

    expect(subject.hasPermission('billing:invoice.read')).toBe(true);
    expect(subject.domainEvents).toHaveLength(1);
    expect(subject.domainEvents[0].eventType).toBe('role.permission_declared');
  });

  it('is idempotent — re-declaring must not duplicate the entry or the event', () => {
    const subject = role();
    subject.clearDomainEvents();

    subject.declare('tickets:read');

    expect(subject.domainEvents).toHaveLength(0);
    expect(subject.permissions).toHaveLength(2);
  });

  it('removes a permission without removing the role', () => {
    const subject = role();
    subject.clearDomainEvents();

    subject.withdraw('tickets:write');

    expect(subject.hasPermission('tickets:write')).toBe(false);
    expect(subject.hasPermission('tickets:read')).toBe(true);
    expect(subject.domainEvents[0].eventType).toBe('role.permission_withdrawn');
  });

  it('ignores a withdrawal of something it never declared', () => {
    const subject = role();
    subject.clearDomainEvents();

    subject.withdraw('billing:invoice.read');

    expect(subject.domainEvents).toHaveLength(0);
  });
});

describe('Role.grant', () => {
  it('refuses to grant a permission the role does not declare', () => {
    const subject = role();

    // The guard is the whole point of the method: a role may only confer what it declares,
    // or the effective permission set is assembled from two places that disagree.
    expect(() => subject.grant(PermissionSlug.fromTrusted('billing:invoice.write'))).toThrow(
      /does not declare the permission "billing:invoice.write"/,
    );
    expect(subject.domainEvents).toHaveLength(1);
  });

  it('grants a permission the role declares', () => {
    const subject = role();

    expect(() => subject.grant('tickets:write')).not.toThrow();
  });

  it('stops granting once the permission has been withdrawn', () => {
    const subject = role();
    subject.withdraw('tickets:write');

    expect(() => subject.grant('tickets:write')).toThrow(/does not declare/);
  });
});

describe('Role.remove', () => {
  it('refuses to delete a system role', () => {
    const subject = role({ isSystem: true });

    // `roles.name` is referenced by assignments and policies, so deleting a seeded role takes
    // the platform's baseline authorisation with it and nobody is watching an event.
    expect(() => subject.remove()).toThrow(/system role "support_agent" cannot be deleted/);
    expect(subject.isDeleted).toBe(false);
  });

  it('deletes an ordinary role and emits role.deleted with the permissions it was conferring', () => {
    const subject = role();
    subject.clearDomainEvents();

    subject.remove();

    expect(subject.isDeleted).toBe(true);

    const [event] = subject.domainEvents as RoleDeleted[];
    expect(event.eventType).toBe('role.deleted');
    expect(event.payload.permissions).toEqual(['tickets:read', 'tickets:write']);
  });

  it('is idempotent', () => {
    const subject = role();
    subject.remove();
    subject.clearDomainEvents();

    subject.remove();

    expect(subject.domainEvents).toHaveLength(0);
  });
});

describe('Role.fromRow', () => {
  it('rehydrates without emitting events', () => {
    // Rehydration must not replay history: the write already happened and the events are
    // already in the outbox.
    const subject = Role.fromRow({
      name: 'billing_admin',
      permissions: ['billing:invoice.read'],
      description: 'Invoicing',
      is_system: true,
      created_at: new Date(),
      updated_at: new Date(),
    });

    expect(subject.domainEvents).toHaveLength(0);
    expect(subject.id).toBe('billing_admin');
    expect(subject.isSystem).toBe(true);
    expect(subject.hasPermission('billing:invoice.read')).toBe(true);
  });

  it('rejects a stored permission that is no longer a valid slug', () => {
    expect(() =>
      Role.fromRow({
        name: 'legacy',
        permissions: ['everything'],
        description: null,
        is_system: false,
        created_at: new Date(),
        updated_at: new Date(),
      }),
    ).toThrow();
  });
});