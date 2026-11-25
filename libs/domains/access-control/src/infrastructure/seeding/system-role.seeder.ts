/**
 * @fileoverview Writes the shared role catalogue into this service's database on boot.
 *
 * @remarks The catalogue itself lives in `@auth/contracts`, because the gateway's route
 * decorators and the front's labels read the same names. This class is the only place those
 * definitions are persisted: without it a fresh `access_control` database answers "no" to
 * every privileged request, and no caller can grant the role that would fix that.
 *
 * @remarks Idempotence is the contract, but "idempotent" does not mean "additive": a second
 * boot converges each system role to the catalogue exactly, adding a newly introduced slug
 * and withdrawing one the catalogue no longer names. A deployment that needs extra rights
 * adds a custom role; extending a system role is not preserved across restarts.
 */
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ROLES, SYSTEM_ROLES } from '@auth/contracts';
import { Role } from '../../domain/role.aggregate';
import {
  ROLE_REPOSITORY,
  type RoleRepositoryPort,
} from '../../domain/ports/role-repository.port';
import {
  ACCESS_CONTROL_CONFIG,
  type AccessControlConfig,
} from '../../access-control.config';
// Value import: constructor-injected, and `emitDecoratorMetadata` reads the value binding.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { AccessControlService } from '../../application/facade/access-control.service';

@Injectable()
export class SystemRoleSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(SystemRoleSeeder.name);

  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepositoryPort,
    @Inject(ACCESS_CONTROL_CONFIG) private readonly config: AccessControlConfig,
    private readonly accessControl: AccessControlService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.seedSystemRoles) {
      this.logger.log('System role seeding is disabled; the existing catalogue is used');
      return;
    }

    for (const definition of SYSTEM_ROLES) {
      await this.converge(definition);
    }

    for (const userId of this.config.bootstrapAdminUserIds) {
      await this.accessControl.grantRoleToUser({
        userId,
        role: ROLES.ADMIN,
        grantedBy: 'bootstrap',
        reason: 'configured bootstrap administrator',
      });
      this.logger.log(`Bootstrap administrator ensured for user ${userId}`);
    }
  }

  /**
   * Creates the role, or makes the existing one match the catalogue exactly.
   *
   * @remarks System roles are code-owned, so the catalogue is authoritative in both
   * directions: a missing permission is added and one the catalogue no longer names is
   * withdrawn. Deployments that need extra rights add a custom role; extending a seeded one
   * would be silently undone on the next boot, which is worse than refusing the edit.
   */
  private async converge(definition: (typeof SYSTEM_ROLES)[number]): Promise<void> {
    const existing = await this.roles.findByName(definition.name);

    if (existing === null) {
      await this.roles.save(
        Role.create({
          name: definition.name,
          permissions: definition.permissions,
          description: definition.description,
          isSystem: true,
        }),
      );
      this.logger.log(`Seeded system role "${definition.name}"`);
      return;
    }

    const revision = existing.revision;
    existing.applyDefinition({
      permissions: definition.permissions,
      description: definition.description,
    });

    if (existing.revision === revision) return;

    await this.roles.save(existing);
    this.logger.log(`Converged system role "${definition.name}" to the shared catalogue`);
  }
}
