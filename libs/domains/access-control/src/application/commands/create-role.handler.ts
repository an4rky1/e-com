import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import {
  ResourceAlreadyExistsException,
  ValidationException,
} from '@auth/platform/error-handling';
import { PermissionSlug } from '../../domain/value-objects/permission-slug.vo';
import { RoleName } from '../../domain/value-objects/role-name.vo';
import { Role } from '../../domain/role.aggregate';
import {
  ROLE_REPOSITORY,
  type RoleRepositoryPort,
} from '../../domain/ports/role-repository.port';
import { CreateRoleCommand } from './role.command';

/**
 * The single write path for role creation.
 *
 * @remarks Commands are the only place mutations happen, so authorisation, auditing and
 * event publication have exactly one hook rather than one per entry point.
 */
@Injectable()
@CommandHandler(CreateRoleCommand)
export class CreateRoleHandler
  implements ICommandHandler<CreateRoleCommand, string>
{
  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepositoryPort,
  ) {}

  async execute(command: CreateRoleCommand): Promise<string> {
    const name = RoleName.create(command.name);
    if (name.isFailure) {
      // A malformed name is the caller's mistake, so it is a 400 and not a 500.
      throw new ValidationException('role name is not valid', {
        name: String(command.name).slice(0, 64),
      });
    }

    // `Result` narrows only through its methods, not through the `isFailure` getter, so the
    // value is unwrapped explicitly once the failure branch has returned.
    const roleName = name.unwrapOrThrow();

    // Every slug is validated before the role is built: a role that declares a permission
    // nobody can spell is a permission that silently never matches at the evaluator.
    const permissions: PermissionSlug[] = [];
    for (const raw of command.permissions ?? []) {
      const slug = PermissionSlug.create(raw);
      if (slug.isFailure) {
        throw new ValidationException('permission is not a valid slug', {
          permission: String(raw).slice(0, 64),
          expected: 'resource:action',
        });
      }
      permissions.push(slug.unwrapOrThrow());
    }

    // Checked before the insert so the common case returns a clean 409, rather than relying
    // on the primary key to surface a driver-level error code.
    if (await this.roles.existsByName(roleName.value)) {
      throw new ResourceAlreadyExistsException('a role with this name already exists', {
        role: roleName.value,
      });
    }

    const role = Role.create({
      name: roleName,
      permissions: permissions.map((permission) => permission.value),
      description: command.description,
      isSystem: command.isSystem,
    });

    // The repository writes the role and its `role.created` event in one transaction.
    await this.roles.save(role);

    return role.id;
  }
}