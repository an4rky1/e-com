/**
 * @fileoverview Commands for ABAC policy rules.
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
import { Policy } from '../../domain/policy.aggregate';
import { PermissionSlug } from '../../domain/value-objects/permission-slug.vo';
import { type PolicyEffect, isPolicyEffect } from '../../domain/value-objects/policy-effect.vo';
import { RoleName } from '../../domain/value-objects/role-name.vo';
import type { PolicyCondition } from '../../domain/value-objects/policy-condition.vo';
import {
  POLICY_REPOSITORY,
  type PolicyRepositoryPort,
} from '../../domain/ports/policy-repository.port';
import {
  ROLE_REPOSITORY,
  type RoleRepositoryPort,
} from '../../domain/ports/role-repository.port';

export class CreatePolicyCommand extends Command<string> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly role: string,
    readonly permission: string,
    readonly effect: PolicyEffect,
    readonly conditions?: readonly PolicyCondition[],
    readonly priority?: number,
    readonly resourceType?: string,
    readonly description?: string,
  ) {
    super();
  }
}

@Injectable()
@CommandHandler(CreatePolicyCommand)
export class CreatePolicyHandler
  implements ICommandHandler<CreatePolicyCommand, string>
{
  constructor(
    @Inject(POLICY_REPOSITORY) private readonly policies: PolicyRepositoryPort,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepositoryPort,
  ) {}

  async execute(command: CreatePolicyCommand): Promise<string> {
    // A policy whose role does not exist would be rejected by the foreign key at insert
    // time, as a driver error. Checking first turns that into a 404 the caller can act on.
    const role = await this.roles.findByName(command.role);
    if (!role) {
      throw new ResourceNotFoundException('role not found', {
        role: command.role,
      });
    }

    const slug = PermissionSlug.create(command.permission);
    if (slug.isFailure) {
      throw new ValidationException('permission is not a valid slug', {
        permission: String(command.permission).slice(0, 64),
        expected: 'resource:action',
      });
    }

    // An unrecognised effect is never guessed at: defaulting either way would write a rule
    // that does not mean what the operator wrote.
    if (!isPolicyEffect(command.effect)) {
      throw new ValidationException('policy effect must be allow or deny', {
        effect: String(command.effect),
      });
    }

    const policy = Policy.create({
      role: RoleName.fromTrusted(role.id),
      permission: slug.unwrapOrThrow(),
      effect: command.effect,
      conditions: command.conditions,
      priority: command.priority,
      resourceType: command.resourceType ?? null,
      description: command.description,
    });

    await this.policies.save(policy);

    return policy.id;
  }
}

export class DeletePolicyCommand extends Command<void> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly policyId: string,
    readonly reason?: string,
  ) {
    super();
  }
}

@Injectable()
@CommandHandler(DeletePolicyCommand)
export class DeletePolicyHandler
  implements ICommandHandler<DeletePolicyCommand, void>
{
  constructor(
    @Inject(POLICY_REPOSITORY) private readonly policies: PolicyRepositoryPort,
  ) {}

  /**
   * Deletes one rule.
   *
   * @remarks Only the named rule is removed, never "the deny rules of this role". A bulk
   * delete that silently takes the exceptions along with the permits is how an emergency
   * revocation of one account ends up unlocking the resource for everybody else.
   */
  async execute(command: DeletePolicyCommand): Promise<void> {
    const policy = await this.policies.findById(command.policyId);
    if (!policy) {
      throw new ResourceNotFoundException('policy not found', {
        policyId: command.policyId,
      });
    }

    policy.remove(command.reason ?? null);
    await this.policies.delete(policy);
  }
}