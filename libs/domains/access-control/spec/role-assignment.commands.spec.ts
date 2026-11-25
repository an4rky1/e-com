import 'reflect-metadata';
import {
  ResourceAlreadyExistsException,
  ResourceNotFoundException,
  ValidationException,
} from '@auth/platform/error-handling';
import {
  GrantRoleToUserHandler,
  RevokeRoleFromUserHandler,
} from '../src/application/commands/role-assignment.commands';
import { CreateRoleHandler } from '../src/application/commands/create-role.handler';
import { Role } from '../src/domain/role.aggregate';
import { type RoleAssignment } from '../src/domain/role-assignment.aggregate';
import type { RoleRepositoryPort } from '../src/domain/ports/role-repository.port';
import type { RoleAssignmentRepositoryPort } from '../src/domain/ports/role-assignment-repository.port';
import {
  GrantRoleToUserCommand,
  RevokeRoleFromUserCommand,
} from '../src/application/commands/role-assignment.commands';
import { CreateRoleCommand } from '../src/application/commands/role.command';

const USER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/**
 * An in-memory stand-in for the tables.
 *
 * @remarks Hand-written rather than mocked: a mock asserts on the calls a test expects, which
 * is the opposite of what an idempotency test needs. Here the same question can be asked
 * twice and the *state* has to answer it.
 */
class InMemoryRoleAssignmentRepository implements RoleAssignmentRepositoryPort {
  readonly saved: RoleAssignment[] = [];
  readonly rows = new Map<string, RoleAssignment>();

  async save(assignment: RoleAssignment): Promise<void> {
    this.saved.push(assignment);
    this.rows.set(assignment.id, assignment);
  }

  async findById(id: string): Promise<RoleAssignment | null> {
    return this.rows.get(id) ?? null;
  }

  async findActiveByUserAndRole(
    userId: string,
    role: string,
  ): Promise<RoleAssignment | null> {
    return (
      [...this.rows.values()].find(
        (assignment) =>
          assignment.userId === userId &&
          assignment.role.value === role &&
          assignment.isActiveAt(),
      ) ?? null
    );
  }

  async findActiveByUser(userId: string): Promise<RoleAssignment[]> {
    return [...this.rows.values()].filter(
      (assignment) => assignment.userId === userId && assignment.isActiveAt(),
    );
  }

  async countActiveByUser(userId: string): Promise<number> {
    return (await this.findActiveByUser(userId)).length;
  }
}

class InMemoryRoleRepository implements RoleRepositoryPort {
  readonly rows = new Map<string, Role>();

  async save(role: Role): Promise<void> {
    this.rows.set(role.id, role);
  }

  async findByName(name: string): Promise<Role | null> {
    return this.rows.get(name) ?? null;
  }

  async existsByName(name: string): Promise<boolean> {
    return this.rows.has(name);
  }

  async findByNames(names: readonly string[]): Promise<Role[]> {
    return names.flatMap((name) => {
      const role = this.rows.get(name);
      return role ? [role] : [];
    });
  }

  async findAll(): Promise<Role[]> {
    return [...this.rows.values()];
  }

  async count(): Promise<number> {
    return this.rows.size;
  }

  async delete(role: Role): Promise<void> {
    this.rows.delete(role.id);
  }
}

const grantedEvents = (assignments: InMemoryRoleAssignmentRepository): string[] =>
  assignments.saved.flatMap((assignment) =>
    assignment.domainEvents
      .filter((event) => event.eventType === 'role.granted')
      .map((event) => event.eventType),
  );

const grantCommand = (): GrantRoleToUserCommand =>
  new GrantRoleToUserCommand(USER, 'support_agent');

describe('GrantRoleToUserHandler', () => {
  const build = async () => {
    const roles = new InMemoryRoleRepository();
    await roles.save(
      Role.create({ name: 'support_agent', permissions: ['tickets:read'] }),
    );
    const assignments = new InMemoryRoleAssignmentRepository();
    return {
      roles,
      assignments,
      handler: new GrantRoleToUserHandler(assignments, roles),
    };
  };

  it('writes one assignment carrying one role.granted event', async () => {
    const { handler, assignments } = await build();

    const id = await handler.execute(grantCommand());

    expect(id).toBeTruthy();
    expect(assignments.rows.size).toBe(1);
    expect(grantedEvents(assignments)).toHaveLength(1);
  });

  it('is idempotent — granting the same role twice does not duplicate the assignment', async () => {
    const { handler, assignments } = await build();

    const first = await handler.execute(grantCommand());
    const second = await handler.execute(grantCommand());

    // The second command is a no-op rather than an error: an at-least-once retry of the same
    // request must be safe, and the caller learns nothing changed by getting `null` back.
    expect(first).toBeTruthy();
    expect(second).toBeNull();
    expect(assignments.rows.size).toBe(1);
    expect(await assignments.countActiveByUser(USER)).toBe(1);
  });

  it('emits role.granted exactly once across a repeated grant', async () => {
    const { handler, assignments } = await build();

    await handler.execute(grantCommand());
    await handler.execute(grantCommand());

    // Two consumers applying two `role.granted` facts would each add the role; a duplicated
    // permission claim is how a revoked role reappears in a token.
    expect(grantedEvents(assignments)).toHaveLength(1);
  });

  it('grants again after a revocation, because a revoked grant is not a live one', async () => {
    const { handler, assignments } = await build();

    await handler.execute(grantCommand());
    const stored = [...assignments.rows.values()][0];
    stored.revoke('offboarded');
    await assignments.save(stored);

    const regrant = await handler.execute(grantCommand());

    expect(regrant).toBeTruthy();
    expect(await assignments.countActiveByUser(USER)).toBe(1);
  });

  it('refuses a role that does not exist rather than writing an unresolvable reference', async () => {
    const { handler } = await build();

    await expect(
      handler.execute(new GrantRoleToUserCommand(USER, 'nonexistent')),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);
  });

  it('records who granted the role', async () => {
    const { handler, assignments } = await build();
    const operator = '0f9a1d3c-2b6e-4c1f-9b3a-8e1f0c7a5b21';

    await handler.execute(
      new GrantRoleToUserCommand(USER, 'support_agent', operator),
    );

    const [assignment] = [...assignments.rows.values()];
    expect(assignment.grantedBy).toBe(operator);
  });

  it('refuses to grant guest: it is identity status, not an assignment', async () => {
    const { handler } = await build();

    await expect(
      handler.execute(new GrantRoleToUserCommand(USER, 'guest')),
    ).rejects.toBeInstanceOf(ValidationException);
  });
});

describe('RevokeRoleFromUserHandler', () => {
  const build = async () => {
    const roles = new InMemoryRoleRepository();
    await roles.save(Role.create({ name: 'support_agent', permissions: ['tickets:read'] }));
    const assignments = new InMemoryRoleAssignmentRepository();
    const grant = new GrantRoleToUserHandler(assignments, roles);
    await grant.execute(grantCommand());
    return {
      assignments,
      handler: new RevokeRoleFromUserHandler(assignments),
    };
  };

  it('leaves the user with no live assignment, and therefore no permissions', async () => {
    const { handler, assignments } = await build();

    await handler.execute(
      new RevokeRoleFromUserCommand(USER, 'support_agent', 'offboarded'),
    );

    expect(await assignments.countActiveByUser(USER)).toBe(0);
    expect(await assignments.findActiveByUser(USER)).toEqual([]);
  });

  it('is idempotent when the user does not hold the role', async () => {
    const { handler, assignments } = await build();

    // A retried revoke after a lost response is already-done work, not an error.
    await expect(
      handler.execute(new RevokeRoleFromUserCommand(USER, 'billing_admin')),
    ).resolves.toBeUndefined();
    // The unrelated role the fixture granted is still there; the absent role stayed absent.
    expect(await assignments.countActiveByUser(USER)).toBe(1);
  });

  it('rejects a malformed role name as a caller error', async () => {
    const { handler } = await build();

    await expect(
      handler.execute(new RevokeRoleFromUserCommand(USER, 'Not A Role')),
    ).rejects.toBeInstanceOf(ValidationException);
  });
});

describe('CreateRoleHandler', () => {
  const build = () => {
    const roles = new InMemoryRoleRepository();
    return { roles, handler: new CreateRoleHandler(roles) };
  };

  it('creates a role with validated permissions', async () => {
    const { handler, roles } = build();

    const name = await handler.execute(
      new CreateRoleCommand('billing_admin', ['billing:invoice.read']),
    );

    expect(name).toBe('billing_admin');
    expect(roles.rows.get('billing_admin')?.hasPermission('billing:invoice.read')).toBe(true);
  });

  it('refuses a role name that is not a name', async () => {
    const { handler } = build();

    await expect(
      handler.execute(new CreateRoleCommand('Billing Admin')),
    ).rejects.toBeInstanceOf(ValidationException);
  });

  it('refuses a malformed permission rather than storing a slug that never matches', async () => {
    const { handler } = build();

    await expect(
      handler.execute(new CreateRoleCommand('billing_admin', ['billing'])),
    ).rejects.toBeInstanceOf(ValidationException);
  });

  it('refuses a duplicate role name', async () => {
    const { handler } = build();
    await handler.execute(new CreateRoleCommand('billing_admin'));

    await expect(
      handler.execute(new CreateRoleCommand('billing_admin')),
    ).rejects.toBeInstanceOf(ResourceAlreadyExistsException);
  });
});