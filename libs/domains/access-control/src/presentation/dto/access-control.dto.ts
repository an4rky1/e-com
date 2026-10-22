import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { PolicyCondition } from '../../domain/value-objects/policy-condition.vo';
import { PolicyEffect } from '../../domain/value-objects/policy-effect.vo';
import { PERMISSION_SLUG_PATTERN } from '../../domain/value-objects/permission-slug.vo';
import { ROLE_NAME_PATTERN } from '../../domain/value-objects/role-name.vo';
import { RESOURCE_TYPE_ATTRIBUTE } from '../../domain/value-objects/policy-condition.vo';
import type {
  PagedRoles,
  RoleReadModel,
  UserPermissionsReadModel,
} from '../../application/queries/access-control.queries';

export class CreateRoleRequestDto {
  @IsString()
  @Matches(ROLE_NAME_PATTERN, { message: 'name must be lower_snake_case' })
  @MaxLength(64)
  name!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @Matches(PERMISSION_SLUG_PATTERN, { each: true, message: 'must be resource:action' })
  permissions?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class GrantRoleRequestDto {
  @IsString()
  @Matches(ROLE_NAME_PATTERN, { message: 'role must be lower_snake_case' })
  role!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  grantedBy?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsBoolean()
  temporary?: boolean;
}

export class RevokeRoleRequestDto {
  @IsString()
  @Matches(ROLE_NAME_PATTERN, { message: 'role must be lower_snake_case' })
  role!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class PolicyConditionDto implements PolicyCondition {
  @IsString()
  @MaxLength(64)
  attribute!: string;

  @IsIn(['equals', 'not_equals', 'in', 'contains'])
  operator!: PolicyCondition['operator'];

  value!: string | string[];
}

export class CreatePolicyRequestDto {
  @IsString()
  @Matches(ROLE_NAME_PATTERN, { message: 'role must be lower_snake_case' })
  role!: string;

  @IsString()
  @Matches(PERMISSION_SLUG_PATTERN, { message: 'permission must be resource:action' })
  permission!: string;

  @IsIn([PolicyEffect.ALLOW, PolicyEffect.DENY])
  effect!: PolicyEffect;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  conditions?: PolicyConditionDto[];

  @IsOptional()
  @IsInt()
  @Min(-1_000)
  @Max(1_000)
  priority?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  resourceType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class ListRolesQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;

  @IsOptional()
  @IsString()
  includeSystem?: string;

  @IsOptional()
  @IsString()
  page?: string;

  @IsOptional()
  @IsString()
  limit?: string;
}

/**
 * Transport shape of a role.
 *
 * @remarks Built by a pure mapper rather than serialising the aggregate. The aggregate is a
 * domain object with invariants and a domain-event buffer; handing it to a response serialiser
 * is how internal fields end up on the wire and later become de facto API.
 */
export class RoleResponseDto {
  name!: string;
  permissions!: string[];
  description!: string | null;
  isSystem!: boolean;
  policyCount!: number;
  createdAt!: Date;
  updatedAt!: Date;

  static from(role: RoleReadModel): RoleResponseDto {
    return toRoleResponse(role);
  }
}

export function toRoleResponse(role: RoleReadModel): RoleResponseDto {
  return {
    name: role.name,
    permissions: role.permissions,
    description: role.description,
    isSystem: role.isSystem,
    policyCount: role.policyCount,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}

export class UserPermissionsResponseDto {
  userId!: string;
  roles!: string[];
  permissions!: string[];

  static from(model: UserPermissionsReadModel): UserPermissionsResponseDto {
    return toUserPermissionsResponse(model);
  }
}

export function toUserPermissionsResponse(
  model: UserPermissionsReadModel,
): UserPermissionsResponseDto {
  return {
    userId: model.userId,
    roles: model.roles.map((role) => role.name),
    permissions: model.permissions,
  };
}

export class PermissionDecisionResponseDto {
  allowed!: boolean;

  /**
   * Operator-facing explanation.
   *
   * @remarks Never rendered to the user who was refused: it names the policy that stopped
   * them, which is a map of exactly what to change.
   */
  reason!: string;
}

export class PagedRolesResponseDto {
  data!: RoleResponseDto[];
  total!: number;
  page!: number;
  limit!: number;

  static from(paged: PagedRoles): PagedRolesResponseDto {
    return {
      data: paged.data.map(toRoleResponse),
      total: paged.total,
      page: paged.page,
      limit: paged.limit,
    };
  }
}

/** Used by the controller to turn request attributes into an ABAC context. */
export const attributesContextFrom = (
  request: unknown,
): Record<string, string> => {
  if (typeof request !== 'object' || request === null) return {};
  const attributes = (request as { attributes?: unknown }).attributes;
  return typeof attributes === 'object' && attributes !== null
    ? (attributes as Record<string, string>)
    : {};
};

export { RESOURCE_TYPE_ATTRIBUTE };
