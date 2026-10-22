/**
 * @fileoverview Commands that move a role between a user and nobody.
 *
 * @remarks Both live in one file because they are the two halves of one transition and both
 * answer to the same aggregate: a grant is the absence of a revocation, and splitting them
 * across files is how one of them ends up forgetting to emit its event.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  Command,
  CommandHandler,
  type ICommandHandler,
} from '@nestjs/cqrs';
import {
  ResourceNotFoundException,
  ValidationException,
} from '@auth/platform/error-handling';
import { RoleAssignment } from '../../domain/role-assignment.aggregate';
import { RoleName } from '../../domain/value-objects/role-name.vo';
import {
  ROLE_ASSIGNMENT_REPOSITORY,
  type RoleAssignmentRepositoryPort,
} from '../../domain/ports/role-assignment-repository.port';
import {
  ROLE_REPOSITORY,
  type RoleRepositoryPort,
} from '../../domain/ports/role-repository.port';

export class GrantRoleToUserCommand extends Command<string | null> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly userId: string,
    readonly role: string,
    readonly grantedBy?: string,
    readonly expiresAt?: Date | null,
    readonly reason?: string,
  ) {
    super();
  }
}

@Injectable()
@CommandHandler(GrantRoleToUserCommand)
export class GrantRoleToUserHandler
  implements ICommandHandler<GrantRoleToUserCommand, string | null>
{
  constructor(
    @Inject(ROLE_ASSIGNMENT_REPOSITORY)
    private readonly assignments: RoleAssignmentRepositoryPort,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepositoryPort,
  ) {}

  /**
   * Returns the assignment id, or `null` when the user already holds the role.
   *
   * @remarks `null` rather than a throw, because the command is idempotent by design: a
   * retried HTTP request or a redelivered Kafka message must not create a second row or a
   * second `role.granted` fact. The caller learns that nothing changed, which is enough to
   * make the retry safe.
   */
  async execute(command: GrantRoleToUserCommand): Promise<string | null> {
    // The role is resolved first: granting a role that does not exist would write a row
    // pointing at a name no `roles` row matches, and the FK would turn that into a 500
    // instead of a 404.
    const role = await this.roles.findByName(command.role);
    if (!role) {
      throw new ResourceNotFoundException('role not found', {
        role: command.role,
      });
    }

    const existing = await this.assignments.findActiveByUserAndRole(
      command.userId,
      role.id,
    );
    if (existing) return null;

    const assignment = RoleAssignment.grant({
      userId: command.userId,
      role: RoleName.fromTrusted(role.id),
      grantedBy: command.grantedBy ?? null,
      expiresAt: command.expiresAt ?? null,
      reason: command.reason ?? null,
    });

    // The repository writes the assignment and its `role.granted` event in one transaction.
    await this.assignments.save(assignment);

    return assignment.id;
  }
}

export class RevokeRoleFromUserCommand extends Command<void> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly userId: string,
    readonly role: string,
    readonly reason?: string,
  ) {
    super();
  }
}

@Injectable()
@CommandHandler(RevokeRoleFromUserCommand)
export class RevokeRoleFromUserHandler
  implements ICommandHandler<RevokeRoleFromUserCommand, void>
{
  constructor(
    @Inject(ROLE_ASSIGNMENT_REPOSITORY)
    private readonly assignments: RoleAssignmentRepositoryPort,
  ) {}

  async execute(command: RevokeRoleFromUserCommand): Promise<void> {
    // Normalised through the value object rather than trimmed inline, so "Admin" finds the
    // "admin" row instead of 404-ing on a casing difference.
    const roleName = RoleName.create(command.role);
    if (roleName.isFailure) {
      throw new ValidationException('role name is not valid', {
        role: String(command.role).slice(0, 64),
      });
    }

    const assignment = await this.assignments.findActiveByUserAndRole(
      command.userId,
      roleName.unwrapOrThrow().value,
    );

    if (!assignment) {
      throw new ResourceNotFoundException('the user does not hold this role', {
        userId: command.userId,
        role: command.role,
      });
    }

    assignment.revoke(command.reason ?? null);
    await this.assignments.save(assignment);
  }
}