/**
 * @fileoverview Read side: what a user may do, and what roles exist.
 *
 * @remarks One read model serves both the REST surface and the gRPC `GetPermissions` call,
 * because both answer the same question and two shapes would drift. The policies travel with
 * it so the caller can run a context-dependent decision locally without a second round trip.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Query, QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import {
  PermissionEvaluator,
  type EvaluablePolicy,
  type EvaluableRole,
} from '../../domain/permission-evaluator';
import type { Policy } from '../../domain/policy.aggregate';
import type { Role } from '../../domain/role.aggregate';
import type { RoleAssignment } from '../../domain/role-assignment.aggregate';
import {
  ROLE_ASSIGNMENT_REPOSITORY,
  type RoleAssignmentRepositoryPort,
} from '../../domain/ports/role-assignment-repository.port';
import {
  POLICY_REPOSITORY,
  type PolicyRepositoryPort,
} from '../../domain/ports/policy-repository.port';
import {
  ROLE_REPOSITORY,
  type RoleRepositoryPort,
} from '../../domain/ports/role-repository.port';

// ---- read models ----------------------------------------------------------------

export interface UserPermissionsReadModel {
  userId: string;
  roles: EvaluableRole[];
  /** Union of every held role's permissions, sorted. Never includes ABAC implications. */
  permissions: string[];
  policies: EvaluablePolicy[];
}

export interface RoleReadModel {
  name: string;
  permissions: string[];
  description: string | null;
  isSystem: boolean;
  policyCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PagedRoles {
  data: RoleReadModel[];
  total: number;
  page: number;
  limit: number;
}

export const toRoleReadModel = (
  role: Role,
  policyCount = 0,
): RoleReadModel => ({
  name: role.id,
  permissions: role.permissions.map((permission) => permission.value),
  description: role.description,
  isSystem: role.isSystem,
  policyCount,
  createdAt: role.createdAt,
  updatedAt: role.updatedAt,
});

export const toEvaluablePolicy = (policy: Policy): EvaluablePolicy => ({
  id: policy.id,
  role: policy.role.value,
  permission: policy.permission.value,
  effect: policy.effect,
  conditions: policy.conditions,
  priority: policy.priority,
  resourceType: policy.resourceType,
});

export const toEvaluableRole = (role: Role): EvaluableRole => ({
  name: role.id,
  permissions: role.permissions.map((permission) => permission.value),
});

/** Role names are lower-cased on the way in, so a duplicate set cannot differ by casing. */
const roleNameOf = (assignment: RoleAssignment): string => assignment.role.value;

// ---- queries -------------------------------------------------------------------

export class GetUserPermissionsQuery extends Query<UserPermissionsReadModel> {
  readonly queryId: string = crypto.randomUUID();

  constructor(readonly userId: string) {
    super();
  }
}

/**
 * Everything needed to answer "what may this user do?".
 *
 * @remarks Expired and revoked assignments are excluded by the repository, so a revoked role
 * disappears from the answer without any cleanup job having to run first.
 */
@Injectable()
@QueryHandler(GetUserPermissionsQuery)
export class GetUserPermissionsHandler
  implements IQueryHandler<GetUserPermissionsQuery, UserPermissionsReadModel>
{
  constructor(
    @Inject(ROLE_ASSIGNMENT_REPOSITORY)
    private readonly assignments: RoleAssignmentRepositoryPort,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepositoryPort,
    @Inject(POLICY_REPOSITORY) private readonly policies: PolicyRepositoryPort,
  ) {}

  async execute(query: GetUserPermissionsQuery): Promise<UserPermissionsReadModel> {
    const assignments = await this.assignments.findActiveByUser(query.userId);
    const names = [...new Set(assignments.map(roleNameOf))].sort();

    // A user with no roles is a valid answer, not a 404: "no access" is the honest response
    // for someone who has just been deprovisioned everywhere.
    if (names.length === 0) {
      return { userId: query.userId, roles: [], permissions: [], policies: [] };
    }

    const [roles, policies] = await Promise.all([
      this.roles.findByNames(names),
      this.policies.findByRoles(names),
    ]);

    const evaluableRoles = roles.map(toEvaluableRole);

    return {
      userId: query.userId,
      roles: evaluableRoles,
      permissions: PermissionEvaluator.effectivePermissions(evaluableRoles),
      policies: policies.map(toEvaluablePolicy),
    };
  }
}

export class ListRolesQuery extends Query<PagedRoles> {
  readonly queryId: string = crypto.randomUUID();

  constructor(
    /** Only roles whose name contains this fragment; case-insensitive. */
    readonly search?: string,
    readonly includeSystem?: boolean,
    readonly page?: number,
    readonly limit?: number,
  ) {
    super();
  }
}

@Injectable()
@QueryHandler(ListRolesQuery)
export class ListRolesHandler
  implements IQueryHandler<ListRolesQuery, PagedRoles>
{
  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepositoryPort,
    @Inject(POLICY_REPOSITORY) private readonly policies: PolicyRepositoryPort,
  ) {}

  async execute(query: ListRolesQuery): Promise<PagedRoles> {
    const [all, policies] = await Promise.all([
      this.roles.findAll(),
      this.policies.findAll(),
    ]);

    const counts = new Map<string, number>();
    for (const policy of policies) {
      counts.set(policy.role.value, (counts.get(policy.role.value) ?? 0) + 1);
    }

    const search = query.search?.trim().toLowerCase();
    const filtered = all.filter((role) => {
      // System roles are hidden by default: an operator browsing "roles" is looking for the
      // ones they can change, and the seeded ones are not.
      if (query.includeSystem === false && role.isSystem) return false;
      if (!search) return true;
      return (
        role.id.includes(search) ||
        role.permissions.some((permission) => permission.value.includes(search))
      );
    });

    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const offset = (page - 1) * limit;

    return {
      data: filtered
        .slice(offset, offset + limit)
        .map((role) => toRoleReadModel(role, counts.get(role.id) ?? 0)),
      total: filtered.length,
      page,
      limit,
    };
  }
}