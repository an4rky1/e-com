import { Injectable } from '@nestjs/common';
// Value import, not `import type`: these are constructor-injected, and
// `emitDecoratorMetadata` reads the emitted value binding to resolve them.
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { type PermissionDeniedPayload } from '@auth/contracts';
import type { PolicyEffect } from '../../domain/value-objects/policy-effect.vo';
import type { PolicyCondition } from '../../domain/value-objects/policy-condition.vo';
import {
  PermissionEvaluator,
  type PermissionDecision,
} from '../../domain/permission-evaluator';
import {
  GetUserPermissionsQuery,
  ListRolesQuery,
  type PagedRoles,
  type UserPermissionsReadModel,
} from '../queries/access-control.queries';
import { CreateRoleCommand, toCreateRoleCommand } from '../commands/role.command';
import {
  CreatePolicyCommand,
  DeletePolicyCommand,
} from '../commands/policy.commands';
import {
  GrantRoleToUserCommand,
  RevokeRoleFromUserCommand,
} from '../commands/role-assignment.commands';

/** Narrow port for callers that only need a decision — the guard and the gRPC controller. */
export interface PermissionChecker {
  checkPermission(input: {
    userId: string;
    permission: string;
    context?: Record<string, string>;
  }): Promise<PermissionDecision>;
}

/** A permission the request was refused for, shaped for an audit record. */
export type DeniedPermissionReport = PermissionDeniedPayload;

/**
 * The only public surface of the access-control module.
 *
 * @remarks Controllers, gRPC handlers and the api-gateway's guard depend on this class and
 * nothing else. They therefore cannot reach the repository, the CQRS bus or the aggregates —
 * which is what makes the module's internals replaceable without touching a single caller.
 *
 * @remarks The service answers one question: "what may this user do?". It never
 * authenticates. A 401 is somebody else's answer, produced by identity or the session
 * engine, and a service that answered both would have two opinions about who the caller is.
 */
@Injectable()
export class AccessControlService implements PermissionChecker {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  createRole(input: {
    name: string;
    permissions?: string[];
    description?: string;
  }): Promise<string> {
    // No explicit type argument: the command carries `Command<string>`, so the bus reads the
    // result type off the instance instead of falling back to `any`.
    return this.commandBus.execute(toCreateRoleCommand(input));
  }

  /** Returns the assignment id, or `null` when the user already held the role. */
  grantRoleToUser(input: {
    userId: string;
    role: string;
    grantedBy?: string;
    expiresAt?: Date | null;
    reason?: string;
  }): Promise<string | null> {
    return this.commandBus.execute(
      new GrantRoleToUserCommand(
        input.userId,
        input.role,
        input.grantedBy,
        input.expiresAt,
        input.reason,
      ),
    );
  }

  revokeRoleFromUser(input: {
    userId: string;
    role: string;
    reason?: string;
  }): Promise<void> {
    return this.commandBus.execute(
      new RevokeRoleFromUserCommand(input.userId, input.role, input.reason),
    );
  }

  createPolicy(input: {
    role: string;
    permission: string;
    effect: PolicyEffect;
    conditions?: PolicyCondition[];
    priority?: number;
    resourceType?: string;
    description?: string;
  }): Promise<string> {
    return this.commandBus.execute(
      new CreatePolicyCommand(
        input.role,
        input.permission,
        input.effect,
        input.conditions,
        input.priority,
        input.resourceType,
        input.description,
      ),
    );
  }

  deletePolicy(input: { policyId: string; reason?: string }): Promise<void> {
    return this.commandBus.execute(
      new DeletePolicyCommand(input.policyId, input.reason),
    );
  }

  getUserPermissions(userId: string): Promise<UserPermissionsReadModel> {
    return this.queryBus.execute(new GetUserPermissionsQuery(userId));
  }

  listRoles(input: {
    search?: string;
    includeSystem?: boolean;
    page?: number;
    limit?: number;
  }): Promise<PagedRoles> {
    return this.queryBus.execute(
      new ListRolesQuery(input.search, input.includeSystem, input.page, input.limit),
    );
  }

  /**
   * Answers "may this user do this?".
   *
   * @remarks The decision is computed by the pure {@link PermissionEvaluator} from one read
   * model rather than by a second round trip per policy: a check runs on every request, and a
   * decision that costs N queries under load is a decision that eventually times out and
   * fails *closed* into an outage.
   */
  async checkPermission(input: {
    userId: string;
    permission: string;
    context?: Record<string, string>;
  }): Promise<PermissionDecision> {
    const permissions = await this.getUserPermissions(input.userId);

    return PermissionEvaluator.evaluate({
      userId: input.userId,
      permission: input.permission,
      context: input.context,
      roles: permissions.roles,
      policies: permissions.policies,
    });
  }

  /**
   * Describes a denial in the shape an audit record expects.
   *
   * @remarks Built here rather than thrown from the evaluator so the domain stays free of
   * transport concerns: the decision is a value, and turning it into a message is the
   * application's job. The `reason` is deliberately the evaluator's operator-facing text and
   * must not be surfaced to the caller who was refused.
   */
  deniedReport(input: {
    userId: string;
    permission: string;
    decision: PermissionDecision;
    resource?: string;
    ipAddress?: string;
  }): DeniedPermissionReport {
    return {
      userId: input.userId,
      permission: input.permission,
      resource: input.resource,
      reason: input.decision.reason,
      ipAddress: input.ipAddress,
    };
  }
}

export {
  CreateRoleCommand,
  CreatePolicyCommand,
  DeletePolicyCommand,
  GrantRoleToUserCommand,
  RevokeRoleFromUserCommand,
  GetUserPermissionsQuery,
  ListRolesQuery,
};
export type { PagedRoles, UserPermissionsReadModel };
