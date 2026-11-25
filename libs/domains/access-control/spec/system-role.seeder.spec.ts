/**
 * @fileoverview Boot-time seeding of the shared role catalogue.
 *
 * @remarks The claims worth holding: every system role exists with the permissions the
 * contract declares, a second boot changes nothing, and a deployment can bootstrap its first
 * administrator without already having one.
 */
import {
  PERMISSIONS,
  ROLES,
  SYSTEM_ROLES,
  permissionsForRole,
} from '@auth/contracts';
import { SystemRoleSeeder } from '../src/infrastructure/seeding/system-role.seeder';
import { Role } from '../src/domain/role.aggregate';
import type { RoleRepositoryPort } from '../src/domain/ports/role-repository.port';
import type { AccessControlService } from '../src/application/facade/access-control.service';
import type { AccessControlConfig } from '../src/access-control.config';

class InMemoryRoles implements RoleRepositoryPort {
  readonly rows = new Map<string, Role>();
  writes = 0;

  async save(role: Role): Promise<void> {
    role.clearDomainEvents();
    this.rows.set(role.id, role);
    this.writes += 1;
  }

  async findByName(name: string): Promise<Role | null> {
    return this.rows.get(name.trim().toLowerCase()) ?? null;
  }

  async existsByName(name: string): Promise<boolean> {
    return this.rows.has(name.trim().toLowerCase());
  }

  async findByNames(names: readonly string[]): Promise<Role[]> {
    return names.flatMap((name) => {
      const row = this.rows.get(name);
      return row ? [row] : [];
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

const config = (overrides: Partial<AccessControlConfig> = {}): AccessControlConfig => ({
  cacheEnabled: false,
  cacheTtlSec: 60,
  maxPageSize: 100,
  maxPolicyPriority: 1_000,
  protectedRoleNames: ['guest', 'user', 'moderator', 'admin'],
  seedSystemRoles: true,
  bootstrapAdminUserIds: [],
  ...overrides,
});

const seederWith = (initial: Role[] = [], overrides: Partial<AccessControlConfig> = {}) => {
  const roles = new InMemoryRoles();
  for (const role of initial) roles.rows.set(role.id, role);

  const grants: { userId: string; role: string; grantedBy?: string }[] = [];
  const accessControl = {
    grantRoleToUser: async (input: { userId: string; role: string; grantedBy?: string }) => {
      grants.push(input);
      return 'assignment-id';
    },
  } as unknown as AccessControlService;

  return {
    seeder: new SystemRoleSeeder(roles, config(overrides), accessControl),
    roles,
    grants,
  };
};

describe('SystemRoleSeeder', () => {
  it('seeds every assignable system role from the shared catalogue', async () => {
    const { seeder, roles } = seederWith();

    await seeder.onApplicationBootstrap();

    // Guest is an identity status, not an assignment, so there is no `guest` row to seed.
    expect([...roles.rows.keys()].sort()).toEqual(
      [ROLES.ADMIN, ROLES.MODERATOR, ROLES.USER].sort(),
    );
    for (const definition of SYSTEM_ROLES) {
      const role = roles.rows.get(definition.name)!;
      expect(role.isSystem).toBe(true);
      expect(role.permissions.map((permission) => permission.value)).toEqual([
        ...definition.permissions,
      ]);
    }
  });

  it('gives admin every permission the platform names', async () => {
    const { seeder, roles } = seederWith();

    await seeder.onApplicationBootstrap();

    const admin = roles.rows.get(ROLES.ADMIN)!;
    for (const permission of Object.values(PERMISSIONS)) {
      expect(admin.hasPermission(permission)).toBe(true);
    }
    expect(permissionsForRole(ROLES.MODERATOR)).toContain(
      PERMISSIONS.CATALOG_PRODUCT_CREATE,
    );
    expect(permissionsForRole(ROLES.MODERATOR)).not.toContain(
      PERMISSIONS.USERS_PASSWORD_SET,
    );
  });

  it('is idempotent: a second boot writes nothing', async () => {
    const { seeder, roles } = seederWith();

    await seeder.onApplicationBootstrap();
    const writesAfterFirst = roles.writes;
    await seeder.onApplicationBootstrap();

    expect(roles.writes).toBe(writesAfterFirst);
  });

  it('converges both ways: adds a missing permission and withdraws an undeclared one', async () => {
    const existing = Role.create({
      name: ROLES.MODERATOR,
      permissions: [PERMISSIONS.CATALOG_PRODUCT_CREATE, 'reports:read'],
      isSystem: true,
    });
    const { seeder, roles } = seederWith([existing]);

    await seeder.onApplicationBootstrap();

    const moderator = roles.rows.get(ROLES.MODERATOR)!;
    expect(moderator.hasPermission(PERMISSIONS.CATALOG_PRODUCT_SET_PRICE)).toBe(true);
    // System roles are code-owned. Keeping an old slug would make the role read as granting
    // something the catalogue no longer declares; extra rights belong on a custom role.
    expect(moderator.hasPermission('reports:read')).toBe(false);
  });

  it('refreshes a system role description that drifted from the catalogue', async () => {
    const existing = Role.create({
      name: ROLES.USER,
      permissions: permissionsForRole(ROLES.USER),
      description: 'stale description',
      isSystem: true,
    });
    const { seeder, roles } = seederWith([existing]);

    await seeder.onApplicationBootstrap();

    expect(roles.rows.get(ROLES.USER)!.description).toBe(
      SYSTEM_ROLES.find((definition) => definition.name === ROLES.USER)!.description,
    );
  });

  it('bootstraps configured administrators through a normal idempotent grant', async () => {
    const adminId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    const { seeder, grants } = seederWith([], {
      bootstrapAdminUserIds: [adminId],
    });

    await seeder.onApplicationBootstrap();

    expect(grants).toEqual([
      {
        userId: adminId,
        role: ROLES.ADMIN,
        grantedBy: 'bootstrap',
        reason: 'configured bootstrap administrator',
      },
    ]);
  });

  it('does nothing when seeding is disabled', async () => {
    const { seeder, roles, grants } = seederWith([], {
      seedSystemRoles: false,
      bootstrapAdminUserIds: ['7c9e6679-7425-40de-944b-e07fc1f90ae7'],
    });

    await seeder.onApplicationBootstrap();

    expect(roles.writes).toBe(0);
    expect(grants).toEqual([]);
  });
});
